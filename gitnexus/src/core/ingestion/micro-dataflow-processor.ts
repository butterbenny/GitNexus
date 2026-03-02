import { generateId } from '../../lib/utils.js';
import { GraphNode, GraphRelationship, KnowledgeGraph, RelationshipType } from '../graph/types.js';

type MethodFieldLinkKind = 'request' | 'response';

interface MethodFieldLink {
  fieldId: string;
  kind: MethodFieldLinkKind;
  confidence: number;
}

export interface MicroDataflowResult {
  edges: GraphRelationship[];
  stats: {
    emittedEdges: number;
    requestFieldReads: number;
    responseFieldWrites: number;
    endpointRequestClosures: number;
    endpointResponseClosures: number;
    queryInvalidationClosures: number;
    endpointEventClosures: number;
    endpointPermissionClosures: number;
    skippedDuplicates: number;
    skippedMalformed: number;
  };
}

const sanitizeReasonSegment = (value: string): string => {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
};

const clampConfidence = (value: number, cap = 0.95): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.8;
  return Number(Math.max(0.7, Math.min(cap, n)).toFixed(3));
};

const mergeConfidence = (values: number[], cap = 0.95): number => {
  const finite = values.filter(v => Number.isFinite(v));
  if (finite.length === 0) return clampConfidence(0.8, cap);
  const min = Math.min(...finite);
  return clampConfidence(min, cap);
};

const isEndpointReason = (reason: string): boolean => {
  return String(reason || '').startsWith('laravel-endpoint:');
};

const isRequestParamReason = (reason: string): boolean => {
  return String(reason || '').startsWith('laravel-form-request:');
};

const isResourceReturnReason = (reason: string): boolean => {
  return String(reason || '').startsWith('laravel-resource:');
};

const isEventDispatchReason = (reason: string): boolean => {
  const value = String(reason || '');
  return (
    value.startsWith('laravel-event-dispatch') ||
    value.startsWith('laravel-notify') ||
    value.startsWith('laravel-job-dispatch') ||
    value.startsWith('laravel-tactician-dispatch') ||
    value.startsWith('laravel-tactician-pipeline')
  );
};

const isPermissionNode = (node: GraphNode | undefined): boolean => {
  if (!node || node.label !== 'CodeElement') return false;
  const id = String(node.id || '').toLowerCase();
  const name = String(node.properties?.name || '').toLowerCase();
  return id.includes(':permission:') || name.startsWith('permission:');
};

const pushMapList = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const list = map.get(key);
  if (list) {
    list.push(value);
    return;
  }
  map.set(key, [value]);
};

const addMethodFieldLink = (
  map: Map<string, MethodFieldLink[]>,
  methodId: string,
  link: MethodFieldLink,
): void => {
  const existing = map.get(methodId) || [];
  const duplicate = existing.some(item => item.fieldId === link.fieldId && item.kind === link.kind);
  if (!duplicate) {
    existing.push(link);
    map.set(methodId, existing);
  }
};

export const processMicroDataflow = async (
  knowledgeGraph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void,
): Promise<MicroDataflowResult> => {
  onProgress?.('Building micro-dataflow indexes...', 10);

  const nodeById = new Map(knowledgeGraph.nodes.map(node => [node.id, node]));
  const outgoing = new Map<string, GraphRelationship[]>();
  const incoming = new Map<string, GraphRelationship[]>();

  for (const relationship of knowledgeGraph.relationships) {
    pushMapList(outgoing, relationship.sourceId, relationship);
    pushMapList(incoming, relationship.targetId, relationship);
  }

  const existingPairKeys = new Set(
    knowledgeGraph.relationships.map(rel => `${rel.type}|${rel.sourceId}|${rel.targetId}`),
  );
  const emittedPairKeys = new Set<string>();
  const emittedEdges: GraphRelationship[] = [];

  let skippedDuplicates = 0;
  let skippedMalformed = 0;

  const addEdge = (
    type: RelationshipType,
    sourceId: string,
    targetId: string,
    confidence: number,
    reason: string,
  ): boolean => {
    if (!sourceId || !targetId || sourceId === targetId) {
      skippedMalformed++;
      return false;
    }
    if (!nodeById.has(sourceId) || !nodeById.has(targetId)) {
      skippedMalformed++;
      return false;
    }

    const pairKey = `${type}|${sourceId}|${targetId}`;
    if (existingPairKeys.has(pairKey) || emittedPairKeys.has(pairKey)) {
      skippedDuplicates++;
      return false;
    }

    emittedPairKeys.add(pairKey);
    emittedEdges.push({
      id: generateId(type, `micro-dataflow:${sourceId}->${targetId}:${reason}`),
      type,
      sourceId,
      targetId,
      confidence: clampConfidence(confidence, type === 'CALLS' ? 0.9 : 0.95),
      reason,
    });
    return true;
  };

  const methodFieldLinks = new Map<string, MethodFieldLink[]>();

  for (const relationship of knowledgeGraph.relationships) {
    if (
      relationship.type !== 'READS_FIELD'
      && relationship.type !== 'WRITES_FIELD'
      && relationship.type !== 'VALIDATES_FIELD'
    ) continue;
    const sourceNode = nodeById.get(relationship.sourceId);
    const targetNode = nodeById.get(relationship.targetId);
    if (!sourceNode || !targetNode) continue;
    if (sourceNode.label !== 'Method' || targetNode.label !== 'ContractField') continue;

    addMethodFieldLink(methodFieldLinks, sourceNode.id, {
      fieldId: targetNode.id,
      kind: relationship.type === 'WRITES_FIELD' ? 'response' : 'request',
      confidence: relationship.confidence,
    });
  }

  let requestFieldReads = 0;
  let responseFieldWrites = 0;

  onProgress?.('Materializing request/resource field traces...', 30);

  for (const relationship of knowledgeGraph.relationships) {
    if (relationship.type !== 'CALLS') continue;

    const sourceNode = nodeById.get(relationship.sourceId);
    const targetNode = nodeById.get(relationship.targetId);
    if (!sourceNode || !targetNode) continue;
    if (sourceNode.label !== 'Method' || targetNode.label !== 'Class') continue;

    if (isRequestParamReason(relationship.reason)) {
      const validated = (outgoing.get(targetNode.id) || []).filter(edge => edge.type === 'VALIDATES_FIELD');
      for (const validationEdge of validated) {
        const fieldNode = nodeById.get(validationEdge.targetId);
        if (!fieldNode || fieldNode.label !== 'ContractField') continue;

        const confidence = mergeConfidence([relationship.confidence, validationEdge.confidence], 0.93);
        const added = addEdge(
          'READS_FIELD',
          sourceNode.id,
          fieldNode.id,
          confidence,
          'micro-dataflow:request:validated-field',
        );
        addMethodFieldLink(methodFieldLinks, sourceNode.id, {
          fieldId: fieldNode.id,
          kind: 'request',
          confidence,
        });
        if (added) requestFieldReads++;
      }
    }

    if (isResourceReturnReason(relationship.reason)) {
      const serialized = (outgoing.get(targetNode.id) || []).filter(edge => edge.type === 'SERIALIZES_FIELD');
      for (const serializationEdge of serialized) {
        const fieldNode = nodeById.get(serializationEdge.targetId);
        if (!fieldNode || fieldNode.label !== 'ContractField') continue;

        const confidence = mergeConfidence([relationship.confidence, serializationEdge.confidence], 0.93);
        const added = addEdge(
          'WRITES_FIELD',
          sourceNode.id,
          fieldNode.id,
          confidence,
          'micro-dataflow:response:serialized-field',
        );
        addMethodFieldLink(methodFieldLinks, sourceNode.id, {
          fieldId: fieldNode.id,
          kind: 'response',
          confidence,
        });
        if (added) responseFieldWrites++;
      }
    }
  }

  let endpointRequestClosures = 0;
  let endpointResponseClosures = 0;
  let endpointEventClosures = 0;
  let endpointPermissionClosures = 0;

  onProgress?.('Materializing endpoint closures...', 60);

  for (const endpointEdge of knowledgeGraph.relationships) {
    if (endpointEdge.type !== 'CALLS' || !isEndpointReason(endpointEdge.reason)) continue;

    const endpointNode = nodeById.get(endpointEdge.sourceId);
    const handlerNode = nodeById.get(endpointEdge.targetId);
    if (!endpointNode || !handlerNode) continue;
    if (endpointNode.label !== 'CodeElement' || handlerNode.label !== 'Method') continue;

    const fieldLinks = methodFieldLinks.get(handlerNode.id) || [];
    for (const link of fieldLinks) {
      const reason = link.kind === 'request'
        ? 'micro-dataflow:endpoint:request-field-closure'
        : 'micro-dataflow:endpoint:response-field-closure';
      const added = addEdge(
        'WRITES_FIELD',
        endpointNode.id,
        link.fieldId,
        mergeConfidence([endpointEdge.confidence, link.confidence], 0.9),
        reason,
      );
      if (!added) continue;
      if (link.kind === 'request') endpointRequestClosures++;
      else endpointResponseClosures++;
    }

    const handlerOutgoing = outgoing.get(handlerNode.id) || [];
    for (const handlerEdge of handlerOutgoing) {
      if (handlerEdge.type !== 'CALLS') continue;
      const targetNode = nodeById.get(handlerEdge.targetId);
      if (!targetNode) continue;

      if (isEventDispatchReason(handlerEdge.reason)) {
        const eventKind = sanitizeReasonSegment(handlerEdge.reason.split(':')[0] || 'event-chain');
        const added = addEdge(
          'CALLS',
          endpointNode.id,
          targetNode.id,
          mergeConfidence([endpointEdge.confidence, handlerEdge.confidence], 0.9),
          `micro-dataflow:event-chain:${eventKind || 'dispatch'}`,
        );
        if (added) endpointEventClosures++;
      }

      if (isPermissionNode(targetNode)) {
        const added = addEdge(
          'CALLS',
          endpointNode.id,
          targetNode.id,
          mergeConfidence([endpointEdge.confidence, handlerEdge.confidence], 0.9),
          'micro-dataflow:permission-closure',
        );
        if (added) endpointPermissionClosures++;
      }
    }
  }

  onProgress?.('Materializing query invalidation traces...', 80);

  type SourceWithConfidence = { sourceId: string; confidence: number };
  const consumersByCacheKey = new Map<string, SourceWithConfidence[]>();
  const invalidatorsByCacheKey = new Map<string, SourceWithConfidence[]>();

  const keyFactoryByCacheKey = new Map<string, string[]>();
  for (const relationship of knowledgeGraph.relationships) {
    if (relationship.type !== 'DEFINES') continue;
    const sourceNode = nodeById.get(relationship.sourceId);
    const targetNode = nodeById.get(relationship.targetId);
    if (!sourceNode || !targetNode) continue;
    if (sourceNode.label !== 'Function' || targetNode.label !== 'CacheKey') continue;
    pushMapList(keyFactoryByCacheKey, targetNode.id, sourceNode.id);
  }

  for (const [cacheKeyId, factoryIds] of keyFactoryByCacheKey) {
    for (const factoryId of factoryIds) {
      const incomingCalls = incoming.get(factoryId) || [];
      for (const callEdge of incomingCalls) {
        if (callEdge.type !== 'CALLS') continue;
        if (!String(callEdge.reason || '').startsWith('react-query-key:query-key-usage')) continue;
        pushMapList(consumersByCacheKey, cacheKeyId, {
          sourceId: callEdge.sourceId,
          confidence: callEdge.confidence,
        });
      }
    }
  }

  for (const relationship of knowledgeGraph.relationships) {
    if (relationship.type !== 'INVALIDATES_KEY') continue;
    const targetNode = nodeById.get(relationship.targetId);
    if (!targetNode || targetNode.label !== 'CacheKey') continue;
    pushMapList(invalidatorsByCacheKey, relationship.targetId, {
      sourceId: relationship.sourceId,
      confidence: relationship.confidence,
    });
  }

  let queryInvalidationClosures = 0;
  const MAX_COMBINATIONS_PER_CACHE_KEY = 48;

  for (const [cacheKeyId, invalidators] of invalidatorsByCacheKey) {
    const consumers = consumersByCacheKey.get(cacheKeyId) || [];
    if (consumers.length === 0 || invalidators.length === 0) continue;

    const cacheKeyNode = nodeById.get(cacheKeyId);
    const cacheKeyName = sanitizeReasonSegment(
      String(cacheKeyNode?.properties?.name || cacheKeyNode?.properties?.keyName || cacheKeyId),
    ) || 'cache-key';

    const uniqueInvalidators = Array.from(
      new Map(invalidators.map(item => [item.sourceId, item])).values(),
    );
    const uniqueConsumers = Array.from(
      new Map(consumers.map(item => [item.sourceId, item])).values(),
    );

    let emittedForKey = 0;
    for (const invalidator of uniqueInvalidators) {
      for (const consumer of uniqueConsumers) {
        if (invalidator.sourceId === consumer.sourceId) continue;
        if (emittedForKey >= MAX_COMBINATIONS_PER_CACHE_KEY) break;

        const added = addEdge(
          'CALLS',
          invalidator.sourceId,
          consumer.sourceId,
          mergeConfidence([invalidator.confidence, consumer.confidence], 0.88),
          `micro-dataflow:query-key-invalidation:${cacheKeyName}`,
        );
        if (added) {
          queryInvalidationClosures++;
          emittedForKey++;
        }
      }
      if (emittedForKey >= MAX_COMBINATIONS_PER_CACHE_KEY) break;
    }
  }

  onProgress?.('Micro-dataflow extraction complete.', 100);

  return {
    edges: emittedEdges,
    stats: {
      emittedEdges: emittedEdges.length,
      requestFieldReads,
      responseFieldWrites,
      endpointRequestClosures,
      endpointResponseClosures,
      queryInvalidationClosures,
      endpointEventClosures,
      endpointPermissionClosures,
      skippedDuplicates,
      skippedMalformed,
    },
  };
};
