import { generateId } from '../../lib/utils.js';
import { GraphNode, KnowledgeGraph } from '../graph/types.js';

type SliceMembership = {
  nodeId: string;
  role: string;
};

type SliceMeta = {
  sliceId: string;
  sliceType: string;
  closureSlots: string[];
  closedSlots: string[];
  closureScore: number;
  memberships: SliceMembership[];
};

export interface ClosureTemplateRoleCoverage {
  role: string;
  coverage: number;
  count: number;
}

export interface ClosureTemplateSlotCoverage {
  slot: string;
  coverage: number;
  count: number;
}

export interface ClosureTemplateEntry {
  id: string;
  templateKey: string;
  sliceType: string;
  requiredSlots: string[];
  optionalSlots: string[];
  roleCoverage: ClosureTemplateRoleCoverage[];
  slotCoverage: ClosureTemplateSlotCoverage[];
  sliceCount: number;
  avgClosureScore: number;
  exemplarSliceIds: string[];
}

export interface ClosureTemplateSnapshot {
  version: 1;
  generatedAt: string;
  stats: {
    totalTemplates: number;
    totalSlices: number;
    totalCoveredSlots: number;
    totalRoleExpectations: number;
  };
  templates: ClosureTemplateEntry[];
}

const REQUIRED_SLOT_THRESHOLD = 0.67;
const ROLE_EXPECTATION_THRESHOLD = 0.5;
const MIN_GROUP_SIZE = 2;
const MAX_EXEMPLARS = 8;
const MAX_LIST = 24;

const normalizeSlot = (value: unknown): string => {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
};

const normalizeSliceType = (value: unknown): string => {
  return normalizeSlot(value) || 'unknown';
};

const normalizeArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map(item => normalizeSlot(item))
        .filter(Boolean),
    ),
  );
};

const roundCoverage = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const toSliceMeta = (
  sliceNode: GraphNode,
  membershipsBySliceId: Map<string, SliceMembership[]>,
): SliceMeta => {
  const sliceType = normalizeSliceType(sliceNode.properties?.sliceType);
  const closureSlots = normalizeArray(sliceNode.properties?.closureSlots);
  const closedSlots = normalizeArray(sliceNode.properties?.closedSlots);
  const closureScore = Number(sliceNode.properties?.closureScore || 0) || 0;

  return {
    sliceId: sliceNode.id,
    sliceType,
    closureSlots,
    closedSlots,
    closureScore,
    memberships: membershipsBySliceId.get(sliceNode.id) || [],
  };
};

const buildMembershipMap = (knowledgeGraph: KnowledgeGraph): Map<string, SliceMembership[]> => {
  const bySlice = new Map<string, SliceMembership[]>();
  for (const rel of knowledgeGraph.relationships) {
    if (rel.type !== 'MEMBER_OF') continue;
    if (typeof rel.reason !== 'string') continue;
    if (!rel.reason.startsWith('feature-slice:')) continue;
    const role = normalizeSlot(rel.reason.replace('feature-slice:', ''));
    if (!role) continue;
    const list = bySlice.get(rel.targetId) || [];
    list.push({ nodeId: rel.sourceId, role });
    bySlice.set(rel.targetId, list);
  }
  return bySlice;
};

const uniqueLimited = (values: string[], limit = MAX_LIST): string[] => {
  return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean))).slice(0, limit);
};

export const processClosureTemplates = async (
  knowledgeGraph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void,
): Promise<ClosureTemplateSnapshot> => {
  onProgress?.('Scanning feature slices for closure template families...', 10);

  const sliceNodes = knowledgeGraph.nodes.filter(node => node.label === 'FeatureSlice');
  if (sliceNodes.length === 0) {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      stats: {
        totalTemplates: 0,
        totalSlices: 0,
        totalCoveredSlots: 0,
        totalRoleExpectations: 0,
      },
      templates: [],
    };
  }

  const membershipsBySliceId = buildMembershipMap(knowledgeGraph);
  const slices = sliceNodes.map(node => toSliceMeta(node, membershipsBySliceId));

  const slicesByType = new Map<string, SliceMeta[]>();
  for (const slice of slices) {
    const list = slicesByType.get(slice.sliceType) || [];
    list.push(slice);
    slicesByType.set(slice.sliceType, list);
  }

  onProgress?.('Materializing closure templates per slice family...', 50);

  const templates: ClosureTemplateEntry[] = [];

  for (const [sliceType, group] of slicesByType) {
    if (group.length < MIN_GROUP_SIZE) continue;

    const slotObservedCount = new Map<string, number>();
    const slotRequiredCount = new Map<string, number>();
    const roleCount = new Map<string, number>();

    let closureScoreTotal = 0;
    for (const slice of group) {
      closureScoreTotal += slice.closureScore;
      for (const slot of slice.closedSlots) {
        slotObservedCount.set(slot, (slotObservedCount.get(slot) || 0) + 1);
      }
      for (const slot of slice.closureSlots) {
        slotRequiredCount.set(slot, (slotRequiredCount.get(slot) || 0) + 1);
      }
      for (const membership of slice.memberships) {
        roleCount.set(membership.role, (roleCount.get(membership.role) || 0) + 1);
      }
    }

    const slotCoverage = Array.from(
      new Set([...slotObservedCount.keys(), ...slotRequiredCount.keys()]),
    )
      .map(slot => ({
        slot,
        count: Math.max(slotObservedCount.get(slot) || 0, slotRequiredCount.get(slot) || 0),
        coverage: roundCoverage(
          Math.max(slotObservedCount.get(slot) || 0, slotRequiredCount.get(slot) || 0) / group.length,
        ),
      }))
      .sort((a, b) => b.coverage - a.coverage || b.count - a.count || a.slot.localeCompare(b.slot));

    const requiredSlots = slotCoverage
      .filter(slot => slot.coverage >= REQUIRED_SLOT_THRESHOLD)
      .map(slot => slot.slot);
    const optionalSlots = slotCoverage
      .filter(slot => !requiredSlots.includes(slot.slot))
      .map(slot => slot.slot);

    const roleCoverage = Array.from(roleCount.entries())
      .map(([role, count]) => ({
        role,
        count,
        coverage: roundCoverage(count / group.length),
      }))
      .filter(item => item.coverage >= ROLE_EXPECTATION_THRESHOLD)
      .sort((a, b) => b.coverage - a.coverage || b.count - a.count || a.role.localeCompare(b.role));

    const exemplarSliceIds = group
      .slice()
      .sort((a, b) => b.closureScore - a.closureScore)
      .slice(0, MAX_EXEMPLARS)
      .map(slice => slice.sliceId);

    const templateKey = `slice_type:${sliceType}`;
    templates.push({
      id: generateId('ClosureTemplate', templateKey),
      templateKey,
      sliceType,
      requiredSlots: uniqueLimited(requiredSlots),
      optionalSlots: uniqueLimited(optionalSlots),
      roleCoverage: roleCoverage.slice(0, MAX_LIST),
      slotCoverage: slotCoverage.slice(0, MAX_LIST),
      sliceCount: group.length,
      avgClosureScore: roundCoverage(closureScoreTotal / group.length),
      exemplarSliceIds: uniqueLimited(exemplarSliceIds, MAX_EXEMPLARS),
    });
  }

  templates.sort((a, b) => b.sliceCount - a.sliceCount || b.avgClosureScore - a.avgClosureScore || a.templateKey.localeCompare(b.templateKey));

  onProgress?.('Closure template extraction complete.', 100);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    stats: {
      totalTemplates: templates.length,
      totalSlices: slices.length,
      totalCoveredSlots: templates.reduce((sum, template) => sum + template.slotCoverage.length, 0),
      totalRoleExpectations: templates.reduce((sum, template) => sum + template.roleCoverage.length, 0),
    },
    templates,
  };
};
