import { KnowledgeGraph } from '../graph/types.js';
import Parser from 'tree-sitter';
import { ASTCache } from './ast-cache.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap, PhpUseAliasMap, expandPhpClassRefFromUseAliases } from './import-processor.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, yieldToEventLoop } from './utils.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

type ResolvedClass = {
  filePath: string;
  confidence: number;
  reason: string;
};

type DispatchKind =
  | 'helper'
  | 'helper-sync'
  | 'static'
  | 'bus'
  | 'bus-chain'
  | 'bus-batch'
  | 'with-chain-root'
  | 'with-chain-item'
  | 'dispatch-chain-item';

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
  phpUseAliases: PhpUseAliasMap,
): ResolvedClass | null => {
  const normalizedRef = stripPhpClassConstant(classRef);
  const expandedRef = expandPhpClassRefFromUseAliases(normalizedRef, currentFilePath, phpUseAliases);
  const { baseName, parts } = normalizePhpClassRef(expandedRef);
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

type BusBuilderKind = 'chain' | 'batch';

const BUS_BUILDER_METHODS = new Set<BusBuilderKind>(['chain', 'batch']);
const PENDING_DISPATCH_METHODS = new Set(['dispatch', 'dispatchAfterResponse']);

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

const extractClassRefsFromArrayExpression = (arrayNode: any): string[] => {
  if (!arrayNode || arrayNode.type !== 'array_creation_expression') return [];
  const entries = arrayNode.namedChildren?.filter((c: any) => c.type === 'array_element_initializer') || [];
  const classRefs: string[] = [];

  for (const entry of entries) {
    const expr = entry.namedChildren?.at(-1);
    const classRef = parseClassRefFromDispatchArg(expr);
    if (classRef) classRefs.push(classRef);
  }

  return classRefs;
};

const unwrapChainedCallObject = (node: any): any | null => {
  let current = node;

  while (current) {
    if (current.type === 'member_call_expression') {
      current = current.childForFieldName?.('object') || null;
      continue;
    }
    if (current.type === 'parenthesized_expression') {
      current = current.namedChildren?.at(0) || null;
      continue;
    }
    return current;
  }

  return null;
};

const findBusBuilderCall = (
  node: any,
): { kind: BusBuilderKind; callNode: any; argsNode: any } | null => {
  const base = unwrapChainedCallObject(node);
  if (!base || base.type !== 'scoped_call_expression') return null;

  const scopeNode = base.childForFieldName?.('scope');
  const methodNode = base.childForFieldName?.('name');
  const methodName = methodNode?.text?.trim();
  const scopeText = scopeNode?.text?.trim();

  if (!methodName || !scopeText) return null;
  if (!BUS_BUILDER_METHODS.has(methodName as BusBuilderKind)) return null;

  const baseScope = getScopeBaseName(scopeText);
  if (baseScope !== 'Bus') return null;

  const argsNode = base.childForFieldName?.('arguments');
  return { kind: methodName as BusBuilderKind, callNode: base, argsNode };
};

const findJobWithChainCall = (
  node: any,
): { jobClassRef: string; argsNode: any } | null => {
  const base = unwrapChainedCallObject(node);
  if (!base || base.type !== 'scoped_call_expression') return null;

  const scopeNode = base.childForFieldName?.('scope');
  const methodNode = base.childForFieldName?.('name');
  const methodName = methodNode?.text?.trim();
  const scopeText = scopeNode?.text?.trim();

  if (!methodName || !scopeText) return null;
  if (methodName !== 'withChain') return null;

  const baseScope = getScopeBaseName(scopeText);
  if (baseScope === 'Bus') return null;

  const argsNode = base.childForFieldName?.('arguments');
  return { jobClassRef: stripPhpClassConstant(scopeText), argsNode };
};

const findStaticJobDispatchCall = (
  node: any,
): { jobClassRef: string; callNode: any } | null => {
  const base = unwrapChainedCallObject(node);
  if (!base || base.type !== 'scoped_call_expression') return null;

  const scopeNode = base.childForFieldName?.('scope');
  const methodNode = base.childForFieldName?.('name');
  const methodName = methodNode?.text?.trim();
  const scopeText = scopeNode?.text?.trim();
  if (!methodName || !scopeText) return null;
  if (!DISPATCH_STATIC_METHODS.has(methodName)) return null;

  const baseScope = getScopeBaseName(scopeText);
  if (baseScope === 'Bus') return null;

  return { jobClassRef: stripPhpClassConstant(scopeText), callNode: base };
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

    if (node.type === 'member_call_expression') {
      const methodNode = node.childForFieldName?.('name');
      const methodName = methodNode?.text?.trim();
      const objectNode = node.childForFieldName?.('object');

      if (methodName && PENDING_DISPATCH_METHODS.has(methodName)) {
        const busCall = findBusBuilderCall(objectNode);
        if (busCall?.argsNode) {
          const args = getCallArgumentExpressions(busCall.argsNode);
          const jobExpr = args[0];
          const classRefs = extractClassRefsFromArrayExpression(jobExpr);
          for (const classRef of classRefs) {
            calls.push({
              callNode: node,
              kind: busCall.kind === 'chain' ? 'bus-chain' : 'bus-batch',
              classRef,
            });
          }
        }

        const withChainCall = findJobWithChainCall(objectNode);
        if (withChainCall) {
          calls.push({
            callNode: node,
            kind: 'with-chain-root',
            classRef: withChainCall.jobClassRef,
          });

          const args = getCallArgumentExpressions(withChainCall.argsNode);
          const chainExpr = args[0];
          const classRefs = extractClassRefsFromArrayExpression(chainExpr);
          for (const classRef of classRefs) {
            calls.push({
              callNode: node,
              kind: 'with-chain-item',
              classRef,
            });
          }
        }
      }

      if (methodName === 'chain') {
        const staticDispatch = findStaticJobDispatchCall(objectNode);
        if (staticDispatch) {
          const argsNode = node.childForFieldName?.('arguments');
          const args = getCallArgumentExpressions(argsNode);
          const chainExpr = args[0];
          const classRefs = extractClassRefsFromArrayExpression(chainExpr);
          for (const classRef of classRefs) {
            calls.push({
              callNode: node,
              kind: 'dispatch-chain-item',
              classRef,
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
  return /\bdispatch(?:_sync)?\s*\(|::\s*dispatch(?:Sync|Now|AfterResponse|If|Unless)?\s*\(|::\s*withChain\s*\(|->\s*chain\s*\(|\bBus\s*::\s*(?:dispatch|chain|batch)\b/.test(content);
};

export const processLaravelJobDispatch = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
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
      const resolved = resolvePhpClassToFile(call.classRef, file.path, symbolTable, importMap, phpUseAliases);
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
