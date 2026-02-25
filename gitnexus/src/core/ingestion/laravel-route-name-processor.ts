import Parser from 'tree-sitter';
import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable } from './symbol-table.js';
import { ImportMap } from './import-processor.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, getParseableContent, yieldToEventLoop } from './utils.js';
import {
  ROUTE_FILE_PATH_RE,
  extractLaravelRouteTargetsFromSnippet,
  resolveController,
} from './laravel-route-processor.js';

type ResolvedNamedRouteTarget = {
  methodNodeId: string;
  confidence: number;
  reason: string;
};

type ExtractedRouteNameCall = {
  callNode: any;
  routeName: string;
};

type JsRouteNameCall = {
  filePath: string;
  callNode: any;
  routeName: string;
};

const ROUTE_VERB_RE = '(?:get|post|put|patch|delete|options|any)';
const ROUTE_VERB_CALL_RE = new RegExp(
  String.raw`(?:Route::|->)\s*${ROUTE_VERB_RE}\s*\(`,
  'g'
);

const ROUTE_NAME_RE = /->\s*(?:name|as)\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

const BLADE_ROUTE_CALL_RE = /\b(?:route|to_route)\s*\(\s*['"]([^'"]+)['"]/g;

const LARAVEL_ROUTE_NAME_QUERY = `
; route('users.index') / to_route('users.index')
(function_call_expression
  function: (name) @route.fn
  arguments: (arguments (argument (string (string_content) @route.name)))
) @route.call

; redirect()->route('users.index')
(member_call_expression
  name: (name) @route.method
  arguments: (arguments (argument (string (string_content) @route.name)))
) @route.call

; URL::route('users.index')
(scoped_call_expression
  scope: (_) @route.scope
  name: (name) @route.method
  arguments: (arguments (argument (string (string_content) @route.name)))
) @route.call
`;

const sliceToStatementEnd = (content: string, startIndex: number): string => {
  const maxEnd = Math.min(content.length, startIndex + 12_000);
  const semi = content.indexOf(';', startIndex);
  if (semi !== -1 && semi < maxEnd) return content.slice(startIndex, semi + 1);
  return content.slice(startIndex, maxEnd);
};

const extractLastRouteName = (statement: string): string | null => {
  let last: string | null = null;
  for (const match of statement.matchAll(ROUTE_NAME_RE)) {
    const name = match[2]?.trim();
    if (!name) continue;
    last = name;
  }
  return last;
};

const buildLaravelNamedRouteIndex = (
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  importMap: ImportMap,
): Map<string, ResolvedNamedRouteTarget[]> => {
  const index = new Map<string, ResolvedNamedRouteTarget[]>();

  for (const file of files) {
    if (!ROUTE_FILE_PATH_RE.test(file.path)) continue;

    for (const match of file.content.matchAll(ROUTE_VERB_CALL_RE)) {
      const startIndex = match.index;
      if (startIndex === undefined) continue;

      const statement = sliceToStatementEnd(file.content, startIndex);
      if (!/->\s*(?:name|as)\s*\(/.test(statement)) continue;

      const routeName = extractLastRouteName(statement);
      if (!routeName) continue;

      const targets = extractLaravelRouteTargetsFromSnippet(statement);
      if (targets.length !== 1) continue;

      const target = targets[0];
      const resolvedController = resolveController(target.controllerClass, file.path, symbolTable, importMap);
      if (!resolvedController) continue;

      const methodNodeId = symbolTable.lookupExact(resolvedController.filePath, target.controllerMethod);
      if (!methodNodeId) continue;

      let list = index.get(routeName);
      if (!list) {
        list = [];
        index.set(routeName, list);
      }
      list.push({
        methodNodeId,
        confidence: resolvedController.confidence,
        reason: resolvedController.reason,
      });
    }
  }

  return index;
};

const extractBladeRouteNames = (content: string): string[] => {
  const names: string[] = [];
  for (const match of content.matchAll(BLADE_ROUTE_CALL_RE)) {
    const name = match[1]?.trim();
    if (!name) continue;
    names.push(name);
  }
  return Array.from(new Set(names));
};

const parseLaravelRouteNameCallFromMatch = (captureMap: Record<string, any>): ExtractedRouteNameCall | null => {
  const callNode = captureMap['route.call'];
  const nameNode = captureMap['route.name'];
  if (!callNode || !nameNode) return null;

  const routeName = nameNode.text?.trim();
  if (!routeName) return null;

  const fnNode = captureMap['route.fn'];
  if (fnNode) {
    const fnName = fnNode.text?.trim();
    if (fnName === 'route' || fnName === 'to_route') return { callNode, routeName };
    return null;
  }

  const methodNode = captureMap['route.method'];
  const methodName = methodNode?.text?.trim();
  if (methodName === 'route') return { callNode, routeName };

  return null;
};

const findEnclosingPhpCallableId = (
  node: any,
  filePath: string,
  symbolTable: SymbolTable
): string => {
  let current = node.parent;

  while (current) {
    if (current.type === 'method_declaration') {
      const nameNode = current.childForFieldName?.('name');
      const name = nameNode?.text;
      if (name) {
        return symbolTable.lookupExact(filePath, name) || generateId('Method', `${filePath}:${name}`);
      }
    }
    if (current.type === 'function_definition') {
      const nameNode = current.childForFieldName?.('name');
      const name = nameNode?.text;
      if (name) {
        return symbolTable.lookupExact(filePath, name) || generateId('Function', `${filePath}:${name}`);
      }
    }
    current = current.parent;
  }

  return generateId('File', filePath);
};

const stripQuotes = (value: string): string => {
  if (value.length < 2) return value;
  const start = value[0];
  const end = value[value.length - 1];
  if ((start === '"' && end === '"') || (start === '\'' && end === '\'')) {
    return value.slice(1, -1);
  }
  return value;
};

const parseStringLikeLiteral = (node: any): string | null => {
  if (!node) return null;
  const text = String(node.text || '');
  if (text.length === 0) return null;

  if (node.type === 'string') return stripQuotes(text);

  if (node.type === 'template_string') {
    if (text.includes('${')) return null;
    if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1);
    return text;
  }

  return null;
};

// Node types that represent function/method definitions across languages.
const FUNCTION_NODE_TYPES = new Set([
  // TypeScript/JavaScript
  'function_declaration',
  'arrow_function',
  'function_expression',
  'method_definition',
  'generator_function_declaration',
  // Python
  'function_definition',
  // Common async variants
  'async_function_declaration',
  'async_arrow_function',
  // Java
  'method_declaration',
  'constructor_declaration',
  // C#
  'local_function_statement',
  // Rust
  'function_item',
  'impl_item',
]);

const findEnclosingCallableId = (node: any, filePath: string, symbolTable: SymbolTable): string | null => {
  let current = node.parent;

  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      let funcName: string | null = null;
      let label = 'Function';

      if (current.type === 'function_declaration' ||
          current.type === 'function_definition' ||
          current.type === 'async_function_declaration' ||
          current.type === 'generator_function_declaration' ||
          current.type === 'function_item') {
        const nameNode = current.childForFieldName?.('name')
          || current.children?.find((c: any) => c.type === 'identifier' || c.type === 'property_identifier');
        funcName = nameNode?.text;
      } else if (current.type === 'impl_item') {
        const funcItem = current.children?.find((c: any) => c.type === 'function_item');
        if (funcItem) {
          const nameNode = funcItem.childForFieldName?.('name')
            || funcItem.children?.find((c: any) => c.type === 'identifier');
          funcName = nameNode?.text;
          label = 'Method';
        }
      } else if (current.type === 'method_definition') {
        const nameNode = current.childForFieldName?.('name')
          || current.children?.find((c: any) => c.type === 'property_identifier');
        funcName = nameNode?.text;
        label = 'Method';
      } else if (current.type === 'method_declaration' || current.type === 'constructor_declaration') {
        const nameNode = current.childForFieldName?.('name')
          || current.children?.find((c: any) => c.type === 'identifier');
        funcName = nameNode?.text;
        label = 'Method';
      } else if (current.type === 'arrow_function' || current.type === 'function_expression') {
        const parent = current.parent;
        if (parent?.type === 'variable_declarator') {
          const nameNode = parent.childForFieldName?.('name')
            || parent.children?.find((c: any) => c.type === 'identifier');
          funcName = nameNode?.text;
        }
      }

      if (funcName) {
        const nodeId = symbolTable.lookupExact(filePath, funcName);
        if (nodeId) return nodeId;
        return generateId(label, `${filePath}:${funcName}`);
      }
    }
    current = current.parent;
  }

  return null;
};

const extractJsRouteNameCallsFromTree = (filePath: string, tree: Parser.Tree): JsRouteNameCall[] => {
  const calls: JsRouteNameCall[] = [];

  const visit = (node: any) => {
    if (!node) return;

    if (node.type === 'call_expression') {
      const fnNode = node.childForFieldName?.('function');
      const argsNode = node.childForFieldName?.('arguments');
      const args = argsNode?.namedChildren || [];

      if (fnNode?.type === 'identifier' && fnNode.text === 'route' && args.length >= 1) {
        const name = parseStringLikeLiteral(args[0]);
        const routeName = name?.trim();
        if (routeName) {
          calls.push({ filePath, callNode: node, routeName });
        }
      }
    }

    for (const child of node.namedChildren || []) {
      visit(child);
    }
  };

  visit(tree.rootNode);
  return calls;
};

const isBladeTemplateFile = (filePath: string): boolean => {
  if (!filePath.endsWith('.blade.php')) return false;
  return filePath.startsWith('resources/views/')
    || filePath.includes('/resources/views/');
};

const isRouteHelperRelevantFile = (filePath: string, content: string): boolean => {
  if (isBladeTemplateFile(filePath)) return /\b(?:route|to_route)\s*\(/.test(content);

  const lang = getLanguageFromFilename(filePath);
  if (lang === SupportedLanguages.PHP) return /\b(?:route|to_route)\s*\(/.test(content) || /->\s*route\s*\(/.test(content);
  if (lang === SupportedLanguages.TypeScript || lang === SupportedLanguages.JavaScript) return /\broute\s*\(/.test(content);
  return false;
};

export const processLaravelRouteNameWiring = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
): Promise<{ edgesAdded: number }> => {
  const routeNameIndex = buildLaravelNamedRouteIndex(files, symbolTable, importMap);
  if (routeNameIndex.size === 0) return { edgesAdded: 0 };

  let edgesAdded = 0;

  // 1) Blade templates: route('name') → controller method
  for (const file of files) {
    if (!isBladeTemplateFile(file.path)) continue;
    if (!isRouteHelperRelevantFile(file.path, file.content)) continue;

    const templateId = generateId('Template', file.path);
    const routeNames = extractBladeRouteNames(file.content);
    if (routeNames.length === 0) continue;

    for (const routeName of routeNames) {
      const matches = routeNameIndex.get(routeName) || [];
      if (matches.length !== 1) continue;

      const target = matches[0];
      const reason = `route-name:${routeName}:${target.reason}`;
      const relId = generateId('CALLS', `${templateId}:${reason}->${target.methodNodeId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId: templateId,
        targetId: target.methodNodeId,
        confidence: target.confidence,
        reason,
      });
      edgesAdded++;
    }
  }

  const parser = await loadParser();

  // 2) PHP: route('name') / redirect()->route('name') → controller method
  await loadLanguage(SupportedLanguages.PHP);
  const language = parser.getLanguage();
  const routeQuery = new Parser.Query(language, LARAVEL_ROUTE_NAME_QUERY);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 200 === 0) await yieldToEventLoop();

    const lang = getLanguageFromFilename(file.path);
    if (lang !== SupportedLanguages.PHP) continue;
    if (!isRouteHelperRelevantFile(file.path, file.content)) continue;

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: 1024 * 256 });
        astCache.set(file.path, tree);
      } catch {
        continue;
      }
    }

    let matches: any[] = [];
    try {
      matches = routeQuery.matches(tree.rootNode);
    } catch {
      continue;
    }

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      for (const c of match.captures) captureMap[c.name] = c.node;

      const parsed = parseLaravelRouteNameCallFromMatch(captureMap);
      if (!parsed) continue;

      const targets = routeNameIndex.get(parsed.routeName) || [];
      if (targets.length !== 1) continue;

      const target = targets[0];
      const reason = `route-name:${parsed.routeName}:${target.reason}`;
      const sourceId = findEnclosingPhpCallableId(parsed.callNode, file.path, symbolTable);
      const relId = generateId('CALLS', `${sourceId}:${reason}->${target.methodNodeId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId,
        targetId: target.methodNodeId,
        confidence: target.confidence,
        reason,
      });
      edgesAdded++;
    }
  }

  // 3) JS/TS (incl. Svelte <script>): route('name') → controller method
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 400 === 0) await yieldToEventLoop();

    const lang = getLanguageFromFilename(file.path);
    if (lang !== SupportedLanguages.TypeScript && lang !== SupportedLanguages.JavaScript) continue;
    if (!isRouteHelperRelevantFile(file.path, file.content)) continue;

    await loadLanguage(lang, file.path);

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        const content = getParseableContent(file.path, file.content);
        tree = parser.parse(content, undefined, { bufferSize: 1024 * 256 });
        astCache.set(file.path, tree);
      } catch {
        continue;
      }
    }

    const calls = extractJsRouteNameCallsFromTree(file.path, tree);
    if (calls.length === 0) continue;

    for (const call of calls) {
      const targets = routeNameIndex.get(call.routeName) || [];
      if (targets.length !== 1) continue;

      const target = targets[0];
      const reason = `route-name:${call.routeName}:${target.reason}`;
      const sourceId = findEnclosingCallableId(call.callNode, call.filePath, symbolTable)
        || generateId('File', call.filePath);

      const relId = generateId('CALLS', `${sourceId}:${reason}->${target.methodNodeId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId,
        targetId: target.methodNodeId,
        confidence: target.confidence,
        reason,
      });
      edgesAdded++;
    }
  }

  return { edgesAdded };
};

