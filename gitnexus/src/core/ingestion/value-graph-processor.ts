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
    roleValues: number;
    featureFlagValues: number;
    configKeyValues: number;
    envVarValues: number;
    queueNameValues: number;
    broadcastChannelValues: number;
    eventNameValues: number;
    commandNameValues: number;
    i18nKeyValues: number;
    queryKeyFamilyValues: number;
    routeSegmentValues: number;
    tableNameValues: number;
    tableColumnValues: number;
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

const parseRoleSlug = (node: GraphNode): string | null => {
  const name = String(node.properties?.name || '').trim();
  if (name.startsWith('role:')) {
    return normalizeValue(name.slice('role:'.length)) || null;
  }

  const id = String(node.id || '');
  const marker = ':role:';
  const markerIndex = id.lastIndexOf(marker);
  if (markerIndex >= 0) {
    return normalizeValue(id.slice(markerIndex + marker.length)) || null;
  }

  return null;
};

const parsePrefixedName = (node: GraphNode, prefixes: string[]): string | null => {
  const name = String(node.properties?.name || '').trim();
  if (!name) return null;
  const lowered = name.toLowerCase();

  for (const prefix of prefixes) {
    const token = `${prefix.toLowerCase()}:`;
    if (!lowered.startsWith(token)) continue;
    const value = normalizeValue(name.slice(token.length));
    if (value) return value;
  }

  return null;
};

const parseClassNameByPath = (node: GraphNode, pathRe: RegExp): string | null => {
  if (node.label !== 'Class') return null;
  const filePath = String(node.properties?.filePath || '').trim();
  if (!pathRe.test(filePath)) return null;
  return normalizeValue(String(node.properties?.name || '')) || null;
};

const parseQueryKeyFamily = (cacheKey: string): string | null => {
  const normalized = normalizeValue(cacheKey);
  if (!normalized) return null;

  const bracketArrayMatch = /^\[\s*['"]([^'"]+)['"]/.exec(normalized);
  if (bracketArrayMatch?.[1]) {
    return normalizeValue(bracketArrayMatch[1]) || null;
  }

  const firstToken = normalized.split(/[.\[/:(\s]+/).find(Boolean) || '';
  return normalizeValue(firstToken) || null;
};

const parseRouteSegment = (routeName: string): string | null => {
  const normalized = normalizeValue(routeName);
  if (!normalized) return null;
  const firstSegment = normalized.split(/[./:\s]+/).find(Boolean) || '';
  return normalizeValue(firstSegment) || null;
};

const parseTableName = (node: GraphNode): string | null => {
  const fromProps = normalizeValue(String((node.properties as any)?.tableName || ''));
  if (fromProps) return fromProps;

  const name = String(node.properties?.name || '').trim();
  const match = /^DB Table:\s*(.+)$/i.exec(name);
  if (!match?.[1]) return null;
  return normalizeValue(match[1]) || null;
};

const parseTableColumn = (node: GraphNode): string | null => {
  const tableName = normalizeValue(String((node.properties as any)?.tableName || ''));
  const columnName = normalizeValue(String((node.properties as any)?.columnName || ''));
  if (!columnName) return null;
  if (!tableName) return columnName;
  return `${tableName}.${columnName}`;
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
  let roleValues = 0;
  let featureFlagValues = 0;
  let configKeyValues = 0;
  let envVarValues = 0;
  let queueNameValues = 0;
  let broadcastChannelValues = 0;
  let eventNameValues = 0;
  let commandNameValues = 0;
  let i18nKeyValues = 0;
  let queryKeyFamilyValues = 0;
  let routeSegmentValues = 0;
  let tableNameValues = 0;
  let tableColumnValues = 0;

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

      const roleSlug = parseRoleSlug(node);
      if (roleSlug) {
        const valueNode = addValueNode('role_slug', roleSlug);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.98, 'value-graph:role_slug');
        }
      }

      const featureFlag = parsePrefixedName(node, ['feature', 'flag']);
      if (featureFlag) {
        const valueNode = addValueNode('feature_flag', featureFlag);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.95, 'value-graph:feature_flag');
        }
      }

      const configKey = parsePrefixedName(node, ['config']);
      if (configKey) {
        const valueNode = addValueNode('config_key', configKey);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.95, 'value-graph:config_key');
        }
      }

      const envVar = parsePrefixedName(node, ['env']);
      if (envVar) {
        const valueNode = addValueNode('env_var', envVar);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.95, 'value-graph:env_var');
        }
      }

      const queueName = parsePrefixedName(node, ['queue']);
      if (queueName) {
        const valueNode = addValueNode('queue_name', queueName);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.95, 'value-graph:queue_name');
        }
      }

      const broadcastChannel = parsePrefixedName(node, ['broadcast', 'channel']);
      if (broadcastChannel) {
        const valueNode = addValueNode('broadcast_channel', broadcastChannel);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.95, 'value-graph:broadcast_channel');
        }
      }

      const eventName = parsePrefixedName(node, ['event']);
      if (eventName) {
        const valueNode = addValueNode('event_name', eventName);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.95, 'value-graph:event_name');
        }
      }

      const commandName = parsePrefixedName(node, ['command']);
      if (commandName) {
        const valueNode = addValueNode('command_name', commandName);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.95, 'value-graph:command_name');
        }
      }

      const i18nKey = parsePrefixedName(node, ['i18n', 'trans', 'lang']);
      if (i18nKey) {
        const valueNode = addValueNode('i18n_key', i18nKey);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.95, 'value-graph:i18n_key');
        }
      }
    }

    if (node.label === 'Class') {
      const eventName = parseClassNameByPath(node, /(^|\/)events\//i);
      if (eventName) {
        const valueNode = addValueNode('event_name', eventName);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.93, 'value-graph:event_name');
        }
      }

      const commandName = parseClassNameByPath(node, /(^|\/)console\/commands\//i);
      if (commandName) {
        const valueNode = addValueNode('command_name', commandName);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.93, 'value-graph:command_name');
        }
      }

      const queueName = parseClassNameByPath(node, /(^|\/)jobs\//i);
      if (queueName) {
        const valueNode = addValueNode('queue_name', queueName);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.92, 'value-graph:queue_name');
        }
      }

      const broadcastChannel = parseClassNameByPath(node, /(^|\/)broadcast(?:ing)?\//i);
      if (broadcastChannel) {
        const valueNode = addValueNode('broadcast_channel', broadcastChannel);
        if (valueNode) {
          addEdge(node.id, valueNode, 0.92, 'value-graph:broadcast_channel');
        }
      }
    }

    if (node.label === 'CacheKey') {
      const keyName = String((node.properties as any)?.keyName || node.properties?.name || '').trim();
      if (!keyName) continue;
      const valueNode = addValueNode('cache_key', keyName);
      if (!valueNode) continue;
      addEdge(node.id, valueNode, 0.99, 'value-graph:cache_key');

      const family = parseQueryKeyFamily(keyName);
      if (!family) continue;
      const familyNode = addValueNode('query_key_family', family);
      if (!familyNode) continue;
      addEdge(node.id, familyNode, 0.97, 'value-graph:query_key_family');
    }

    if (node.label === 'DBTable') {
      const tableName = parseTableName(node);
      if (!tableName) continue;
      const valueNode = addValueNode('table_name', tableName);
      if (!valueNode) continue;
      addEdge(node.id, valueNode, 0.99, 'value-graph:table_name');
    }

    if (node.label === 'DBColumn') {
      const tableColumn = parseTableColumn(node);
      if (!tableColumn) continue;
      const valueNode = addValueNode('table_column', tableColumn);
      if (!valueNode) continue;
      addEdge(node.id, valueNode, 0.99, 'value-graph:table_column');
    }
  }

  onProgress?.('Extracting route-name and segment literal graph...', 55);

  for (const rel of knowledgeGraph.relationships) {
    if (rel.type !== 'CALLS') continue;
    const routeName = parseRouteNameFromReason(rel.reason || '');
    if (!routeName) continue;

    const valueNode = addValueNode('route_name', routeName);
    if (!valueNode) continue;
    addEdge(rel.sourceId, valueNode, rel.confidence || 0.9, 'value-graph:route_name');

    const routeSegment = parseRouteSegment(routeName);
    if (!routeSegment) continue;
    const segmentNode = addValueNode('route_segment', routeSegment);
    if (!segmentNode) continue;
    addEdge(rel.sourceId, segmentNode, rel.confidence || 0.9, 'value-graph:route_segment');
  }

  const values = Array.from(valuesByComposite.values());
  for (const valueNode of values) {
    if (valueNode.valueType === 'permission_slug') permissionValues++;
    if (valueNode.valueType === 'endpoint_signature') endpointValues++;
    if (valueNode.valueType === 'route_name') routeNameValues++;
    if (valueNode.valueType === 'cache_key') cacheKeyValues++;
    if (valueNode.valueType === 'role_slug') roleValues++;
    if (valueNode.valueType === 'feature_flag') featureFlagValues++;
    if (valueNode.valueType === 'config_key') configKeyValues++;
    if (valueNode.valueType === 'env_var') envVarValues++;
    if (valueNode.valueType === 'queue_name') queueNameValues++;
    if (valueNode.valueType === 'broadcast_channel') broadcastChannelValues++;
    if (valueNode.valueType === 'event_name') eventNameValues++;
    if (valueNode.valueType === 'command_name') commandNameValues++;
    if (valueNode.valueType === 'i18n_key') i18nKeyValues++;
    if (valueNode.valueType === 'query_key_family') queryKeyFamilyValues++;
    if (valueNode.valueType === 'route_segment') routeSegmentValues++;
    if (valueNode.valueType === 'table_name') tableNameValues++;
    if (valueNode.valueType === 'table_column') tableColumnValues++;
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
      roleValues,
      featureFlagValues,
      configKeyValues,
      envVarValues,
      queueNameValues,
      broadcastChannelValues,
      eventNameValues,
      commandNameValues,
      i18nKeyValues,
      queryKeyFamilyValues,
      routeSegmentValues,
      tableNameValues,
      tableColumnValues,
      skippedDuplicates: skipped.duplicates,
      skippedMalformed: skipped.malformed,
    },
  };
};
