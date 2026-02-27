import Parser from 'tree-sitter';
import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap } from './import-processor.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, getParseableContent, yieldToEventLoop } from './utils.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

type RelationshipMethodTarget = {
  methodNodeId: string;
  targetModelClassId: string;
  confidence: number;
  reason: string;
};

const looksLikePhpIdentifier = (value: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

const parsePhpStringLiteral = (node: any): string | null => {
  if (!node || node.type !== 'string') return null;
  const text = String(node.text || '').trim();
  if (text.length < 2) return null;
  const quote = text[0];
  if ((quote !== '\'' && quote !== '"') || text[text.length - 1] !== quote) return null;
  return text.slice(1, -1);
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

const normalizeRelationSegment = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

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

    if (existing.methodNodeId !== next.methodNodeId || existing.targetModelClassId !== next.targetModelClassId) {
      rels.set(methodName, null);
    }
  }

  return index;
};

const resolveModelClassForResource = (
  resourceClassName: string,
  resourceFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
): { modelClassId: string; confidence: number } | null => {
  if (!resourceClassName.endsWith('Resource')) return null;
  const base = resourceClassName.slice(0, -'Resource'.length);
  if (!looksLikePhpIdentifier(base)) return null;

  const defs = symbolTable
    .lookupFuzzy(base)
    .filter((def: SymbolDefinition) => def.type === 'Class' && def.filePath.includes('/Models/'));

  if (defs.length === 0) return null;
  if (defs.length === 1) return { modelClassId: defs[0].nodeId, confidence: 0.9 };

  const importedFiles = importMap.get(resourceFilePath);
  if (!importedFiles) return null;
  const importedMatches = defs.filter(def => importedFiles.has(def.filePath));
  if (importedMatches.length !== 1) return null;
  return { modelClassId: importedMatches[0].nodeId, confidence: 0.95 };
};

const isResourceRelevantFile = (filePath: string, content: string): boolean => {
  const lang = getLanguageFromFilename(filePath);
  if (lang !== SupportedLanguages.PHP) return false;
  if (!filePath.includes('/Http/Resources/')) return false;
  return /\bwhenLoaded\s*\(/.test(content);
};

export const processLaravelResourceContracts = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
): Promise<{ edgesAdded: number }> => {
  const relationshipIndex = buildRelationshipMethodIndex(graph);
  if (relationshipIndex.size === 0) return { edgesAdded: 0 };

  const parser = await loadParser();
  let edgesAdded = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 400 === 0) await yieldToEventLoop();

    if (!isResourceRelevantFile(file.path, file.content)) continue;

    await loadLanguage(SupportedLanguages.PHP, file.path);

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

    const classDecl = (() => {
      let found: any | null = null;
      walkNodes(tree.rootNode, (node: any) => {
        if (found) return;
        if (node.type === 'class_declaration') found = node;
      });
      return found;
    })();

    const classNameNode = classDecl?.childForFieldName?.('name');
    const resourceClassName = String(classNameNode?.text || '').trim();
    if (!resourceClassName) continue;

    const resourceClassId = symbolTable.lookupExact(file.path, resourceClassName)
      || generateId('Class', `${file.path}:${resourceClassName}`);

    const resolvedModel = resolveModelClassForResource(resourceClassName, file.path, symbolTable, importMap);
    if (!resolvedModel || resolvedModel.confidence < 0.9) continue;

    const whenLoadedCalls: any[] = [];
    walkNodes(tree.rootNode, (node: any) => {
      if (node.type !== 'member_call_expression' && node.type !== 'nullsafe_member_call_expression') return;
      const method = String(node.childForFieldName?.('name')?.text || '').trim();
      if (method !== 'whenLoaded') return;
      whenLoadedCalls.push(node);
    });
    if (whenLoadedCalls.length === 0) continue;

    for (const call of whenLoadedCalls) {
      const argsNode = call.childForFieldName?.('arguments');
      const args = getCallArgumentExpressions(argsNode);
      const first = args.at(0);
      if (!first) continue;

      const spec = parsePhpStringLiteral(peelExpression(first));
      if (!spec) continue;

      const normalized = normalizeRelationPath(spec);
      if (!normalized) continue;

      let currentModelId = resolvedModel.modelClassId;
      const traversed: string[] = [];

      for (const seg of normalized.segments) {
        const rels = relationshipIndex.get(currentModelId);
        const target = rels?.get(seg);
        if (!target) break;
        if (target === null) break;

        traversed.push(seg);
        const pathSoFar = traversed.join('.');
        const reason = `laravel-resource-requires:${pathSoFar}`;
        const confidence = Math.min(resolvedModel.confidence, target.confidence, 0.95);
        if (confidence < 0.9) break;

        const relId = generateId('CALLS', `${resourceClassId}:${reason}->${target.methodNodeId}`);
        graph.addRelationship({
          id: relId,
          type: 'CALLS',
          sourceId: resourceClassId,
          targetId: target.methodNodeId,
          confidence,
          reason,
        });
        edgesAdded++;

        currentModelId = target.targetModelClassId;
      }
    }
  }

  return { edgesAdded };
};

