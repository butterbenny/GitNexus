import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { ImportMap } from './import-processor.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, getParseableContent, yieldToEventLoop } from './utils.js';
import { loadLanguage, loadParser } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';

type ResolvedFunction = {
  nodeId: string;
  confidence: number;
  reason: string;
};

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const QUERY_KEYS_HINT_RE = /queryKeys/i;
const REACT_QUERY_HOOK_RE = /\buse(Query|InfiniteQuery|SuspenseQuery|SuspenseInfiniteQuery)\b/;

const REACT_QUERY_HOOK_NAMES = new Set([
  'useQuery',
  'useInfiniteQuery',
  'useSuspenseQuery',
  'useSuspenseInfiniteQuery',
]);

const looksLikeIdentifier = (value: string): boolean => IDENTIFIER_RE.test(value);

const isReactQueryRelevantFile = (filePath: string, content: string): boolean => {
  const lang = getLanguageFromFilename(filePath);
  if (lang !== SupportedLanguages.TypeScript && lang !== SupportedLanguages.JavaScript) return false;
  return REACT_QUERY_HOOK_RE.test(content);
};

const isQueryKeysDefinitionFile = (filePath: string, content: string): boolean => {
  const lang = getLanguageFromFilename(filePath);
  if (lang !== SupportedLanguages.TypeScript && lang !== SupportedLanguages.JavaScript) return false;
  return QUERY_KEYS_HINT_RE.test(content);
};

const walkNodes = (node: any, fn: (n: any) => void) => {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    fn(current);
    for (let i = current.namedChildCount - 1; i >= 0; i--) {
      stack.push(current.namedChild(i));
    }
  }
};

const getDescendantsOfType = (node: any, type: string): any[] => {
  if (!node) return [];

  const descendantsOfType = node.descendantsOfType;
  if (typeof descendantsOfType === 'function') {
    try {
      return descendantsOfType.call(node, type) ?? [];
    } catch {
      // fall through to manual walk
    }
  }

  const nodes: any[] = [];
  walkNodes(node, (n: any) => {
    if (n?.type === type) nodes.push(n);
  });
  return nodes;
};

const getDescendantsOfTypeIncludingSelf = (node: any, type: string): any[] => {
  const nodes = getDescendantsOfType(node, type);
  if (!node || node.type !== type) return nodes;

  const first = nodes[0];
  if (!first || first.startIndex !== node.startIndex || first.endIndex !== node.endIndex) {
    nodes.unshift(node);
  }
  return nodes;
};

const getCallCalleeName = (callNode: any): string | null => {
  if (!callNode || callNode.type !== 'call_expression') return null;
  const fnNode = callNode.childForFieldName?.('function');
  if (!fnNode) return null;

  if (fnNode.type === 'identifier') return fnNode.text ?? null;

  if (fnNode.type === 'member_expression') {
    const prop = fnNode.childForFieldName?.('property');
    if (prop?.type === 'property_identifier') return prop.text ?? null;
  }

  return null;
};

const getObjectPropertyValueNode = (node: any, propName: string): any | null => {
  if (!node || node.type !== 'object') return null;

  for (const child of node.namedChildren || []) {
    if (child.type !== 'pair') continue;
    const [keyNode, valueNode] = child.namedChildren || [];
    if (!keyNode || !valueNode) continue;

    const key = (keyNode.type === 'property_identifier' || keyNode.type === 'identifier')
      ? keyNode.text
      : null;

    if (key !== propName) continue;
    return valueNode;
  }

  return null;
};

const peelExpression = (node: any): any | null => {
  let current = node;
  while (current) {
    if (current.type === 'parenthesized_expression') {
      current = current.namedChildren?.at(0) || null;
      continue;
    }
    if (current.type === 'await_expression') {
      current = current.namedChildren?.at(0) || null;
      continue;
    }
    if (current.type === 'as_expression' || current.type === 'type_assertion' || current.type === 'satisfies_expression') {
      current = current.childForFieldName?.('expression') || current.namedChildren?.at(0) || null;
      continue;
    }
    return current;
  }
  return null;
};

const getIdentifierNameFromExpression = (node: any): string | null => {
  const expr = peelExpression(node);
  if (!expr) return null;

  if (expr.type === 'identifier') return expr.text ?? null;

  if (expr.type === 'call_expression') {
    const fnNode = expr.childForFieldName?.('function');
    if (fnNode?.type === 'identifier') return fnNode.text ?? null;
    return null;
  }

  if (expr.type === 'arrow_function') {
    const bodyNode = expr.childForFieldName?.('body') || expr.namedChildren?.at(-1) || null;
    const body = peelExpression(bodyNode);
    if (!body) return null;
    if (body.type === 'identifier') return body.text ?? null;
    if (body.type === 'call_expression') {
      const fnNode = body.childForFieldName?.('function');
      if (fnNode?.type === 'identifier') return fnNode.text ?? null;
    }
    return null;
  }

  return null;
};

const getObjectPairKeyName = (keyNode: any): string | null => {
  if (!keyNode) return null;
  if (keyNode.type === 'property_identifier' || keyNode.type === 'identifier') {
    return keyNode.text ?? null;
  }
  return null;
};

const resolveTsFunction = (
  name: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
): ResolvedFunction | null => {
  const defs = symbolTable
    .lookupFuzzy(name)
    .filter((def: SymbolDefinition) => def.type === 'Function');

  if (defs.length === 0) return null;

  const inFile = defs.filter(def => def.filePath === currentFilePath);
  if (inFile.length === 1) return { nodeId: inFile[0].nodeId, confidence: 1.0, reason: 'same-file' };
  if (inFile.length > 1) return null;

  const importedFiles = importMap.get(currentFilePath);
  if (importedFiles) {
    const importedMatches = defs.filter(def => importedFiles.has(def.filePath));
    if (importedMatches.length === 1) return { nodeId: importedMatches[0].nodeId, confidence: 0.95, reason: 'import-resolved' };
    if (importedMatches.length > 1) return null;
  }

  return null;
};

const indexReactQueryKeyFactories = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
): Promise<void> => {
  const parser = await loadParser();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 400 === 0) await yieldToEventLoop();

    if (!isQueryKeysDefinitionFile(file.path, file.content)) continue;

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

    const declarators = getDescendantsOfType(tree.rootNode, 'variable_declarator');
    for (const node of declarators) {
      const nameNode = node.childForFieldName?.('name');
      const objectName = nameNode?.type === 'identifier' ? String(nameNode.text || '') : '';
      if (!objectName || !looksLikeIdentifier(objectName) || !QUERY_KEYS_HINT_RE.test(objectName)) continue;

      const valueNodeRaw = node.childForFieldName?.('value');
      const valueNode = peelExpression(valueNodeRaw);
      if (!valueNode || valueNode.type !== 'object') continue;

      for (const child of valueNode.namedChildren || []) {
        if (child.type !== 'pair') continue;
        const [keyNode, propValueNodeRaw] = child.namedChildren || [];
        const propName = getObjectPairKeyName(keyNode);
        if (!propName || !looksLikeIdentifier(propName)) continue;

        const propValueNode = peelExpression(propValueNodeRaw);
        if (!propValueNode) continue;
        if (propValueNode.type !== 'arrow_function' && propValueNode.type !== 'function_expression') continue;

        const symbolName = `${objectName}.${propName}`;
        const nodeId = generateId('Function', `${file.path}:${symbolName}`);

        graph.addNode({
          id: nodeId,
          label: 'Function',
          properties: {
            name: symbolName,
            filePath: file.path,
            startLine: keyNode?.startPosition?.row,
            endLine: propValueNode?.endPosition?.row,
            language,
            isExported: false,
          },
        });

        const fileId = generateId('File', file.path);
        const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
        graph.addRelationship({
          id: relId,
          type: 'DEFINES',
          sourceId: fileId,
          targetId: nodeId,
          confidence: 1.0,
          reason: '',
        });

        symbolTable.add(file.path, symbolName, nodeId, 'Function');
      }
    }
  }
};

const extractQueryKeyFactoryCallNames = (node: any): string[] => {
  const names = new Set<string>();
  const root = peelExpression(node);
  if (!root) return [];

  const callNodes = getDescendantsOfTypeIncludingSelf(root, 'call_expression');
  for (const n of callNodes) {
    const fnNode = n.childForFieldName?.('function');
    if (!fnNode) continue;

    if (fnNode.type === 'identifier') {
      const text = fnNode.text ?? '';
      if (text) names.add(text);
      continue;
    }

    if (fnNode.type === 'member_expression') {
      const objNode = fnNode.childForFieldName?.('object');
      const propNode = fnNode.childForFieldName?.('property');
      const objName = objNode?.type === 'identifier' ? String(objNode.text || '') : '';
      const propName = propNode?.type === 'property_identifier' ? String(propNode.text || '') : '';
      if (!objName || !propName) continue;
      names.add(`${objName}.${propName}`);
    }
  }

  return Array.from(names);
};

export const processReactQueryKeyWiring = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  astCache: ASTCache,
  symbolTable: SymbolTable,
  importMap: ImportMap,
): Promise<{ edgesAdded: number }> => {
  await indexReactQueryKeyFactories(graph, files, astCache, symbolTable);

  const parser = await loadParser();
  let edgesAdded = 0;

  // Build a cheap lookup for high-confidence HTTP wiring edges so we can
  // derive one-hop queryKey → backend handler edges (without re-parsing).
  const httpEdgesBySource = new Map<string, Array<{ targetId: string; confidence: number; reason: string }>>();
  for (const rel of graph.relationships) {
    if (rel.type !== 'CALLS') continue;
    if (typeof rel.reason !== 'string' || !rel.reason.startsWith('http-')) continue;
    if ((rel.confidence ?? 0) < 0.9) continue;

    const list = httpEdgesBySource.get(rel.sourceId) ?? [];
    list.push({ targetId: rel.targetId, confidence: rel.confidence ?? 1.0, reason: rel.reason });
    httpEdgesBySource.set(rel.sourceId, list);
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i % 300 === 0) await yieldToEventLoop();

    if (!isReactQueryRelevantFile(file.path, file.content)) continue;

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

    const callNodes = getDescendantsOfType(tree.rootNode, 'call_expression');
    for (const callNode of callNodes) {
      const callee = getCallCalleeName(callNode);
      if (!callee || !REACT_QUERY_HOOK_NAMES.has(callee)) continue;

      const argsNode = callNode.childForFieldName?.('arguments');
      const argObject = argsNode?.namedChildren?.find((c: any) => c.type === 'object') || null;
      if (!argObject) continue;

      const queryKeyNode = getObjectPropertyValueNode(argObject, 'queryKey');
      const queryFnNode = getObjectPropertyValueNode(argObject, 'queryFn');
      if (!queryKeyNode || !queryFnNode) continue;

      const resolvedKeyFactories = extractQueryKeyFactoryCallNames(queryKeyNode)
        .map(name => resolveTsFunction(name, file.path, symbolTable, importMap))
        .filter((resolved): resolved is ResolvedFunction => Boolean(resolved) && resolved.confidence >= 0.9);
      const keyFactoryNodeIds = Array.from(new Set(resolvedKeyFactories.map(r => r.nodeId)));
      if (keyFactoryNodeIds.length !== 1) continue;

      const keyFactory = resolvedKeyFactories.find(r => r.nodeId === keyFactoryNodeIds[0]) || null;
      if (!keyFactory) continue;

      const queryFnName = getIdentifierNameFromExpression(queryFnNode);
      if (!queryFnName) continue;

      const queryFn = resolveTsFunction(queryFnName, file.path, symbolTable, importMap);
      if (!queryFn || queryFn.confidence < 0.9) continue;

      const keyToQueryFnConfidence = Math.min(keyFactory.confidence, queryFn.confidence);

      const reason = 'react-query:key-to-query-fn';
      const relId = generateId('CALLS', `${keyFactory.nodeId}:${reason}->${queryFn.nodeId}`);
      graph.addRelationship({
        id: relId,
        type: 'CALLS',
        sourceId: keyFactory.nodeId,
        targetId: queryFn.nodeId,
        confidence: keyToQueryFnConfidence,
        reason,
      });
      edgesAdded++;

      // Derived one-hop: queryKey → backend controller method (via queryFn HTTP edge)
      const httpEdges = httpEdgesBySource.get(queryFn.nodeId) || [];
      for (const edge of httpEdges) {
        const hopReason = `react-query:key-to-${edge.reason}`;
        const hopRelId = generateId('CALLS', `${keyFactory.nodeId}:${hopReason}->${edge.targetId}`);
        graph.addRelationship({
          id: hopRelId,
          type: 'CALLS',
          sourceId: keyFactory.nodeId,
          targetId: edge.targetId,
          confidence: Math.min(keyToQueryFnConfidence, edge.confidence),
          reason: hopReason,
        });
        edgesAdded++;
      }
    }
  }

  return { edgesAdded };
};
