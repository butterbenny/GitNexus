import fs from 'fs/promises';
import path from 'path';
import { generateId } from '../../lib/utils.js';
import { GraphNode, GraphRelationship, KnowledgeGraph, RelationshipType } from '../graph/types.js';

export type GapAbsenceTier = 'deterministic_missing' | 'pattern_missing' | 'heuristic_suspicion';
export type GapSeverity = 'high' | 'medium' | 'low';

type ExpectationDirection = 'incoming' | 'outgoing';

export interface GapNode {
  id: string;
  label: string;
  heuristicLabel: string;
  gapType: string;
  absenceTier: GapAbsenceTier;
  severity: GapSeverity;
  sliceId: string;
  anchorId: string;
  missingSlots: string[];
  evidence: string[];
}

export interface GapLink {
  gapId: string;
  sliceId: string;
}

export interface GapDetectionResult {
  gaps: GapNode[];
  links: GapLink[];
  stats: {
    totalGaps: number;
    deterministic: number;
    pattern: number;
    heuristic: number;
    expectation: number;
    expectationRulesEvaluated: number;
    expectationRuleApplications: number;
    expectationErrors: number;
  };
}

export interface GapProcessorOptions {
  repoPath?: string;
  expectationPath?: string;
  expectationJson?: string;
}

interface SliceMembership {
  nodeId: string;
  role: string;
}

interface SliceMeta {
  slice: GraphNode;
  requiredSlots: string[];
  closedSlots: Set<string>;
  missingSlots: string[];
  memberships: SliceMembership[];
  hasTestCompanion: boolean;
  sliceType: string;
  anchorId: string;
  anchorName: string;
}

interface GraphExpectationScope {
  sliceType: string[];
  anchorNameIncludes: string[];
  anchorNameStartsWith: string[];
  anchorIdIncludes: string[];
  anchorIdStartsWith: string[];
  anchorNameRegex?: string;
}

interface GraphExpectationSlotCheck {
  kind: 'closed_slot';
  slot: string;
  missingSlot?: string;
}

interface GraphExpectationMemberRoleCheck {
  kind: 'member_role';
  role: string;
  missingSlot?: string;
}

interface GraphExpectationEdgeCheck {
  kind: 'anchor_edge' | 'member_edge';
  direction: ExpectationDirection;
  type: string[];
  reasonStartsWith: string[];
  reasonIncludes: string[];
  counterpartLabel: string[];
  counterpartNameStartsWith: string[];
  counterpartNameIncludes: string[];
  minConfidence?: number;
  fromRole?: string;
  missingSlot?: string;
}

type GraphExpectationCheck = GraphExpectationSlotCheck | GraphExpectationMemberRoleCheck | GraphExpectationEdgeCheck;

interface GraphExpectationRule {
  id: string;
  description: string;
  enabled: boolean;
  scope: GraphExpectationScope;
  checks: GraphExpectationCheck[];
  gapType?: string;
  absenceTier?: GapAbsenceTier;
  severity?: GapSeverity;
  evidence: string[];
}

interface GraphExpectationLoadResult {
  rules: GraphExpectationRule[];
  errors: string[];
}

interface EdgeIndexes {
  outgoing: Map<string, GraphRelationship[]>;
  incoming: Map<string, GraphRelationship[]>;
}

const TEST_FILE_RE = /(^|\/)(__tests__|tests?|testing|spec)(\/|$)|(\.test\.|\.spec\.)|(_test\.)|(^test_)/i;
const DEFAULT_GRAPH_EXPECTATION_PATH = '.gitnexus/graph-expectations.json';
const ALLOWED_GAP_TIERS = new Set<GapAbsenceTier>(['deterministic_missing', 'pattern_missing', 'heuristic_suspicion']);
const ALLOWED_GAP_SEVERITIES = new Set<GapSeverity>(['high', 'medium', 'low']);

const isTestFilePath = (filePath: string): boolean => {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (!normalized) return false;
  return TEST_FILE_RE.test(normalized);
};

const normalizePath = (value: string): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const normalizeArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean);
};

const normalizeStringList = (value: unknown, lowerCase = false): string[] => {
  const source = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  const mapped = source
    .map(item => String(item || '').trim())
    .filter(Boolean);
  if (!lowerCase) return mapped;
  return mapped.map(item => item.toLowerCase());
};

const sanitizeGapKey = (value: string): string => {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90);
};

const normalizeRuleId = (value: unknown, fallback: string): string => {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return sanitizeGapKey(raw) || fallback;
};

const parseTier = (value: unknown): GapAbsenceTier | undefined => {
  const normalized = String(value || '').trim().toLowerCase() as GapAbsenceTier;
  if (!ALLOWED_GAP_TIERS.has(normalized)) return undefined;
  return normalized;
};

const parseSeverity = (value: unknown): GapSeverity | undefined => {
  const normalized = String(value || '').trim().toLowerCase() as GapSeverity;
  if (!ALLOWED_GAP_SEVERITIES.has(normalized)) return undefined;
  return normalized;
};

const parseDirection = (value: unknown): ExpectationDirection => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'incoming' ? 'incoming' : 'outgoing';
};

const buildEdgeIndexes = (knowledgeGraph: KnowledgeGraph): EdgeIndexes => {
  const outgoing = new Map<string, GraphRelationship[]>();
  const incoming = new Map<string, GraphRelationship[]>();

  for (const rel of knowledgeGraph.relationships) {
    const outgoingList = outgoing.get(rel.sourceId) || [];
    outgoingList.push(rel);
    outgoing.set(rel.sourceId, outgoingList);

    const incomingList = incoming.get(rel.targetId) || [];
    incomingList.push(rel);
    incoming.set(rel.targetId, incomingList);
  }

  return { outgoing, incoming };
};

const toScope = (raw: any): GraphExpectationScope => {
  const scope = raw && typeof raw === 'object' ? raw : {};
  const anchorNameRegex = String(scope.anchorNameRegex || '').trim() || undefined;
  return {
    sliceType: normalizeStringList(scope.sliceType, true),
    anchorNameIncludes: normalizeStringList(scope.anchorNameIncludes, true),
    anchorNameStartsWith: normalizeStringList(scope.anchorNameStartsWith, true),
    anchorIdIncludes: normalizeStringList(scope.anchorIdIncludes, true),
    anchorIdStartsWith: normalizeStringList(scope.anchorIdStartsWith, true),
    ...(anchorNameRegex ? { anchorNameRegex } : {}),
  };
};

const toEdgeCheck = (
  raw: any,
  kind: 'anchor_edge' | 'member_edge',
): GraphExpectationEdgeCheck | null => {
  const fromRole = String(raw?.fromRole || '').trim().toLowerCase();
  if (kind === 'member_edge' && !fromRole) return null;

  const typeValues = normalizeStringList(raw?.type, true).map(value => value.toUpperCase());
  const relationshipTypes = typeValues.filter(value => value) as RelationshipType[];

  return {
    kind,
    direction: parseDirection(raw?.direction),
    type: relationshipTypes,
    reasonStartsWith: normalizeStringList(raw?.reasonStartsWith, true),
    reasonIncludes: normalizeStringList(raw?.reasonIncludes, true),
    counterpartLabel: normalizeStringList(raw?.counterpartLabel, true),
    counterpartNameStartsWith: normalizeStringList(raw?.counterpartNameStartsWith, true),
    counterpartNameIncludes: normalizeStringList(raw?.counterpartNameIncludes, true),
    minConfidence: Number.isFinite(Number(raw?.minConfidence)) ? Number(raw.minConfidence) : undefined,
    ...(fromRole ? { fromRole } : {}),
    ...(String(raw?.missingSlot || '').trim() ? { missingSlot: String(raw.missingSlot).trim() } : {}),
  };
};

const toCheck = (raw: any): GraphExpectationCheck | null => {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '').trim().toLowerCase();
  if (!kind) return null;

  if (kind === 'closed_slot') {
    const slot = String(raw.slot || '').trim().toLowerCase();
    if (!slot) return null;
    return {
      kind: 'closed_slot',
      slot,
      ...(String(raw.missingSlot || '').trim() ? { missingSlot: String(raw.missingSlot).trim() } : {}),
    };
  }

  if (kind === 'member_role') {
    const role = String(raw.role || '').trim().toLowerCase();
    if (!role) return null;
    return {
      kind: 'member_role',
      role,
      ...(String(raw.missingSlot || '').trim() ? { missingSlot: String(raw.missingSlot).trim() } : {}),
    };
  }

  if (kind === 'anchor_edge') {
    return toEdgeCheck(raw, 'anchor_edge');
  }

  if (kind === 'member_edge') {
    return toEdgeCheck(raw, 'member_edge');
  }

  return null;
};

const toRule = (raw: any, index: number): GraphExpectationRule | null => {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.enabled === false) return null;

  const fallbackId = `rule_${index + 1}`;
  const id = normalizeRuleId(raw.id, fallbackId);
  const expectAllRaw = Array.isArray(raw.expectAll) ? raw.expectAll : (Array.isArray(raw.expect) ? raw.expect : []);
  const checks = expectAllRaw
    .map(item => toCheck(item))
    .filter((item): item is GraphExpectationCheck => !!item);

  if (checks.length === 0) return null;

  const tier = parseTier(raw.absenceTier);
  const severity = parseSeverity(raw.severity);
  const gapTypeRaw = String(raw.gapType || '').trim();

  return {
    id,
    description: String(raw.description || '').trim(),
    enabled: true,
    scope: toScope(raw.scope),
    checks,
    ...(gapTypeRaw ? { gapType: sanitizeGapKey(gapTypeRaw) || `expectation_${id}` } : {}),
    ...(tier ? { absenceTier: tier } : {}),
    ...(severity ? { severity } : {}),
    evidence: normalizeArray(raw.evidence),
  };
};

const loadGraphExpectationRules = async (options: GapProcessorOptions): Promise<GraphExpectationLoadResult> => {
  const errors: string[] = [];
  let rawJson = String(options.expectationJson || '').trim();

  if (!rawJson) {
    const repoPath = String(options.repoPath || '').trim();
    if (!repoPath) return { rules: [], errors };

    const expectationPath = String(options.expectationPath || DEFAULT_GRAPH_EXPECTATION_PATH).trim() || DEFAULT_GRAPH_EXPECTATION_PATH;
    const resolvedPath = path.isAbsolute(expectationPath)
      ? expectationPath
      : path.join(repoPath, normalizePath(expectationPath));

    try {
      rawJson = await fs.readFile(resolvedPath, 'utf-8');
    } catch {
      return { rules: [], errors };
    }
  }

  if (!rawJson.trim()) return { rules: [], errors };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    errors.push(`graph-expectation:invalid-json:${error instanceof Error ? error.message : String(error)}`);
    return { rules: [], errors };
  }

  const rawRules = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).rules))
      ? (parsed as any).rules
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).expectations))
        ? (parsed as any).expectations
        : [];

  if (!Array.isArray(rawRules)) {
    errors.push('graph-expectation:missing-rules-array');
    return { rules: [], errors };
  }

  const rules: GraphExpectationRule[] = [];
  for (let i = 0; i < rawRules.length; i++) {
    const rule = toRule(rawRules[i], i);
    if (!rule) continue;
    rules.push(rule);
  }

  return { rules, errors };
};

const addGap = (
  gaps: GapNode[],
  links: GapLink[],
  dedupe: Set<string>,
  gap: Omit<GapNode, 'id' | 'label' | 'heuristicLabel'>,
): void => {
  const tier = gap.absenceTier;
  const keyParts = [
    gap.sliceId,
    gap.gapType,
    tier,
    gap.missingSlots.join('|'),
    gap.evidence.join('|'),
  ];
  const dedupeKey = keyParts.join('::');
  if (dedupe.has(dedupeKey)) return;
  dedupe.add(dedupeKey);

  const suffix = sanitizeGapKey(dedupeKey) || `${gaps.length + 1}`;
  const id = generateId('Gap', `gap_${suffix}`);
  const title = `Gap: ${gap.gapType.replace(/_/g, ' ')} (${tier.replace(/_/g, ' ')})`;

  gaps.push({
    id,
    label: title,
    heuristicLabel: title,
    ...gap,
  });

  links.push({
    gapId: id,
    sliceId: gap.sliceId,
  });
};

const matchesScope = (meta: SliceMeta, scope: GraphExpectationScope): boolean => {
  const sliceType = meta.sliceType.toLowerCase();
  const anchorName = meta.anchorName.toLowerCase();
  const anchorId = meta.anchorId.toLowerCase();

  if (scope.sliceType.length > 0 && !scope.sliceType.includes(sliceType)) return false;

  if (scope.anchorNameIncludes.length > 0 && !scope.anchorNameIncludes.some(token => anchorName.includes(token))) {
    return false;
  }

  if (scope.anchorNameStartsWith.length > 0 && !scope.anchorNameStartsWith.some(token => anchorName.startsWith(token))) {
    return false;
  }

  if (scope.anchorIdIncludes.length > 0 && !scope.anchorIdIncludes.some(token => anchorId.includes(token))) {
    return false;
  }

  if (scope.anchorIdStartsWith.length > 0 && !scope.anchorIdStartsWith.some(token => anchorId.startsWith(token))) {
    return false;
  }

  if (scope.anchorNameRegex) {
    try {
      const regex = new RegExp(scope.anchorNameRegex);
      if (!regex.test(meta.anchorName)) return false;
    } catch {
      return false;
    }
  }

  return true;
};

const edgeMatches = (
  edge: GraphRelationship,
  check: GraphExpectationEdgeCheck,
  direction: ExpectationDirection,
  nodeById: Map<string, GraphNode>,
): boolean => {
  if (check.type.length > 0 && !check.type.includes(String(edge.type).toUpperCase())) return false;
  if (check.minConfidence !== undefined && (Number(edge.confidence) || 0) < check.minConfidence) return false;

  const reason = String(edge.reason || '').toLowerCase();
  if (check.reasonStartsWith.length > 0 && !check.reasonStartsWith.some(token => reason.startsWith(token))) {
    return false;
  }
  if (check.reasonIncludes.length > 0 && !check.reasonIncludes.some(token => reason.includes(token))) {
    return false;
  }

  const counterpartId = direction === 'incoming' ? edge.sourceId : edge.targetId;
  const counterpart = nodeById.get(counterpartId);
  if (!counterpart) return false;

  const counterpartLabel = String(counterpart.label || '').toLowerCase();
  if (check.counterpartLabel.length > 0 && !check.counterpartLabel.includes(counterpartLabel)) {
    return false;
  }

  const counterpartName = String(counterpart.properties?.name || '').toLowerCase();
  if (check.counterpartNameStartsWith.length > 0 && !check.counterpartNameStartsWith.some(token => counterpartName.startsWith(token))) {
    return false;
  }
  if (check.counterpartNameIncludes.length > 0 && !check.counterpartNameIncludes.some(token => counterpartName.includes(token))) {
    return false;
  }

  return true;
};

const evaluateCheck = (
  check: GraphExpectationCheck,
  meta: SliceMeta,
  nodeById: Map<string, GraphNode>,
  indexes: EdgeIndexes,
): boolean => {
  if (check.kind === 'closed_slot') {
    return meta.closedSlots.has(check.slot);
  }

  if (check.kind === 'member_role') {
    return meta.memberships.some(member => member.role.toLowerCase() === check.role);
  }

  const direction = check.direction || 'outgoing';
  const pickEdges = (nodeId: string): GraphRelationship[] => {
    return direction === 'incoming'
      ? (indexes.incoming.get(nodeId) || [])
      : (indexes.outgoing.get(nodeId) || []);
  };

  if (check.kind === 'anchor_edge') {
    const edges = pickEdges(meta.anchorId);
    return edges.some(edge => edgeMatches(edge, check, direction, nodeById));
  }

  const fromRole = String(check.fromRole || '').toLowerCase();
  if (!fromRole) return false;

  const roleMembers = meta.memberships
    .filter(member => member.role.toLowerCase() === fromRole)
    .map(member => member.nodeId);
  if (roleMembers.length === 0) return false;

  for (const memberId of roleMembers) {
    const edges = pickEdges(memberId);
    if (edges.some(edge => edgeMatches(edge, check, direction, nodeById))) return true;
  }

  return false;
};

const missingSlotForCheck = (check: GraphExpectationCheck): string => {
  if (check.kind === 'closed_slot') return check.missingSlot || check.slot;
  if (check.kind === 'member_role') return check.missingSlot || check.role;
  if (check.kind === 'anchor_edge') {
    return check.missingSlot
      || `anchor_edge_${sanitizeGapKey(check.type[0] || 'any') || 'any'}`;
  }
  return check.missingSlot
    || `${sanitizeGapKey(check.fromRole || 'member') || 'member'}_edge_${sanitizeGapKey(check.type[0] || 'any') || 'any'}`;
};

export const processGaps = async (
  knowledgeGraph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void,
  options: GapProcessorOptions = {},
): Promise<GapDetectionResult> => {
  onProgress?.('Scanning feature slices for absence signals...', 0);

  const nodeById = new Map<string, GraphNode>();
  knowledgeGraph.nodes.forEach(node => nodeById.set(node.id, node));
  const edgeIndexes = buildEdgeIndexes(knowledgeGraph);

  const slices = knowledgeGraph.nodes.filter(node => node.label === 'FeatureSlice');
  if (slices.length === 0) {
    return {
      gaps: [],
      links: [],
      stats: {
        totalGaps: 0,
        deterministic: 0,
        pattern: 0,
        heuristic: 0,
        expectation: 0,
        expectationRulesEvaluated: 0,
        expectationRuleApplications: 0,
        expectationErrors: 0,
      },
    };
  }

  const membershipsBySlice = new Map<string, SliceMembership[]>();
  for (const rel of knowledgeGraph.relationships) {
    if (rel.type !== 'MEMBER_OF') continue;
    if (typeof rel.reason !== 'string' || !rel.reason.startsWith('feature-slice:')) continue;

    const target = nodeById.get(rel.targetId);
    if (!target || target.label !== 'FeatureSlice') continue;

    const list = membershipsBySlice.get(rel.targetId) || [];
    list.push({
      nodeId: rel.sourceId,
      role: rel.reason.replace('feature-slice:', ''),
    });
    membershipsBySlice.set(rel.targetId, list);
  }

  const gaps: GapNode[] = [];
  const links: GapLink[] = [];
  const dedupe = new Set<string>();

  let deterministic = 0;
  let pattern = 0;
  let heuristic = 0;
  let expectation = 0;
  let expectationRulesEvaluated = 0;
  let expectationRuleApplications = 0;
  let expectationErrors = 0;

  const sliceMeta: SliceMeta[] = slices.map(slice => {
    const requiredSlots = normalizeArray((slice.properties as any).closureSlots).map(slot => slot.toLowerCase());
    const closedSlotValues = normalizeArray((slice.properties as any).closedSlots).map(slot => slot.toLowerCase());
    const closedSlots = new Set(closedSlotValues);
    const missingSlots = requiredSlots.filter(slot => !closedSlots.has(slot));
    const memberships = membershipsBySlice.get(slice.id) || [];
    const hasTestCompanion = memberships.some(m => {
      const memberNode = nodeById.get(m.nodeId);
      return !!memberNode && isTestFilePath(memberNode.properties?.filePath || '');
    });
    return {
      slice,
      requiredSlots,
      closedSlots,
      missingSlots,
      memberships,
      hasTestCompanion,
      sliceType: String((slice.properties as any).sliceType || ''),
      anchorId: String((slice.properties as any).anchorId || ''),
      anchorName: String((slice.properties as any).anchorName || ''),
    };
  });

  for (const meta of sliceMeta) {
    if (meta.missingSlots.length > 0) {
      deterministic++;
      addGap(gaps, links, dedupe, {
        gapType: 'slice_closure_missing',
        absenceTier: 'deterministic_missing',
        severity: 'high',
        sliceId: meta.slice.id,
        anchorId: meta.anchorId,
        missingSlots: meta.missingSlots,
        evidence: [`anchor:${meta.anchorName}`],
      });
    }
  }

  onProgress?.('Evaluating sibling slice patterns...', 45);

  const slicesByType = new Map<string, SliceMeta[]>();
  for (const meta of sliceMeta) {
    const key = meta.sliceType || 'unknown';
    const group = slicesByType.get(key) || [];
    group.push(meta);
    slicesByType.set(key, group);
  }

  for (const [sliceType, group] of slicesByType) {
    if (group.length < 2) continue;

    const withTests = group.filter(item => item.hasTestCompanion).length;
    const coverageRatio = withTests / group.length;
    if (coverageRatio < 0.6 || withTests < 2) continue;

    for (const meta of group) {
      if (meta.hasTestCompanion) continue;
      pattern++;
      addGap(gaps, links, dedupe, {
        gapType: 'missing_test_companion',
        absenceTier: 'pattern_missing',
        severity: 'medium',
        sliceId: meta.slice.id,
        anchorId: meta.anchorId,
        missingSlots: ['tests'],
        evidence: [`slice_type:${sliceType}`, `sibling_test_coverage:${withTests}/${group.length}`],
      });
    }
  }

  onProgress?.('Evaluating graph expectation rules...', 70);

  const loadedExpectations = await loadGraphExpectationRules(options);
  expectationErrors += loadedExpectations.errors.length;

  for (const rule of loadedExpectations.rules) {
    if (!rule.enabled) continue;
    expectationRulesEvaluated++;

    for (const meta of sliceMeta) {
      if (!matchesScope(meta, rule.scope)) continue;
      expectationRuleApplications++;

      const missingSlots = rule.checks
        .filter(check => !evaluateCheck(check, meta, nodeById, edgeIndexes))
        .map(check => missingSlotForCheck(check));
      if (missingSlots.length === 0) continue;

      expectation++;
      const tier = rule.absenceTier || 'deterministic_missing';
      if (tier === 'deterministic_missing') deterministic++;
      else if (tier === 'pattern_missing') pattern++;
      else heuristic++;

      const uniqueMissingSlots = Array.from(new Set(missingSlots.filter(Boolean)));
      const ruleGapType = rule.gapType || `expectation_${sanitizeGapKey(rule.id) || 'missing'}`;
      const ruleEvidence = [
        `expectation:${rule.id}`,
        ...(rule.description ? [`expectation_desc:${rule.description}`] : []),
        ...rule.evidence,
      ];

      addGap(gaps, links, dedupe, {
        gapType: ruleGapType,
        absenceTier: tier,
        severity: rule.severity || 'high',
        sliceId: meta.slice.id,
        anchorId: meta.anchorId,
        missingSlots: uniqueMissingSlots,
        evidence: [`anchor:${meta.anchorName}`, ...ruleEvidence],
      });
    }
  }

  onProgress?.('Adding heuristic suspicion gaps...', 88);

  for (const meta of sliceMeta) {
    const memberCount = meta.memberships.length;
    if (memberCount > 1) continue;

    heuristic++;
    addGap(gaps, links, dedupe, {
      gapType: 'sparse_slice_signal',
      absenceTier: 'heuristic_suspicion',
      severity: 'low',
      sliceId: meta.slice.id,
      anchorId: meta.anchorId,
      missingSlots: [],
      evidence: [`member_count:${memberCount}`],
    });
  }

  onProgress?.('Gap graph extraction complete.', 100);

  return {
    gaps,
    links,
    stats: {
      totalGaps: gaps.length,
      deterministic,
      pattern,
      heuristic,
      expectation,
      expectationRulesEvaluated,
      expectationRuleApplications,
      expectationErrors,
    },
  };
};
