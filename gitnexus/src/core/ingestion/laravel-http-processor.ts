import Parser from 'tree-sitter';
import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable } from './symbol-table.js';
import { ImportMap, PhpUseAliasMap } from './import-processor.js';
import { loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, getParseableContent, yieldToEventLoop } from './utils.js';
import {
  ROUTE_FILE_PATH_RE,
  buildLaravelRoutePrefixIndex,
  extractLaravelRouteDefinitions,
  getLaravelRoutePrefixForFile,
  resolveController,
} from './laravel-route-processor.js';

type ResolvedRouteTarget = {
  httpMethod: string;
  path: string;
  methodNodeId: string;
  confidence: number;
  reason: string;
};

type HttpCall = {
  filePath: string;
  callNode: any;
  httpMethod: string;
  path: string;
  client: string | null;
  basePrefixOverride: string | null;
  clientBasePrefix: string | null;
};

const normalizeHttpPath = (rawUrlOrPath: string): string | null => {
  let value = rawUrlOrPath.trim();
  if (value.length === 0) return null;

  // Absolute URL → path
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      value = url.pathname || '/';
    } catch {
      return null;
    }
  }

  const queryStart = value.indexOf('?');
  if (queryStart !== -1) value = value.slice(0, queryStart);
  const hashStart = value.indexOf('#');
  if (hashStart !== -1) value = value.slice(0, hashStart);

  value = value.trim();
  if (value.length === 0) return null;

  if (!value.startsWith('/')) value = '/' + value;
  value = value.replace(/\/{2,}/g, '/');
  if (value.length > 1) value = value.replace(/\/+$/g, '');

  return value;
};

const joinRoutePrefix = (prefix: string, routePath: string): string => {
  if (!prefix) return routePath;
  if (routePath === '/') return prefix;

  if (routePath === prefix || routePath.startsWith(prefix + '/')) return routePath;

  const left = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const right = routePath.startsWith('/') ? routePath : '/' + routePath;
  return left + right;
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
    const inner = text.startsWith('`') && text.endsWith('`') ? text.slice(1, -1) : text;
    return inner.replace(/\$\{[^}]*\}/g, '*');
  }

  return null;
};

const extractTrailingHttpPathFromTemplateString = (node: any): string | null => {
  if (!node || node.type !== 'template_string') return null;
  const text = String(node.text || '');
  if (text.length === 0) return null;

  const inner = text.startsWith('`') && text.endsWith('`') ? text.slice(1, -1) : text;
  const lastCloseBraceIdx = inner.lastIndexOf('}');
  const suffix = lastCloseBraceIdx !== -1 ? inner.slice(lastCloseBraceIdx + 1) : inner;
  const trimmed = suffix.trim();
  if (trimmed.length === 0) return null;

  return normalizeHttpPath(trimmed);
};

const extractHttpBasePathPrefixFromExpression = (exprNode: any): string | null => {
  if (!exprNode) return null;

  if (exprNode.type === 'binary_expression') {
    const right = exprNode.childForFieldName?.('right');
    const left = exprNode.childForFieldName?.('left');
    return extractHttpBasePathPrefixFromExpression(right) || extractHttpBasePathPrefixFromExpression(left);
  }

  if (exprNode.type === 'string') {
    const urlOrPath = parseStringLikeLiteral(exprNode);
    if (!urlOrPath) return null;
    return normalizeHttpPath(urlOrPath);
  }

  if (exprNode.type === 'template_string') {
    return extractTrailingHttpPathFromTemplateString(exprNode);
  }

  return null;
};

const extractAxiosBaseUrlPrefixesFromTree = (tree: Parser.Tree): Map<string, string> => {
  const prefixes = new Map<string, string>();

  const visit = (node: any) => {
    if (!node) return;

    if (node.type === 'assignment_expression') {
      const left = node.childForFieldName?.('left');
      const right = node.childForFieldName?.('right');

      if (left?.type === 'member_expression') {
        const leftProp = left.childForFieldName?.('property');
        if (leftProp?.type === 'property_identifier' && leftProp.text === 'baseURL') {
          const defaultsNode = left.childForFieldName?.('object');
          if (defaultsNode?.type === 'member_expression') {
            const defaultsProp = defaultsNode.childForFieldName?.('property');
            if (defaultsProp?.type === 'property_identifier' && defaultsProp.text === 'defaults') {
              const clientNode = defaultsNode.childForFieldName?.('object');
              const client = clientNode?.type === 'identifier' ? clientNode.text : null;
              if (client) {
                const prefix = extractHttpBasePathPrefixFromExpression(right);
                if (prefix) prefixes.set(client, prefix);
              }
            }
          }
        }
      }
    }

    for (const child of node.namedChildren || []) {
      visit(child);
    }
  };

  visit(tree.rootNode);
  return prefixes;
};

const getObjectStringProperty = (node: any, propName: string): string | null => {
  if (!node || node.type !== 'object') return null;

  for (const child of node.namedChildren || []) {
    if (child.type !== 'pair') continue;
    const [keyNode, valueNode] = child.namedChildren || [];
    if (!keyNode || !valueNode) continue;

    let key: string | null = null;
    if (keyNode.type === 'property_identifier' || keyNode.type === 'identifier') {
      key = keyNode.text;
    } else if (keyNode.type === 'string') {
      key = parseStringLikeLiteral(keyNode);
    }

    if (key !== propName) continue;
    return parseStringLikeLiteral(valueNode);
  }

  return null;
};

const getObjectPropertyValueNode = (node: any, propName: string): any | null => {
  if (!node || node.type !== 'object') return null;

  for (const child of node.namedChildren || []) {
    if (child.type !== 'pair') continue;
    const [keyNode, valueNode] = child.namedChildren || [];
    if (!keyNode || !valueNode) continue;

    let key: string | null = null;
    if (keyNode.type === 'property_identifier' || keyNode.type === 'identifier') {
      key = keyNode.text;
    } else if (keyNode.type === 'string') {
      key = parseStringLikeLiteral(keyNode);
    }

    if (key !== propName) continue;
    return valueNode;
  }

  return null;
};

const extractBaseUrlPrefixFromConfigObject = (node: any): string | null => {
  if (!node || node.type !== 'object') return null;
  const valueNode = getObjectPropertyValueNode(node, 'baseURL');
  if (!valueNode) return null;
  return extractHttpBasePathPrefixFromExpression(valueNode);
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

const extractHttpCallsFromTree = (filePath: string, tree: Parser.Tree): HttpCall[] => {
  const calls: HttpCall[] = [];
  const localAxiosClients = new Set<string>();
  const localAxiosBasePrefixes = new Map<string, string>();

  const collectAxiosCreateClients = (node: any) => {
    if (!node) return;

    if (node.type === 'variable_declarator') {
      const nameNode = node.childForFieldName?.('name');
      const valueNode = node.childForFieldName?.('value');
      const variableName = nameNode?.type === 'identifier' ? nameNode.text : null;
      if (variableName && valueNode?.type === 'call_expression') {
        const fnNode = valueNode.childForFieldName?.('function');
        const argsNode = valueNode.childForFieldName?.('arguments');
        const args = argsNode?.namedChildren || [];

        if (fnNode?.type === 'member_expression') {
          const objectNode = fnNode.childForFieldName?.('object');
          const propertyNode = fnNode.childForFieldName?.('property');
          const objectName = objectNode?.type === 'identifier' ? objectNode.text : null;
          const methodName = propertyNode?.type === 'property_identifier' ? propertyNode.text : null;

          if (objectName && objectName.toLowerCase() === 'axios' && methodName === 'create') {
            localAxiosClients.add(variableName);
            const basePrefix = args.length >= 1 ? extractBaseUrlPrefixFromConfigObject(args[0]) : null;
            if (basePrefix) localAxiosBasePrefixes.set(variableName, basePrefix);
          }
        }
      }
    }

    if (node.type === 'assignment_expression') {
      const left = node.childForFieldName?.('left');
      const right = node.childForFieldName?.('right');
      const variableName = left?.type === 'identifier' ? left.text : null;
      if (variableName && right?.type === 'call_expression') {
        const fnNode = right.childForFieldName?.('function');
        const argsNode = right.childForFieldName?.('arguments');
        const args = argsNode?.namedChildren || [];

        if (fnNode?.type === 'member_expression') {
          const objectNode = fnNode.childForFieldName?.('object');
          const propertyNode = fnNode.childForFieldName?.('property');
          const objectName = objectNode?.type === 'identifier' ? objectNode.text : null;
          const methodName = propertyNode?.type === 'property_identifier' ? propertyNode.text : null;

          if (objectName && objectName.toLowerCase() === 'axios' && methodName === 'create') {
            localAxiosClients.add(variableName);
            const basePrefix = args.length >= 1 ? extractBaseUrlPrefixFromConfigObject(args[0]) : null;
            if (basePrefix) localAxiosBasePrefixes.set(variableName, basePrefix);
          }
        }
      }
    }

    for (const child of node.namedChildren || []) {
      collectAxiosCreateClients(child);
    }
  };

  collectAxiosCreateClients(tree.rootNode);

  const visit = (node: any) => {
    if (!node) return;

    if (node.type === 'call_expression') {
      const fnNode = node.childForFieldName?.('function');
      const argsNode = node.childForFieldName?.('arguments');
      const args = argsNode?.namedChildren || [];

      if (fnNode?.type === 'identifier') {
        const fnName = fnNode.text;

        // fetch('/path', { method: 'POST' })
        if (fnName === 'fetch' && args.length >= 1) {
          const url = parseStringLikeLiteral(args[0]);
          if (url) {
            const method = args.length >= 2 && args[1]?.type === 'object'
              ? (getObjectStringProperty(args[1], 'method') || 'GET')
              : 'GET';
            const path = normalizeHttpPath(url);
            if (path) calls.push({
              filePath,
              callNode: node,
              httpMethod: String(method).toUpperCase(),
              path,
              client: null,
              basePrefixOverride: null,
              clientBasePrefix: null,
            });
          }
        }

        // axios({ url: '/path', method: 'post' })
        if (fnName.toLowerCase() === 'axios' && args.length >= 1 && args[0]?.type === 'object') {
          const url = getObjectStringProperty(args[0], 'url');
          const method = getObjectStringProperty(args[0], 'method') || 'GET';
          const basePrefixOverride = extractBaseUrlPrefixFromConfigObject(args[0]);
          if (url) {
            const path = normalizeHttpPath(url);
            if (path) calls.push({
              filePath,
              callNode: node,
              httpMethod: String(method).toUpperCase(),
              path,
              client: fnName,
              basePrefixOverride,
              clientBasePrefix: null,
            });
          }
        }
      }

      // axios.get('/path') / axios.post('/path', data, config)
      if (fnNode?.type === 'member_expression') {
        const objectNode = fnNode.childForFieldName?.('object');
        const propertyNode = fnNode.childForFieldName?.('property');
        const objectName = objectNode?.type === 'identifier' ? objectNode.text : null;
        const methodName = propertyNode?.type === 'property_identifier' ? propertyNode.text : null;

        const methodLower = methodName?.toLowerCase() ?? '';
        const isAxiosClient = objectName && (objectName.toLowerCase() === 'axios' || localAxiosClients.has(objectName));
        const configArgIndex = methodLower === 'request'
          ? 0
          : (methodLower === 'get' || methodLower === 'delete' || methodLower === 'head' || methodLower === 'options')
            ? 1
            : 2;

        if (isAxiosClient && methodName && args.length >= 1) {
          const basePrefixOverride = args.length > configArgIndex && args[configArgIndex]?.type === 'object'
            ? extractBaseUrlPrefixFromConfigObject(args[configArgIndex])
            : null;

          if (methodLower === 'request' && args[0]?.type === 'object') {
            const url = getObjectStringProperty(args[0], 'url');
            const method = getObjectStringProperty(args[0], 'method') || 'GET';
            const path = url ? normalizeHttpPath(url) : null;
            if (path) calls.push({
              filePath,
              callNode: node,
              httpMethod: String(method).toUpperCase(),
              path,
              client: objectName,
              basePrefixOverride,
              clientBasePrefix: objectName ? (localAxiosBasePrefixes.get(objectName) || null) : null,
            });
            return;
          }

          const url = parseStringLikeLiteral(args[0]);
          if (url) {
            const path = normalizeHttpPath(url);
            if (path) calls.push({
              filePath,
              callNode: node,
              httpMethod: methodName.toUpperCase(),
              path,
              client: objectName,
              basePrefixOverride,
              clientBasePrefix: objectName ? (localAxiosBasePrefixes.get(objectName) || null) : null,
            });
          }
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

const buildLaravelRouteIndex = (
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Map<string, ResolvedRouteTarget[]> => {
  const index = new Map<string, ResolvedRouteTarget[]>();
  const prefixIndex = buildLaravelRoutePrefixIndex(files);

  const addIndexEntry = (key: string, target: ResolvedRouteTarget) => {
    let list = index.get(key);
    if (!list) {
      list = [];
      index.set(key, list);
    }
    list.push(target);
  };

  for (const file of files) {
    if (!ROUTE_FILE_PATH_RE.test(file.path)) continue;

    const prefix = getLaravelRoutePrefixForFile(file.path, prefixIndex);
    const defs = extractLaravelRouteDefinitions(file.content);
    if (defs.length === 0) continue;

    for (const def of defs) {
      const resolvedController = resolveController(def.controllerClass, file.path, symbolTable, importMap, phpUseAliases);
      if (!resolvedController) continue;

      const methodNodeId = symbolTable.lookupExact(resolvedController.filePath, def.controllerMethod);
      if (!methodNodeId) continue;

      const verbUpper = def.verb === 'any' ? 'ANY' : def.verb.toUpperCase();
      const fullPath = joinRoutePrefix(prefix, def.path);
      const target: ResolvedRouteTarget = {
        httpMethod: verbUpper,
        path: fullPath,
        methodNodeId,
        confidence: resolvedController.confidence,
        reason: resolvedController.reason,
      };

      addIndexEntry(`${verbUpper} ${fullPath}`, target);

      const wildcardPath = fullPath.replace(/\{[^}]+\}/g, '*');
      if (wildcardPath !== fullPath) addIndexEntry(`${verbUpper} ${wildcardPath}`, target);
    }
  }

  return index;
};

const isHttpRelevantFile = (filePath: string, content: string): boolean => {
  const lang = getLanguageFromFilename(filePath);
  if (lang !== SupportedLanguages.TypeScript && lang !== SupportedLanguages.JavaScript) return false;
  // Cheap prefilter before parsing.
  // Be conservative about false negatives: TypeScript often uses `Axios.get<Foo>(...)`, which
  // can miss stricter `axios.get(` patterns due to generic type args.
  return /\bfetch\s*\(/.test(content) || /\baxios\b/i.test(content);
};

const isHttpConfigFile = (filePath: string, content: string): boolean => {
  const lang = getLanguageFromFilename(filePath);
  if (lang !== SupportedLanguages.TypeScript && lang !== SupportedLanguages.JavaScript) return false;
  return /\bdefaults\s*\.\s*baseURL\s*=/.test(content);
};

export const processLaravelHttpWiring = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Promise<{ edgesAdded: number }> => {
  const routeIndex = buildLaravelRouteIndex(files, symbolTable, importMap, phpUseAliases);
  if (routeIndex.size === 0) return { edgesAdded: 0 };

  const parser = await loadParser();
  const axiosBasePathPrefixes = new Map<string, string>();
  let edgesAdded = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 500 === 0) await yieldToEventLoop();

    if (!isHttpConfigFile(file.path, file.content)) continue;

    const language = getLanguageFromFilename(file.path);
    if (!language) continue;

    await loadLanguage(language, file.path);

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

    const prefixes = extractAxiosBaseUrlPrefixesFromTree(tree);
    for (const [client, prefix] of prefixes) axiosBasePathPrefixes.set(client, prefix);
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 200 === 0) await yieldToEventLoop();

    if (!isHttpRelevantFile(file.path, file.content)) continue;

    const language = getLanguageFromFilename(file.path);
    if (!language) continue;

    await loadLanguage(language, file.path);

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

    const httpCalls = extractHttpCallsFromTree(file.path, tree);
    if (httpCalls.length === 0) continue;

    for (const call of httpCalls) {
      const defaultPrefix = call.client ? axiosBasePathPrefixes.get(call.client) : null;
      const basePrefix = call.basePrefixOverride || call.clientBasePrefix || defaultPrefix || null;
      const effectivePath = basePrefix ? joinRoutePrefix(basePrefix, call.path) : call.path;
      const key = `${call.httpMethod} ${effectivePath}`;
      const matches = routeIndex.get(key) || routeIndex.get(`ANY ${effectivePath}`) || [];
      if (matches.length !== 1) continue;

      const target = matches[0];
      const reason = `http-${call.httpMethod.toLowerCase()}:${effectivePath}`;
      const matchConfidence = effectivePath.includes('*') ? 0.9 : 0.95;
      const confidence = Math.min(target.confidence, matchConfidence);
      if (confidence < matchConfidence) continue;
      const sourceId = findEnclosingCallableId(call.callNode, call.filePath, symbolTable)
        || generateId('File', call.filePath);

      const relId = generateId('CALLS', `${sourceId}:${reason}->${target.methodNodeId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId,
        targetId: target.methodNodeId,
        confidence,
        reason,
      });
      edgesAdded++;
    }
  }

  return { edgesAdded };
};
