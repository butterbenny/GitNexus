import { generateId } from '../../lib/utils.js';
import {
  buildArchetypeReport,
  deriveLayerTag,
  extractHttpEdgesFromGraph,
  extractProcessesFromGraph,
} from '../derived/archetypes.js';
import { GraphNode, GraphRelationship, KnowledgeGraph } from '../graph/types.js';

export type StructuredSummaryLevel =
  | 'symbol'
  | 'file'
  | 'slice'
  | 'community'
  | 'process'
  | 'archetype';

export interface StructuredSummaryContracts {
  auth: string[];
  cache: string[];
  shape: string[];
}

export interface StructuredSummaryEntry {
  id: string;
  level: StructuredSummaryLevel;
  entityId: string;
  name: string;
  label: string;
  filePath: string;
  responsibilities: string[];
  inboundCallers: string[];
  downstreamEffects: string[];
  contracts: StructuredSummaryContracts;
  companions: string[];
  siblingPrecedents: string[];
}

export interface StructuredSummaryOverlayStats {
  symbolCount: number;
  fileCount: number;
  sliceCount: number;
  communityCount: number;
  processCount: number;
  archetypeCount: number;
  truncated: {
    symbols: boolean;
    files: boolean;
    slices: boolean;
    communities: boolean;
    processes: boolean;
    archetypes: boolean;
  };
}

export interface StructuredSummaryOverlaySnapshot {
  version: 1;
  generatedAt: string;
  stats: StructuredSummaryOverlayStats;
  symbols: StructuredSummaryEntry[];
  files: StructuredSummaryEntry[];
  slices: StructuredSummaryEntry[];
  communities: StructuredSummaryEntry[];
  processes: StructuredSummaryEntry[];
  archetypes: StructuredSummaryEntry[];
}

const MAX_SUMMARY_COUNTS = {
  symbols: 1200,
  files: 600,
  slices: 500,
  communities: 500,
  processes: 500,
  archetypes: 150,
};

const LIST_LIMIT = 12;

const NON_SYMBOL_LABELS = new Set([
  'File',
  'Folder',
  'FeatureSlice',
  'Gap',
  'Community',
  'Process',
]);

const RELATION_TYPES_FOR_DOWNSTREAM = new Set([
  'CALLS',
  'WRITES_FIELD',
  'INVALIDATES_KEY',
  'DERIVES_FROM',
  'DERIVES_FROM_COLUMN',
  'READS_FIELD',
  'SERIALIZES_FIELD',
  'TESTS_SHAPE',
]);

const SHAPE_RELATION_TYPES = new Set([
  'VALIDATES_FIELD',
  'SERIALIZES_FIELD',
  'READS_FIELD',
  'WRITES_FIELD',
  'DERIVES_FROM_COLUMN',
  'TESTS_SHAPE',
]);

const normalizePath = (value: unknown): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const makeName = (node: GraphNode | undefined, fallback: string): string => {
  if (!node) return fallback;
  const heuristicLabel = String(node.properties?.heuristicLabel || '').trim();
  if (heuristicLabel) return heuristicLabel;
  const name = String(node.properties?.name || '').trim();
  if (name) return name;
  return fallback;
};

const uniqueLimited = (values: string[], limit = LIST_LIMIT): string[] => {
  return Array.from(new Set(values.map(v => String(v || '').trim()).filter(Boolean))).slice(0, limit);
};

const buildAdjacency = (relationships: GraphRelationship[]): {
  outgoing: Map<string, GraphRelationship[]>;
  incoming: Map<string, GraphRelationship[]>;
} => {
  const outgoing = new Map<string, GraphRelationship[]>();
  const incoming = new Map<string, GraphRelationship[]>();
  for (const rel of relationships) {
    const outList = outgoing.get(rel.sourceId) || [];
    outList.push(rel);
    outgoing.set(rel.sourceId, outList);

    const inList = incoming.get(rel.targetId) || [];
    inList.push(rel);
    incoming.set(rel.targetId, inList);
  }
  return { outgoing, incoming };
};

const groupByTarget = (
  relationships: GraphRelationship[],
  targetLabelById: Map<string, string>,
  type: 'MEMBER_OF' | 'STEP_IN_PROCESS',
): {
  membersByGroup: Map<string, Set<string>>;
  groupsByMember: Map<string, Set<string>>;
} => {
  const membersByGroup = new Map<string, Set<string>>();
  const groupsByMember = new Map<string, Set<string>>();

  for (const rel of relationships) {
    if (rel.type !== type) continue;
    if (type === 'MEMBER_OF') {
      const targetLabel = targetLabelById.get(rel.targetId);
      if (targetLabel !== 'FeatureSlice' && targetLabel !== 'Community') continue;
    } else {
      const targetLabel = targetLabelById.get(rel.targetId);
      if (targetLabel !== 'Process') continue;
    }

    const groupMembers = membersByGroup.get(rel.targetId) || new Set<string>();
    groupMembers.add(rel.sourceId);
    membersByGroup.set(rel.targetId, groupMembers);

    const memberGroups = groupsByMember.get(rel.sourceId) || new Set<string>();
    memberGroups.add(rel.targetId);
    groupsByMember.set(rel.sourceId, memberGroups);
  }

  return { membersByGroup, groupsByMember };
};

const isAuthEdge = (edge: GraphRelationship, sourceName: string, targetName: string): boolean => {
  const reason = String(edge.reason || '').toLowerCase();
  return (
    sourceName.startsWith('permission:')
    || targetName.startsWith('permission:')
    || sourceName.startsWith('role:')
    || targetName.startsWith('role:')
    || reason.includes('permission')
    || reason.startsWith('laravel-authorize:')
    || reason.startsWith('laravel-gate:')
    || reason.startsWith('laravel-can:')
    || reason.startsWith('laravel-route-middleware:can:')
  );
};

const isCacheEdge = (edge: GraphRelationship): boolean => {
  const reason = String(edge.reason || '').toLowerCase();
  return (
    edge.type === 'INVALIDATES_KEY'
    || reason.startsWith('react-query-key:')
    || reason.startsWith('micro-dataflow:query-invalidation')
  );
};

const reasonFamily = (reason: string): string => {
  const trimmed = String(reason || '').trim();
  if (!trimmed) return '';
  const idx = trimmed.indexOf(':');
  if (idx === -1) return trimmed;
  return trimmed.slice(0, idx);
};

const summarizeEntity = (
  level: StructuredSummaryLevel,
  entityId: string,
  name: string,
  label: string,
  filePath: string,
  entityNodeIds: Set<string>,
  nodeById: Map<string, GraphNode>,
  outgoing: Map<string, GraphRelationship[]>,
  incoming: Map<string, GraphRelationship[]>,
  siblingPrecedents: string[],
  extraResponsibilities: string[] = [],
): StructuredSummaryEntry => {
  const touchedEdges = new Map<string, GraphRelationship>();
  for (const nodeId of entityNodeIds) {
    for (const edge of outgoing.get(nodeId) || []) {
      touchedEdges.set(edge.id, edge);
    }
    for (const edge of incoming.get(nodeId) || []) {
      touchedEdges.set(edge.id, edge);
    }
  }

  const inboundCallers: string[] = [];
  const downstreamEffects: string[] = [];
  const companions: string[] = [];

  const authContracts: string[] = [];
  const cacheContracts: string[] = [];
  const shapeContracts: string[] = [];
  const reasonFamilies = new Map<string, number>();

  for (const edge of touchedEdges.values()) {
    const sourceName = makeName(nodeById.get(edge.sourceId), edge.sourceId).toLowerCase();
    const targetName = makeName(nodeById.get(edge.targetId), edge.targetId).toLowerCase();

    const sourceInside = entityNodeIds.has(edge.sourceId);
    const targetInside = entityNodeIds.has(edge.targetId);

    const family = reasonFamily(edge.reason);
    if (family) {
      reasonFamilies.set(family, (reasonFamilies.get(family) || 0) + 1);
    }

    if (isAuthEdge(edge, sourceName, targetName)) {
      const sourceRawName = String(nodeById.get(edge.sourceId)?.properties?.name || '').toLowerCase();
      const targetRawName = String(nodeById.get(edge.targetId)?.properties?.name || '').toLowerCase();
      const authNode = sourceRawName.startsWith('permission:') || sourceRawName.startsWith('role:')
        ? nodeById.get(edge.sourceId)
        : targetRawName.startsWith('permission:') || targetRawName.startsWith('role:')
          ? nodeById.get(edge.targetId)
          : undefined;
      const authName = makeName(
        authNode,
        edge.reason,
      );
      authContracts.push(authName);
    }

    if (isCacheEdge(edge)) {
      const cacheName = makeName(nodeById.get(edge.targetId), edge.reason);
      cacheContracts.push(cacheName);
    }

    if (SHAPE_RELATION_TYPES.has(edge.type)) {
      shapeContracts.push(makeName(nodeById.get(edge.targetId), edge.targetId));
    }

    if (!sourceInside && targetInside && edge.type === 'CALLS') {
      inboundCallers.push(makeName(nodeById.get(edge.sourceId), edge.sourceId));
    }

    if (sourceInside && !targetInside && RELATION_TYPES_FOR_DOWNSTREAM.has(edge.type)) {
      downstreamEffects.push(`${edge.type.toLowerCase()}:${makeName(nodeById.get(edge.targetId), edge.targetId)}`);
    }

    if (sourceInside !== targetInside) {
      const counterpartId = sourceInside ? edge.targetId : edge.sourceId;
      companions.push(makeName(nodeById.get(counterpartId), counterpartId));
    }
  }

  const familyResponsibilities = Array.from(reasonFamilies.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([family, count]) => `reason:${family}:${count}`);

  const responsibilities = uniqueLimited(
    [
      `level:${level}`,
      `label:${label}`,
      ...(filePath ? [`layer:${deriveLayerTag(filePath)}`] : []),
      ...extraResponsibilities,
      ...familyResponsibilities,
    ],
    LIST_LIMIT,
  );

  return {
    id: generateId('summary', `${level}:${entityId}`),
    level,
    entityId,
    name,
    label,
    filePath,
    responsibilities,
    inboundCallers: uniqueLimited(inboundCallers, LIST_LIMIT),
    downstreamEffects: uniqueLimited(downstreamEffects, LIST_LIMIT),
    contracts: {
      auth: uniqueLimited(authContracts, LIST_LIMIT),
      cache: uniqueLimited(cacheContracts, LIST_LIMIT),
      shape: uniqueLimited(shapeContracts, LIST_LIMIT),
    },
    companions: uniqueLimited(companions, LIST_LIMIT),
    siblingPrecedents: uniqueLimited(siblingPrecedents, LIST_LIMIT),
  };
};

const rankByDegree = (
  nodes: GraphNode[],
  outgoing: Map<string, GraphRelationship[]>,
  incoming: Map<string, GraphRelationship[]>,
  limit: number,
): { selected: GraphNode[]; truncated: boolean } => {
  const ranked = nodes
    .map(node => ({
      node,
      degree: (outgoing.get(node.id)?.length || 0) + (incoming.get(node.id)?.length || 0),
    }))
    .sort((a, b) => b.degree - a.degree)
    .map(item => item.node);

  return {
    selected: ranked.slice(0, limit),
    truncated: ranked.length > limit,
  };
};

const buildFileDefinedSymbolMap = (
  relationships: GraphRelationship[],
  targetLabelById: Map<string, string>,
): Map<string, Set<string>> => {
  const map = new Map<string, Set<string>>();
  for (const rel of relationships) {
    if (rel.type !== 'DEFINES') continue;
    if (targetLabelById.get(rel.sourceId) !== 'File') continue;
    const set = map.get(rel.sourceId) || new Set<string>();
    set.add(rel.targetId);
    map.set(rel.sourceId, set);
  }
  return map;
};

export const processStructuredSummaryOverlay = async (
  knowledgeGraph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void,
): Promise<StructuredSummaryOverlaySnapshot> => {
  onProgress?.('Indexing nodes and relationships for structured summaries...', 10);

  const nodeById = new Map<string, GraphNode>();
  const targetLabelById = new Map<string, string>();
  for (const node of knowledgeGraph.nodes) {
    nodeById.set(node.id, node);
    targetLabelById.set(node.id, node.label);
  }

  const { outgoing, incoming } = buildAdjacency(knowledgeGraph.relationships);
  const fileDefinedSymbols = buildFileDefinedSymbolMap(knowledgeGraph.relationships, targetLabelById);

  const membership = groupByTarget(knowledgeGraph.relationships, targetLabelById, 'MEMBER_OF');
  const processSteps = groupByTarget(knowledgeGraph.relationships, targetLabelById, 'STEP_IN_PROCESS');

  const symbolCandidates = knowledgeGraph.nodes.filter(node => !NON_SYMBOL_LABELS.has(node.label));
  const fileCandidates = knowledgeGraph.nodes.filter(node => node.label === 'File');
  const sliceCandidates = knowledgeGraph.nodes.filter(node => node.label === 'FeatureSlice');
  const communityCandidates = knowledgeGraph.nodes.filter(node => node.label === 'Community');
  const processCandidates = knowledgeGraph.nodes.filter(node => node.label === 'Process');

  const rankedSymbols = rankByDegree(symbolCandidates, outgoing, incoming, MAX_SUMMARY_COUNTS.symbols);
  const rankedFiles = rankByDegree(fileCandidates, outgoing, incoming, MAX_SUMMARY_COUNTS.files);
  const rankedSlices = rankByDegree(sliceCandidates, outgoing, incoming, MAX_SUMMARY_COUNTS.slices);
  const rankedCommunities = rankByDegree(communityCandidates, outgoing, incoming, MAX_SUMMARY_COUNTS.communities);
  const rankedProcesses = rankByDegree(processCandidates, outgoing, incoming, MAX_SUMMARY_COUNTS.processes);

  onProgress?.('Building symbol/file/slice/community/process summary overlays...', 45);

  const symbols = rankedSymbols.selected.map(node => {
    const filePath = normalizePath(node.properties?.filePath);
    const groups = Array.from(membership.groupsByMember.get(node.id) || []);
    const processGroups = Array.from(processSteps.groupsByMember.get(node.id) || []);
    const siblingHints = uniqueLimited([
      ...groups.map(groupId => `group:${makeName(nodeById.get(groupId), groupId)}`),
      ...processGroups.map(groupId => `process:${makeName(nodeById.get(groupId), groupId)}`),
    ]);

    const roleHints: string[] = [];
    const nodeName = String(node.properties?.name || '').toLowerCase();
    if (nodeName.startsWith('endpoint:')) roleHints.push('role:endpoint');
    if (nodeName.startsWith('permission:')) roleHints.push('role:permission');
    if (nodeName.startsWith('role:')) roleHints.push('role:granting-role');

    return summarizeEntity(
      'symbol',
      node.id,
      makeName(node, node.id),
      node.label,
      filePath,
      new Set([node.id]),
      nodeById,
      outgoing,
      incoming,
      siblingHints,
      roleHints,
    );
  });

  const files = rankedFiles.selected.map(node => {
    const defined = fileDefinedSymbols.get(node.id) || new Set<string>();
    const memberIds = new Set<string>([node.id, ...Array.from(defined)]);

    const cochangeHints: string[] = [];
    for (const rel of outgoing.get(node.id) || []) {
      if (rel.type !== 'CO_CHANGES_WITH') continue;
      cochangeHints.push(makeName(nodeById.get(rel.targetId), rel.targetId));
    }
    for (const rel of incoming.get(node.id) || []) {
      if (rel.type !== 'CO_CHANGES_WITH') continue;
      cochangeHints.push(makeName(nodeById.get(rel.sourceId), rel.sourceId));
    }

    return summarizeEntity(
      'file',
      node.id,
      makeName(node, node.id),
      node.label,
      normalizePath(node.properties?.filePath),
      memberIds,
      nodeById,
      outgoing,
      incoming,
      cochangeHints,
      [`defines:${defined.size}`],
    );
  });

  const slicesByType = new Map<string, string[]>();
  for (const slice of rankedSlices.selected) {
    const type = String(slice.properties?.sliceType || '').trim() || 'unknown';
    const list = slicesByType.get(type) || [];
    list.push(slice.id);
    slicesByType.set(type, list);
  }

  const slices = rankedSlices.selected.map(node => {
    const members = membership.membersByGroup.get(node.id) || new Set<string>();
    const type = String(node.properties?.sliceType || '').trim() || 'unknown';
    const peers = (slicesByType.get(type) || [])
      .filter(id => id !== node.id)
      .slice(0, LIST_LIMIT)
      .map(id => makeName(nodeById.get(id), id));

    return summarizeEntity(
      'slice',
      node.id,
      makeName(node, node.id),
      node.label,
      '',
      new Set([node.id, ...Array.from(members)]),
      nodeById,
      outgoing,
      incoming,
      peers,
      [
        `slice-type:${type}`,
        `closure-slots:${Array.isArray(node.properties?.closureSlots) ? node.properties?.closureSlots.length : 0}`,
        `closed-slots:${Array.isArray(node.properties?.closedSlots) ? node.properties?.closedSlots.length : 0}`,
      ],
    );
  });

  const communities = rankedCommunities.selected.map(node => {
    const members = membership.membersByGroup.get(node.id) || new Set<string>();
    const memberCount = members.size;
    const siblingHints = rankedCommunities.selected
      .filter(other => other.id !== node.id)
      .slice(0, LIST_LIMIT)
      .map(other => makeName(other, other.id));

    return summarizeEntity(
      'community',
      node.id,
      makeName(node, node.id),
      node.label,
      '',
      new Set([node.id, ...Array.from(members)]),
      nodeById,
      outgoing,
      incoming,
      siblingHints,
      [`members:${memberCount}`],
    );
  });

  const processesByType = new Map<string, string[]>();
  for (const process of rankedProcesses.selected) {
    const type = String(process.properties?.processType || '').trim() || 'unknown';
    const list = processesByType.get(type) || [];
    list.push(process.id);
    processesByType.set(type, list);
  }

  const processes = rankedProcesses.selected.map(node => {
    const members = processSteps.membersByGroup.get(node.id) || new Set<string>();
    const type = String(node.properties?.processType || '').trim() || 'unknown';
    const peers = (processesByType.get(type) || [])
      .filter(id => id !== node.id)
      .slice(0, LIST_LIMIT)
      .map(id => makeName(nodeById.get(id), id));

    return summarizeEntity(
      'process',
      node.id,
      makeName(node, node.id),
      node.label,
      '',
      new Set([node.id, ...Array.from(members)]),
      nodeById,
      outgoing,
      incoming,
      peers,
      [
        `process-type:${type}`,
        `step-count:${Number(node.properties?.stepCount || members.size || 0)}`,
      ],
    );
  });

  onProgress?.('Deriving archetype-level structured summaries...', 75);

  const processTraces = extractProcessesFromGraph(knowledgeGraph);
  const httpEdges = extractHttpEdgesFromGraph(knowledgeGraph, 0.9);
  const archetypeReport = buildArchetypeReport(processTraces, httpEdges, {
    limit: MAX_SUMMARY_COUNTS.archetypes,
    examplesPerSignature: 4,
    minHttpConfidence: 0.9,
  });

  const processStepMap = new Map<string, Set<string>>();
  for (const proc of processTraces) {
    processStepMap.set(proc.id, new Set(proc.steps.map(step => step.nodeId)));
  }

  const archetypes = archetypeReport.signatures.slice(0, MAX_SUMMARY_COUNTS.archetypes).map(signature => {
    const processIds = signature.exampleProcesses.map(example => example.processId);
    const nodeIds = new Set<string>();
    for (const processId of processIds) {
      nodeIds.add(processId);
      for (const stepId of processStepMap.get(processId) || []) {
        nodeIds.add(stepId);
      }
    }

    const siblingPrecedents = signature.exampleProcesses.map(example => example.label);
    const responsibilities = [
      `signature:${signature.signature}`,
      `processes:${signature.count}`,
      `cross-stack:${signature.crossStack ? 'yes' : 'no'}`,
    ];
    const entry = summarizeEntity(
      'archetype',
      signature.signature,
      signature.signature,
      'Archetype',
      '',
      nodeIds,
      nodeById,
      outgoing,
      incoming,
      siblingPrecedents,
      responsibilities,
    );

    return {
      ...entry,
      inboundCallers: uniqueLimited(
        signature.topHttpRoutes.map(route => `${route.route}:${route.count}`),
        LIST_LIMIT,
      ),
      downstreamEffects: uniqueLimited(
        signature.exampleProcesses.map(example => `terminal:${example.terminal.name || example.terminal.filePath}`),
        LIST_LIMIT,
      ),
      companions: uniqueLimited(
        signature.exampleProcesses.flatMap(example => [example.entry.filePath, example.terminal.filePath]),
        LIST_LIMIT,
      ),
    };
  });

  onProgress?.('Structured summary overlay materialization complete.', 100);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    stats: {
      symbolCount: symbols.length,
      fileCount: files.length,
      sliceCount: slices.length,
      communityCount: communities.length,
      processCount: processes.length,
      archetypeCount: archetypes.length,
      truncated: {
        symbols: rankedSymbols.truncated,
        files: rankedFiles.truncated,
        slices: rankedSlices.truncated,
        communities: rankedCommunities.truncated,
        processes: rankedProcesses.truncated,
        archetypes: archetypeReport.signatures.length > MAX_SUMMARY_COUNTS.archetypes,
      },
    },
    symbols,
    files,
    slices,
    communities,
    processes,
    archetypes,
  };
};
