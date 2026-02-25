import { KnowledgeGraph } from '../graph/types.js';
import Parser from 'tree-sitter';
import { ASTCache } from './ast-cache.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap } from './import-processor.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, yieldToEventLoop } from './utils.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

type ResolvedClass = {
  filePath: string;
  confidence: number;
  reason: string;
};

type DispatchKind = 'helper' | 'helper-sync' | 'static' | 'bus';

type ExtractedDispatchCall = {
  callNode: any;
  kind: DispatchKind;
  classRef: string;
};

const looksLikePhpIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const normalizePhpClassRef = (value: string): { baseName: string; parts: string[] } => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  return { baseName, parts };
};

const stripPhpClassConstant = (value: string): string => value.trim().replace(/::class$/i, '').trim();

const resolvePhpClassToFile = (
  classRef: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
): ResolvedClass | null => {
  const normalizedRef = stripPhpClassConstant(classRef);
  const { baseName, parts } = normalizePhpClassRef(normalizedRef);
  if (!looksLikePhpIdentifier(baseName)) return null;

  const classDefs = symbolTable
    .lookupFuzzy(baseName)
    .filter((def: SymbolDefinition) => def.type === 'Class');

  if (classDefs.length === 0) return null;

  const importedFiles = importMap.get(currentFilePath);
  if (importedFiles) {
    const importedMatches = classDefs.filter(def => importedFiles.has(def.filePath));
    if (importedMatches.length === 1) {
      return { filePath: importedMatches[0].filePath, confidence: 0.95, reason: 'import-resolved' };
    }
  }

  if (parts.length > 1) {
    const suffixes = new Set<string>();
    suffixes.add(`${parts.join('/')}.php`);
    suffixes.add(`${parts.slice(1).join('/')}.php`);

    const suffixMatches = classDefs.filter(def => {
      for (const suffix of suffixes) {
        if (suffix.length > 0 && def.filePath.endsWith(suffix)) return true;
      }
      return false;
    });
    if (suffixMatches.length === 1) {
      return { filePath: suffixMatches[0].filePath, confidence: 0.9, reason: 'namespace-suffix' };
    }
  }

  const jobHeuristic = classDefs.filter(def => def.filePath.includes('/Jobs/') || def.filePath.endsWith('Job.php'));
  if (jobHeuristic.length === 1) {
    return { filePath: jobHeuristic[0].filePath, confidence: 0.8, reason: 'job-heuristic' };
  }

  if (classDefs.length === 1) {
    return { filePath: classDefs[0].filePath, confidence: 0.65, reason: 'fuzzy-class' };
  }

  return null;
};

const parseClassRefFromDispatchArg = (argNode: any): string | null => {
  if (!argNode) return null;

  if (argNode.type === 'class_constant_access_expression') {
    return stripPhpClassConstant(argNode.text ?? '');
  }

  if (argNode.type === 'object_creation_expression') {
    const nameNode = argNode.childForFieldName?.('name');
    const text = nameNode?.text?.trim();
    if (text) return stripPhpClassConstant(text);

    const fallback = argNode.namedChildren.find((c: any) => c.type === 'qualified_name' || c.type === 'name');
    const fallbackText = fallback?.text?.trim();
    return fallbackText ? stripPhpClassConstant(fallbackText) : null;
  }

  if (argNode.type === 'qualified_name' || argNode.type === 'name') {
    const text = argNode.text?.trim();
    return text ? stripPhpClassConstant(text) : null;
  }

  return null;
};

const getScopeBaseName = (value: string): string => {
  const trimmed = value.trim().replace(/^\\+/, '');
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
};

const DISPATCH_HELPER_NAMES = new Set(['dispatch', 'dispatch_sync']);
const DISPATCH_STATIC_METHODS = new Set([
  'dispatch',
  'dispatchSync',
  'dispatchNow',
  'dispatchAfterResponse',
  'dispatchIf',
  'dispatchUnless',
]);

const getCallArgumentExpressions = (argsNode: any): any[] => {
  if (!argsNode) return [];
  const named = argsNode.namedChildren || [];
  const exprs: any[] = [];

  for (const node of named) {
    if (node.type === 'argument') {
      const expr = node.namedChildren?.at(-1);
      if (expr) exprs.push(expr);
      continue;
    }
    exprs.push(node);
  }

  return exprs;
};

const extractDispatchCallsFromTree = (tree: Parser.Tree): ExtractedDispatchCall[] => {
  const calls: ExtractedDispatchCall[] = [];

  const visit = (node: any) => {
    if (!node) return;

    if (node.type === 'function_call_expression') {
      const fnNode = node.childForFieldName?.('function');
      const fnName = fnNode?.text?.trim();

      if (fnName && DISPATCH_HELPER_NAMES.has(fnName)) {
        const argsNode = node.childForFieldName?.('arguments');
        const args = getCallArgumentExpressions(argsNode);
        const classRef = parseClassRefFromDispatchArg(args[0]);
        if (classRef) {
          calls.push({
            callNode: node,
            kind: fnName === 'dispatch_sync' ? 'helper-sync' : 'helper',
            classRef,
          });
        }
      }
    }

    if (node.type === 'scoped_call_expression') {
      const scopeNode = node.childForFieldName?.('scope');
      const methodNode = node.childForFieldName?.('name');
      const methodName = methodNode?.text?.trim();
      const scopeText = scopeNode?.text?.trim();
      if (methodName && scopeText && DISPATCH_STATIC_METHODS.has(methodName)) {
        const baseScope = getScopeBaseName(scopeText);
        if (baseScope === 'Bus') {
          const argsNode = node.childForFieldName?.('arguments');
          const args = getCallArgumentExpressions(argsNode);
          const classRef = parseClassRefFromDispatchArg(args[0]);
          if (classRef) {
            calls.push({ callNode: node, kind: 'bus', classRef });
          }
        } else {
          calls.push({ callNode: node, kind: 'static', classRef: stripPhpClassConstant(scopeText) });
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

const isJobDispatchRelevantFile = (filePath: string, content: string): boolean => {
  const lang = getLanguageFromFilename(filePath);
  if (lang !== SupportedLanguages.PHP) return false;
  // Cheap prefilter before parsing.
  return /\bdispatch(?:_sync)?\s*\(|::\s*dispatch(?:Sync|Now|AfterResponse|If|Unless)?\s*\(|\bBus\s*::\s*dispatch\b/.test(content);
};

export const processLaravelJobDispatch = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
): Promise<{ edgesAdded: number }> => {
  const parser = await loadParser();
  await loadLanguage(SupportedLanguages.PHP);

  let edgesAdded = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 200 === 0) await yieldToEventLoop();

    if (!isJobDispatchRelevantFile(file.path, file.content)) continue;

    let tree = astCache.get(file.path);
    if (!tree) {
      try {
        tree = parser.parse(file.content, undefined, { bufferSize: 1024 * 256 });
        astCache.set(file.path, tree);
      } catch {
        continue;
      }
    }

    const dispatchCalls = extractDispatchCallsFromTree(tree);
    if (dispatchCalls.length === 0) continue;

    for (const call of dispatchCalls) {
      const resolved = resolvePhpClassToFile(call.classRef, file.path, symbolTable, importMap);
      if (!resolved) continue;

      const handlerMethodId = symbolTable.lookupExact(resolved.filePath, 'handle')
        || symbolTable.lookupExact(resolved.filePath, '__invoke');
      if (!handlerMethodId) continue;

      const sourceId = findEnclosingPhpCallableId(call.callNode, file.path, symbolTable);
      const reason = `laravel-job-dispatch-${call.kind}-${resolved.reason}`;
      const relId = generateId('CALLS', `${sourceId}:${reason}->${handlerMethodId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId,
        targetId: handlerMethodId,
        confidence: resolved.confidence,
        reason,
      });
      edgesAdded++;
    }
  }

  return { edgesAdded };
};

