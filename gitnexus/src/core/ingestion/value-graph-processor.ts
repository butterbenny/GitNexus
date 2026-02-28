import { generateId } from '../../lib/utils.js';
import { GraphNode, GraphRelationship, KnowledgeGraph } from '../graph/types.js';

export interface ValueGraphNode {
  id: string;
  label: string;
  heuristicLabel: string;
  valueType: string;
  valueKey: string;
  valueRaw: string;
}

export interface ValueGraphResult {
  values: ValueGraphNode[];
  edges: GraphRelationship[];
  stats: {
    valueCount: number;
    edgeCount: number;
    permissionValues: number;
    endpointValues: number;
    routeNameValues: number;
    cacheKeyValues: number;
    skippedDuplicates: number;
    skippedMalformed: number;
  };
}

const normalizeValue = (value: string): string => String(value || '').trim();

const normalizeKey = (value: string): string => {
  return normalizeValue(value)
    .toLowerCase()
    .replace(/\\+/g, '/')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9:._\-/]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160);
};

const parsePermissionSlug = (node: GraphNode): string | null => {
  const id = String(node.id || '');
  if (id.startsWith('CodeElement:permission:')) {
    return normalizeValue(id.slice('CodeElement:permission:'.length)) || null;
  }

  const name = String(node.properties?.name || '').trim();
  if (name.startsWith('permission:')) {
    return normalizeValue(name.slice('permission:'.length)) || null;
  }

  return null;
};

const parseEndpointSignature = (node: GraphNode): string | null => {
  const name = String(node.properties?.name || '').trim();
  if (name.startsWith('endpoint:')) {
    return normalizeValue(name.slice('endpoint:'.length)) || null;
  }

  const id = String(node.id || '');
  if (id.startsWith('CodeElement:endpoint:')) {
    return normalizeValue(id.slice('CodeElement:endpoint:'.length)) || null;
  }

  return null;
};

const parseRouteNameFromReason = (reason: string): string | null => {
  const match = /^route-name:([^:]+):/.exec(String(reason || '').trim());
  if (!match) return null;
  return normalizeValue(match[1] || '') || null;
};

const addUnique = <T>(map: Map<string, T>, key: string, value: T): T => {
  const existing = map.get(key);
  if (existing) return existing;
  map.set(key, value);
  return value;
};

export const processValueGraph = async (
  knowledgeGraph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void,
): Promise<ValueGraphResult> => {
  onProgress?.('Collecting literal-value signals...', 10);

  const nodeById = new Map<string, GraphNode>();
  for (const node of knowledgeGraph.nodes) {
    nodeById.set(node.id, node);
  }

  const existingEdgePairs = new Set(
    knowledgeGraph.relationships.map(rel => `${rel.type}|${rel.sourceId}|${rel.targetId}`),
  );
  const emittedEdgePairs = new Set<string>();
  const skipped = { duplicates: 0, malformed: 0 };

  const valuesByComposite = new Map<string, ValueGraphNode>();
  const edges: GraphRelationship[] = [];
  let permissionValues = 0;
  let endpointValues = 0;
  let routeNameValues = 0;
  let cacheKeyValues = 0;

  const addValueNode = (valueType: string, rawValue: string): ValueGraphNode | null => {
    const valueRaw = normalizeValue(rawValue);
    if (!valueRaw) {
      skipped.malformed++;
      return null;
    }

    const valueKey = normalizeKey(valueRaw);
    if (!valueKey) {
      skipped.malformed++;
      return null;
    }

    const composite = `${valueType}:${valueKey}`;
    return addUnique(valuesByComposite, composite, {
      id: generateId('ValueNode', composite),
      label: `Value ${valueType.replace(/_/g, ' ')}: ${valueRaw}`,
      heuristicLabel: `Value ${valueType.replace(/_/g, ' ')}: ${valueRaw}`,
      valueType,
      valueKey,
      valueRaw,
    });
  };

  const addEdge = (sourceId: string, valueNode: ValueGraphNode, confidence: number, reason: string): void => {
    if (!sourceId || !valueNode?.id || sourceId === valueNode.id) {
      skipped.malformed++;
      return;
    }
    if (!nodeById.has(sourceId)) {
      skipped.malformed++;
      return;
    }

    const pair = `DEFINES|${sourceId}|${valueNode.id}`;
    if (existingEdgePairs.has(pair) || emittedEdgePairs.has(pair)) {
      skipped.duplicates++;
      return;
    }
    emittedEdgePairs.add(pair);

    edges.push({
      id: generateId('DEFINES', `${sourceId}->${valueNode.id}:${reason}`),
      type: 'DEFINES',
      sourceId,
      targetId: valueNode.id,
      confidence: Math.max(0.6, Math.min(1.0, Number(confidence) || 0.85)),
      reason,
    });
  };

  for (const node of knowledgeGraph.nodes) {
    if (node.label === 'CodeElement') {
      const permissionSlug = parsePermissionSlug(node);
      if (permissionSlug) {
        const valueNode = addValueNode('permission_slug', permissionSlug);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.98, 'value-graph:permission_slug');
        }
      }

      const endpointSignature = parseEndpointSignature(node);
      if (endpointSignature) {
        const valueNode = addValueNode('endpoint_signature', endpointSignature);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.98, 'value-graph:endpoint_signature');
        }
      }
    }

    if (node.label === 'CacheKey') {
      const keyName = String((node.properties as any)?.keyName || node.properties?.name || '').trim();
      if (!keyName) continue;
      const valueNode = addValueNode('cache_key', keyName);
      if (!valueNode) continue;
      addEdge(node.id, valueNode, 0.99, 'value-graph:cache_key');
    }
  }

  onProgress?.('Extracting route-name literal graph...', 55);

  for (const rel of knowledgeGraph.relationships) {
    if (rel.type !== 'CALLS') continue;
    const routeName = parseRouteNameFromReason(rel.reason || '');
    if (!routeName) continue;

    const valueNode = addValueNode('route_name', routeName);
    if (!valueNode) continue;
    addEdge(rel.sourceId, valueNode, rel.confidence || 0.9, 'value-graph:route_name');
  }

  const values = Array.from(valuesByComposite.values());
  for (const valueNode of values) {
    if (valueNode.valueType === 'permission_slug') permissionValues++;
    if (valueNode.valueType === 'endpoint_signature') endpointValues++;
    if (valueNode.valueType === 'route_name') routeNameValues++;
    if (valueNode.valueType === 'cache_key') cacheKeyValues++;
  }

  onProgress?.('ValueGraph materialization complete.', 100);

  return {
    values,
    edges,
    stats: {
      valueCount: values.length,
      edgeCount: edges.length,
      permissionValues,
      endpointValues,
      routeNameValues,
      cacheKeyValues,
      skippedDuplicates: skipped.duplicates,
      skippedMalformed: skipped.malformed,
    },
  };
};
