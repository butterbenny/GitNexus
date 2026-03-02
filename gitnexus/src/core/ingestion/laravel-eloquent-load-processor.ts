import Parser from 'tree-sitter';
import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap, PhpUseAliasMap, expandPhpClassRefFromUseAliases } from './import-processor.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, getParseableContent, yieldToEventLoop } from './utils.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

type ResolvedModelClass = {
  classNodeId: string;
  baseName: string;
  filePath: string;
  confidence: number;
  reason: string;
};

type RelationshipMethodTarget = {
  methodNodeId: string;
  targetModelClassId: string;
  confidence: number;
  reason: string;
};

const LOAD_METHODS = new Set([
  'with',
  'load',
  'loadmissing',
  'withcount',
  'withexists',
]);

const looksLikePhpIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const parsePhpStringLiteral = (node: any): string | null => {
  if (!node || node.type !== 'string') return null;
  const text = String(node.text || '').trim();
  if (text.length < 2) return null;
  const quote = text[0];
  if ((quote !== '\'' && quote !== '"') || text[text.length - 1] !== quote) return null;
  return text.slice(1, -1);
};

const isArrayKeyValueInitializer = (node: any): boolean => {
  if (!node || node.type !== 'array_element_initializer') return false;
  return (node.children || []).some((c: any) => c.type === '=>');
};

const getArrayInitializerKey = (node: any): any | null => {
  if (!isArrayKeyValueInitializer(node)) return null;
  return node.namedChildren?.[0] ?? null;
};

const peelExpression = (node: any): any | null => {
  let current = node;
  while (current) {
    if (current.type === 'parenthesized_expression') {
      current = current.namedChildren?.at(0) || null;
      continue;
    }
    return current;
  }
  return null;
};

const getCallArgumentExpressions = (argsNode: any): any[] => {
  if (!argsNode) return [];
  const named = argsNode.namedChildren || [];
  const exprs: any[] = [];

  for (const n of named) {
    if (n.type === 'argument') {
      const expr = n.namedChildren?.at(-1);
      if (expr) exprs.push(expr);
      continue;
    }
    exprs.push(n);
  }

  return exprs;
};

const extractRelationSpecsFromArg = (expr: any): string[] => {
  const node = peelExpression(expr);
  if (!node) return [];

  const direct = parsePhpStringLiteral(node);
  if (direct) return [direct];

  if (node.type === 'array_creation_expression') {
    const specs: string[] = [];
    for (const initializer of node.namedChildren || []) {
      if (initializer.type !== 'array_element_initializer') continue;

      if (isArrayKeyValueInitializer(initializer)) {
        const keyNode = getArrayInitializerKey(initializer);
        const key = parsePhpStringLiteral(keyNode);
        if (key) specs.push(key);
        continue;
      }

      const valueNode = initializer.namedChildren?.[0];
      const value = parsePhpStringLiteral(valueNode);
      if (value) specs.push(value);
    }
    return specs;
  }

  return [];
};

const normalizeRelationSegment = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Common Eloquent relation constraints:
  // - relation:col1,col2
  // - relation as alias
  const beforeColon = trimmed.split(':', 1)[0] || '';
  const beforeAs = beforeColon.split(/\s+as\s+/i, 1)[0] || '';
  const cleaned = beforeAs.trim();

  if (!looksLikePhpIdentifier(cleaned)) return null;
  return cleaned;
};

const normalizeRelationPath = (raw: string): { segments: string[]; display: string } | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const segments: string[] = [];
  for (const seg of trimmed.split('.')) {
    const normalized = normalizeRelationSegment(seg);
    if (!normalized) return null;
    segments.push(normalized);
  }

  if (segments.length === 0) return null;
  return { segments, display: segments.join('.') };
};

const walkNodes = (node: any, fn: (n: any) => void) => {
  fn(node);
  for (let i = 0; i < node.namedChildCount; i++) walkNodes(node.namedChild(i), fn);
};

const findEnclosingPhpCallableId = (node: any, filePath: string, symbolTable: SymbolTable): string => {
  let current = node.parent;

  while (current) {
    if (current.type === 'method_declaration') {
      const nameNode = current.childForFieldName?.('name');
      const name = nameNode?.text?.trim();
      if (name) {
        return symbolTable.lookupExact(filePath, name) || generateId('Method', `${filePath}:${name}`);
      }
      break;
    }
    if (current.type === 'function_definition') {
      const nameNode = current.childForFieldName?.('name');
      const name = nameNode?.text?.trim();
      if (name) {
        return symbolTable.lookupExact(filePath, name) || generateId('Function', `${filePath}:${name}`);
      }
      break;
    }
    current = current.parent;
  }

  return generateId('File', filePath);
};

const findRootScopedCall = (expr: any): any | null => {
  let current = peelExpression(expr);
  while (current) {
    if (current.type === 'scoped_call_expression') return current;
    if (current.type === 'member_call_expression' || current.type === 'nullsafe_member_call_expression') {
      current = peelExpression(current.childForFieldName?.('object'));
      continue;
    }
    return null;
  }
  return null;
};

const resolveLaravelModelClassFromScope = (
  scopeText: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): ResolvedModelClass | null => {
  const expanded = expandPhpClassRefFromUseAliases(scopeText, currentFilePath, phpUseAliases)
    .trim()
    .replace(/^\\+/, '')
    .replace(/::class$/i, '')
    .trim();
  if (!expanded) return null;

  const parts = expanded.split(/[\\/]+/).filter(Boolean);
  const baseName = parts.at(-1) ?? '';
  if (!looksLikePhpIdentifier(baseName)) return null;

  const classDefs = symbolTable
    .lookupFuzzy(baseName)
    .filter((def: SymbolDefinition) => def.type === 'Class');
  if (classDefs.length === 0) return null;

  const modelDefs = classDefs.filter(def => def.filePath.includes('/Models/'));
  const candidates = modelDefs.length > 0 ? modelDefs : classDefs;

  if (candidates.length !== 1) return null;

  const def = candidates[0];
  const classNodeId = def.nodeId;
  const filePath = def.filePath;

  const importedFiles = importMap.get(currentFilePath);
  if (importedFiles && importedFiles.has(filePath)) {
    return { classNodeId, baseName, filePath, confidence: 0.95, reason: 'import-resolved' };
  }

  if (parts.length > 1) {
    const suffixes = new Set<string>();
    suffixes.add(`${parts.join('/')}.php`);
    suffixes.add(`${parts.slice(1).join('/')}.php`);

    for (const suffix of suffixes) {
      const normalizedSuffix = suffix.replace(/^\/+/, '');
      if (!normalizedSuffix) continue;
      if (filePath === normalizedSuffix || filePath.endsWith('/' + normalizedSuffix)) {
        return { classNodeId, baseName, filePath, confidence: 0.9, reason: 'namespace-suffix' };
      }
    }
  }

  // Heuristic: a unique model class by basename.
  return { classNodeId, baseName, filePath, confidence: 0.9, reason: 'model-heuristic' };
};

const buildRelationshipMethodIndex = (graph: KnowledgeGraph): Map<string, Map<string, RelationshipMethodTarget | null>> => {
  const nodeById = new Map<string, any>();
  for (const n of graph.nodes) nodeById.set(n.id, n);

  const memberOfByMethod = new Map<string, string>();
  for (const r of graph.relationships) {
    if (r.type !== 'MEMBER_OF') continue;
    memberOfByMethod.set(r.sourceId, r.targetId);
  }

  const index = new Map<string, Map<string, RelationshipMethodTarget | null>>();

  const isRelationshipEdge = (reason: string): boolean => {
    if (!reason.startsWith('laravel-eloquent:')) return false;
    if (reason.includes(':through')) return false;
    return true;
  };

  for (const r of graph.relationships) {
    if (r.type !== 'CALLS') continue;
    if (typeof r.reason !== 'string' || !isRelationshipEdge(r.reason)) continue;

    const methodNode = nodeById.get(r.sourceId);
    if (!methodNode || methodNode.label !== 'Method') continue;
    const methodName = String(methodNode.properties?.name || '').trim();
    if (!methodName) continue;

    const modelClassId = memberOfByMethod.get(r.sourceId);
    if (!modelClassId) continue;

    let rels = index.get(modelClassId);
    if (!rels) {
      rels = new Map<string, RelationshipMethodTarget | null>();
      index.set(modelClassId, rels);
    }

    const existing = rels.get(methodName);
    const next = {
      methodNodeId: r.sourceId,
      targetModelClassId: r.targetId,
      confidence: r.confidence ?? 0,
      reason: r.reason,
    };

    if (!existing) {
      rels.set(methodName, next);
      continue;
    }

    // Ambiguous (multiple candidate targets for same relationship method name).
    if (existing.methodNodeId !== next.methodNodeId || existing.targetModelClassId !== next.targetModelClassId) {
      rels.set(methodName, null);
    }
  }

  return index;
};

const isEloquentLoadRelevantFile = (filePath: string, content: string): boolean => {
  const lang = getLanguageFromFilename(filePath);
  if (lang !== SupportedLanguages.PHP) return false;
  if (!content) return false;
  return /(?:\?->|->)\s*(with|load|loadMissing|withCount|withExists)\s*\(/.test(content)
    || /::\s*(with|load|loadMissing|withCount|withExists)\s*\(/.test(content);
};

export const processLaravelEloquentLoadEdges = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  phpUseAliases: PhpUseAliasMap,
): Promise<{ edgesAdded: number }> => {
  const relationshipIndex = buildRelationshipMethodIndex(graph);
  if (relationshipIndex.size === 0) return { edgesAdded: 0 };

  const parser = await loadParser();
  let edgesAdded = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 300 === 0) await yieldToEventLoop();

    if (!isEloquentLoadRelevantFile(file.path, file.content)) continue;

    const language = getLanguageFromFilename(file.path);
    if (language !== SupportedLanguages.PHP) continue;

    await loadLanguage(language, file.path);

    let tree: Parser.Tree | undefined = astCache.get(file.path);
    if (!tree) {
      try {
        const content = getParseableContent(file.path, file.content);
        tree = parser.parse(content, undefined, { bufferSize: 1024 * 256 });
        astCache.set(file.path, tree);
      } catch {
        continue;
      }
    }

    const loadCalls: any[] = [];
    walkNodes(tree.rootNode, (node: any) => {
      if (node.type === 'member_call_expression' || node.type === 'nullsafe_member_call_expression') {
        const name = String(node.childForFieldName?.('name')?.text || '').trim();
        if (LOAD_METHODS.has(name.toLowerCase())) loadCalls.push(node);
        return;
      }
      if (node.type === 'scoped_call_expression') {
        const name = String(node.childForFieldName?.('name')?.text || '').trim();
        if (LOAD_METHODS.has(name.toLowerCase())) loadCalls.push(node);
      }
    });

    if (loadCalls.length === 0) continue;

    for (const call of loadCalls) {
      const methodName = String(call.childForFieldName?.('name')?.text || '').trim();
      if (!methodName) continue;

      const argsNode = call.childForFieldName?.('arguments');
      const args = getCallArgumentExpressions(argsNode);
      if (args.length === 0) continue;

      const specs: string[] = [];
      for (const arg of args) specs.push(...extractRelationSpecsFromArg(arg));
      if (specs.length === 0) continue;

      const rootScoped = call.type === 'scoped_call_expression'
        ? call
        : findRootScopedCall(call.childForFieldName?.('object'));
      if (!rootScoped) continue;

      const scopeText = String(rootScoped.childForFieldName?.('scope')?.text || '').trim();
      if (!scopeText) continue;
      const shortScope = scopeText.replace(/^\\+/, '').trim();
      if (!shortScope || ['self', 'static', 'parent'].includes(shortScope.toLowerCase())) continue;

      const resolvedModel = resolveLaravelModelClassFromScope(scopeText, file.path, symbolTable, importMap, phpUseAliases);
      if (!resolvedModel || resolvedModel.confidence < 0.9) continue;

      const sourceId = findEnclosingPhpCallableId(call, file.path, symbolTable);
      const loadKind = methodName.toLowerCase();

      for (const rawSpec of specs) {
        const normalized = normalizeRelationPath(rawSpec);
        if (!normalized) continue;

        let currentModelId = resolvedModel.classNodeId;
        let ok = true;
        const traversed: string[] = [];

        for (const seg of normalized.segments) {
          const rels = relationshipIndex.get(currentModelId);
          const target = rels?.get(seg);
          if (!target) {
            ok = false;
            break;
          }
          if (target === null) {
            ok = false;
            break;
          }

          traversed.push(seg);
          const pathSoFar = traversed.join('.');
          const edgeReason = `laravel-eloquent-load:${loadKind}:${pathSoFar}`;
          const edgeConfidence = Math.min(resolvedModel.confidence, target.confidence, 0.95);
          if (edgeConfidence < 0.9) {
            ok = false;
            break;
          }

          const relId = generateId('CALLS', `${sourceId}:${edgeReason}->${target.methodNodeId}`);
          graph.addRelationship({
            id: relId,
            type: 'CALLS',
            sourceId,
            targetId: target.methodNodeId,
            confidence: edgeConfidence,
            reason: edgeReason,
          });
          edgesAdded++;

          currentModelId = target.targetModelClassId;
        }

        if (!ok) continue;
      }
    }
  }

  return { edgesAdded };
};
