import { generateId } from '../../lib/utils.js';
import { GraphNode, KnowledgeGraph, NodeLabel } from '../graph/types.js';

type FeatureSliceType = 'endpoint' | 'permission' | 'query_key';
type SliceRole =
  | 'anchor'
  | 'entrypoint'
  | 'handler'
  | 'authorization'
  | 'authorization_consumer'
  | 'query_consumer'
  | 'supporting';

interface FeatureSliceAnchor {
  nodeId: string;
  nodeName: string;
  sliceType: FeatureSliceType;
  sliceKey: string;
}

export interface FeatureSliceNode {
  id: string;
  label: string;
  heuristicLabel: string;
  sliceType: FeatureSliceType;
  anchorId: string;
  anchorName: string;
  closureSlots: string[];
  closedSlots: string[];
  closureScore: number;
}

export interface FeatureSliceMembership {
  nodeId: string;
  sliceId: string;
  role: SliceRole;
}

export interface FeatureSliceDetectionResult {
  slices: FeatureSliceNode[];
  memberships: FeatureSliceMembership[];
  stats: {
    totalSlices: number;
    totalMemberships: number;
    avgClosureScore: number;
  };
}

const MIN_CALL_CONFIDENCE = 0.9;
const MAX_NEIGHBORS_PER_HOP = 16;

const REQUIRED_CLOSURE_SLOTS: Record<FeatureSliceType, string[]> = {
  endpoint: ['anchor', 'entrypoint', 'handler', 'authorization'],
  permission: ['anchor', 'authorization_consumer'],
  query_key: ['anchor', 'query_consumer'],
};

const ROLE_PRIORITY: Record<SliceRole, number> = {
  anchor: 90,
  handler: 80,
  entrypoint: 70,
  authorization: 65,
  authorization_consumer: 60,
  query_consumer: 55,
  supporting: 10,
};

const SLICE_MEMBER_LABELS = new Set<NodeLabel>([
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
  'Struct',
  'Enum',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
]);

const sanitizeSliceKey = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
};

const normalizeNodeName = (node: GraphNode): string => {
  return String(node.properties?.name || '').trim();
};

const parseNodeIdPrefixedValue = (nodeId: string, prefix: string): string | null => {
  const normalizedId = String(nodeId || '').trim();
  const token = `${prefix}:`;
  if (!normalizedId.startsWith(token)) return null;
  return String(normalizedId.slice(token.length)).trim() || null;
};

const parseEndpointKey = (node: GraphNode): string | null => {
  const nodeName = normalizeNodeName(node);
  if (nodeName.startsWith('endpoint:')) {
    return String(nodeName.slice('endpoint:'.length)).trim() || null;
  }
  return parseNodeIdPrefixedValue(String(node.id || ''), 'CodeElement:endpoint');
};

const parsePermissionKey = (node: GraphNode): string | null => {
  const nodeName = normalizeNodeName(node);
  if (nodeName.startsWith('permission:')) {
    return String(nodeName.slice('permission:'.length)).trim() || null;
  }
  return parseNodeIdPrefixedValue(String(node.id || ''), 'CodeElement:permission');
};

const isPermissionNode = (node: GraphNode | undefined): boolean => {
  if (!node || node.label !== 'CodeElement') return false;
  return Boolean(parsePermissionKey(node));
};

const hasAuthorizationReason = (reason: string): boolean => {
  return /laravel-(authorize|can:|route-middleware:can:|permission)/.test(reason || '');
};

const looksLikeQueryKeyFactory = (node: GraphNode): boolean => {
  const name = normalizeNodeName(node);
  return /querykeys\./i.test(name);
};

const buildAnchors = (knowledgeGraph: KnowledgeGraph): FeatureSliceAnchor[] => {
  const anchors = new Map<string, FeatureSliceAnchor>();

  const putAnchor = (anchor: FeatureSliceAnchor) => {
    const dedupeKey = `${anchor.sliceType}:${anchor.sliceKey}`;
    if (!anchors.has(dedupeKey)) anchors.set(dedupeKey, anchor);
  };

  for (const node of knowledgeGraph.nodes) {
    const nodeName = normalizeNodeName(node);

    if (node.label === 'CodeElement') {
      const endpointKey = parseEndpointKey(node);
      if (endpointKey) {
        putAnchor({
          nodeId: node.id,
          nodeName: nodeName || `endpoint:${endpointKey}`,
          sliceType: 'endpoint',
          sliceKey: endpointKey,
        });
        continue;
      }

      const permissionKey = parsePermissionKey(node);
      if (permissionKey) {
        putAnchor({
          nodeId: node.id,
          nodeName: nodeName || `permission:${permissionKey}`,
          sliceType: 'permission',
          sliceKey: permissionKey,
        });
        continue;
      }
    }

    if (!nodeName) continue;
    if ((node.label === 'Function' || node.label === 'Method' || node.label === 'CodeElement') && looksLikeQueryKeyFactory(node)) {
      putAnchor({
        nodeId: node.id,
        nodeName,
        sliceType: 'query_key',
        sliceKey: nodeName,
      });
    }
  }

  return Array.from(anchors.values());
};

const roleExists = (memberRoles: Map<string, SliceRole>, targetRole: SliceRole): boolean => {
  for (const role of memberRoles.values()) {
    if (role === targetRole) return true;
  }
  return false;
};

const pickRole = (
  memberRoles: Map<string, SliceRole>,
  nodeId: string,
  nextRole: SliceRole
) => {
  const previous = memberRoles.get(nodeId);
  if (!previous || ROLE_PRIORITY[nextRole] > ROLE_PRIORITY[previous]) {
    memberRoles.set(nodeId, nextRole);
  }
};

const buildCallsIndex = (knowledgeGraph: KnowledgeGraph) => {
  const outgoing = new Map<string, Array<{ targetId: string; reason: string }>>();
  const incoming = new Map<string, Array<{ sourceId: string; reason: string }>>();

  for (const rel of knowledgeGraph.relationships) {
    if (rel.type !== 'CALLS') continue;
    if ((rel.confidence ?? 0) < MIN_CALL_CONFIDENCE) continue;

    const outList = outgoing.get(rel.sourceId) || [];
    outList.push({ targetId: rel.targetId, reason: rel.reason || '' });
    outgoing.set(rel.sourceId, outList);

    const inList = incoming.get(rel.targetId) || [];
    inList.push({ sourceId: rel.sourceId, reason: rel.reason || '' });
    incoming.set(rel.targetId, inList);
  }

  return { outgoing, incoming };
};

const collectMembersForAnchor = (
  anchor: FeatureSliceAnchor,
  nodeMap: Map<string, GraphNode>,
  calls: ReturnType<typeof buildCallsIndex>,
): Map<string, SliceRole> => {
  const memberRoles = new Map<string, SliceRole>();
  pickRole(memberRoles, anchor.nodeId, 'anchor');

  const incoming = (calls.incoming.get(anchor.nodeId) || []).slice(0, MAX_NEIGHBORS_PER_HOP);
  const outgoing = (calls.outgoing.get(anchor.nodeId) || []).slice(0, MAX_NEIGHBORS_PER_HOP);

  for (const edge of incoming) {
    const role: SliceRole =
      anchor.sliceType === 'query_key'
        ? 'query_consumer'
        : anchor.sliceType === 'permission'
          ? 'authorization_consumer'
          : 'entrypoint';
    pickRole(memberRoles, edge.sourceId, role);
  }

  for (const edge of outgoing) {
    const targetNode = nodeMap.get(edge.targetId);
    if (!targetNode) continue;

    if (isPermissionNode(targetNode) || hasAuthorizationReason(edge.reason)) {
      pickRole(memberRoles, edge.targetId, 'authorization');
      continue;
    }

    if (anchor.sliceType === 'endpoint') {
      pickRole(memberRoles, edge.targetId, 'handler');
      continue;
    }

    if (anchor.sliceType === 'permission') {
      pickRole(memberRoles, edge.targetId, 'authorization_consumer');
      continue;
    }

    if (anchor.sliceType === 'query_key') {
      if ((edge.reason || '').startsWith('react-query:key-to-query-fn')) {
        pickRole(memberRoles, edge.targetId, 'query_consumer');
      } else {
        pickRole(memberRoles, edge.targetId, 'supporting');
      }
      continue;
    }

    pickRole(memberRoles, edge.targetId, 'supporting');
  }

  if (anchor.sliceType === 'endpoint') {
    for (const [memberNodeId, role] of memberRoles) {
      if (role !== 'handler') continue;
      const secondary = (calls.outgoing.get(memberNodeId) || []).slice(0, MAX_NEIGHBORS_PER_HOP);
      for (const edge of secondary) {
        const targetNode = nodeMap.get(edge.targetId);
        if (!targetNode) continue;
        if (isPermissionNode(targetNode) || hasAuthorizationReason(edge.reason)) {
          pickRole(memberRoles, edge.targetId, 'authorization');
        } else {
          pickRole(memberRoles, edge.targetId, 'supporting');
        }
      }
    }
  }

  if (anchor.sliceType === 'permission') {
    for (const [memberNodeId, role] of [...memberRoles.entries()]) {
      if (role !== 'authorization_consumer') continue;
      const secondary = (calls.incoming.get(memberNodeId) || []).slice(0, MAX_NEIGHBORS_PER_HOP);
      for (const edge of secondary) {
        pickRole(memberRoles, edge.sourceId, 'authorization_consumer');
      }
    }
  }

  return memberRoles;
};

const computeClosedSlots = (
  anchor: FeatureSliceAnchor,
  memberRoles: Map<string, SliceRole>,
): string[] => {
  const closed = new Set<string>();
  closed.add('anchor');

  if (anchor.sliceType === 'endpoint') {
    if (roleExists(memberRoles, 'entrypoint')) closed.add('entrypoint');
    if (roleExists(memberRoles, 'handler')) closed.add('handler');
    if (roleExists(memberRoles, 'authorization')) closed.add('authorization');
  } else if (anchor.sliceType === 'permission') {
    if (roleExists(memberRoles, 'authorization_consumer') || roleExists(memberRoles, 'authorization')) {
      closed.add('authorization_consumer');
    }
  } else if (anchor.sliceType === 'query_key') {
    if (roleExists(memberRoles, 'query_consumer')) closed.add('query_consumer');
  }

  return Array.from(closed);
};

const buildSliceLabel = (sliceType: FeatureSliceType, key: string): string => {
  if (sliceType === 'endpoint') return `Endpoint Slice: ${key}`;
  if (sliceType === 'permission') return `Permission Slice: ${key}`;
  return `Query Key Slice: ${key}`;
};

export const processFeatureSlices = async (
  knowledgeGraph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void
): Promise<FeatureSliceDetectionResult> => {
  onProgress?.('Scanning candidate feature anchors...', 0);

  const anchors = buildAnchors(knowledgeGraph);
  if (anchors.length === 0) {
    return {
      slices: [],
      memberships: [],
      stats: { totalSlices: 0, totalMemberships: 0, avgClosureScore: 0 },
    };
  }

  const nodeMap = new Map<string, GraphNode>();
  knowledgeGraph.nodes.forEach(node => nodeMap.set(node.id, node));
  const calls = buildCallsIndex(knowledgeGraph);

  const slices: FeatureSliceNode[] = [];
  const memberships: FeatureSliceMembership[] = [];
  const membershipDedupe = new Set<string>();

  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const memberRoles = collectMembersForAnchor(anchor, nodeMap, calls);
    const requiredSlots = REQUIRED_CLOSURE_SLOTS[anchor.sliceType];
    const closedSlots = computeClosedSlots(anchor, memberRoles);
    const closureScore = requiredSlots.length === 0
      ? 1
      : closedSlots.filter(slot => requiredSlots.includes(slot)).length / requiredSlots.length;

    const sliceKeySanitized = sanitizeSliceKey(anchor.sliceKey) || sanitizeSliceKey(anchor.nodeName) || `slice_${i}`;
    const sliceNodeId = generateId('FeatureSlice', `slice_${anchor.sliceType}_${sliceKeySanitized}`);
    const sliceLabel = buildSliceLabel(anchor.sliceType, anchor.sliceKey);

    slices.push({
      id: sliceNodeId,
      label: sliceLabel,
      heuristicLabel: sliceLabel,
      sliceType: anchor.sliceType,
      anchorId: anchor.nodeId,
      anchorName: anchor.nodeName,
      closureSlots: requiredSlots,
      closedSlots,
      closureScore: Math.round(closureScore * 100) / 100,
    });

    for (const [nodeId, role] of memberRoles) {
      const memberNode = nodeMap.get(nodeId);
      if (!memberNode) continue;
      if (!SLICE_MEMBER_LABELS.has(memberNode.label)) continue;

      const dedupeKey = `${nodeId}->${sliceNodeId}`;
      if (membershipDedupe.has(dedupeKey)) continue;
      membershipDedupe.add(dedupeKey);

      memberships.push({
        nodeId,
        sliceId: sliceNodeId,
        role,
      });
    }

    if (i % 10 === 0 || i === anchors.length - 1) {
      onProgress?.(`Materialized ${i + 1}/${anchors.length} feature slices...`, 20 + Math.round(((i + 1) / anchors.length) * 80));
    }
  }

  const avgClosureScore = slices.length > 0
    ? slices.reduce((sum, slice) => sum + slice.closureScore, 0) / slices.length
    : 0;

  onProgress?.('Feature slice extraction complete.', 100);

  return {
    slices,
    memberships,
    stats: {
      totalSlices: slices.length,
      totalMemberships: memberships.length,
      avgClosureScore: Math.round(avgClosureScore * 100) / 100,
    },
  };
};
