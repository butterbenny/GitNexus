import {
  GraphRelationship,
  RelationshipAbsenceSemantics,
  RelationshipCertaintyTier,
} from './types.js';

const CERTAINTY_TIERS = new Set<RelationshipCertaintyTier>([
  'deterministic',
  'typed',
  'historical',
  'semantic',
  'heuristic',
]);

const ABSENCE_SEMANTICS = new Set<RelationshipAbsenceSemantics>([
  'closed_world',
  'open_world',
  'not_applicable',
]);

const normalizeToken = (value: unknown): string => {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_./-]+/g, '_')
    .replace(/^_+|_+$/g, '');
};

const normalizeFamilyToken = (value: unknown): string => {
  return normalizeToken(value).replace(/[:./-]+/g, '_').replace(/^_+|_+$/g, '');
};

const normalizeTier = (value: unknown): RelationshipCertaintyTier | undefined => {
  const token = normalizeToken(value) as RelationshipCertaintyTier;
  return CERTAINTY_TIERS.has(token) ? token : undefined;
};

const normalizeAbsenceSemantics = (value: unknown): RelationshipAbsenceSemantics | undefined => {
  const token = normalizeToken(value) as RelationshipAbsenceSemantics;
  return ABSENCE_SEMANTICS.has(token) ? token : undefined;
};

const dedupe = (values: string[], limit = 8): string[] => {
  return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean))).slice(0, limit);
};

const inferProvenanceFamily = (relationship: GraphRelationship): string => {
  const explicit = normalizeFamilyToken(relationship.provenanceFamily);
  if (explicit) return explicit;

  const reason = normalizeToken(relationship.reason);

  if (relationship.type === 'CO_CHANGES_WITH' || reason.startsWith('git-history:')) return 'historical_cochange';
  if (reason.startsWith('precision-overlay:')) return 'precision_overlay';
  if (reason.startsWith('micro-dataflow:')) return 'micro_dataflow';
  if (reason.startsWith('value-graph:')) return 'value_graph';
  if (reason.startsWith('provenance:')) return 'provenance';
  if (reason.startsWith('feature-slice:') || reason.startsWith('gap:')) return 'slice_closure';
  if (
    relationship.type === 'VALIDATES_FIELD'
    || relationship.type === 'SERIALIZES_FIELD'
    || relationship.type === 'READS_FIELD'
    || relationship.type === 'WRITES_FIELD'
    || relationship.type === 'INVALIDATES_KEY'
    || reason.startsWith('shape:')
    || reason.startsWith('contract-shape:')
    || reason.startsWith('laravel-form-request:')
    || reason.startsWith('laravel-resource:')
    || reason.startsWith('react-query:')
  ) {
    return 'contract_shape';
  }
  if (
    relationship.type === 'TESTS_SHAPE'
    || reason.startsWith('test-case:')
    || reason.startsWith('test-')
    || reason.startsWith('test-closure:')
  ) {
    return 'test_closure';
  }
  if (reason.startsWith('http-') || reason.startsWith('laravel-endpoint:')) return 'http_routing';
  if (reason.startsWith('laravel-')) return 'framework_laravel';
  if (reason.startsWith('blade-') || reason.startsWith('mjml-')) return 'template_wiring';

  const reasonPrefix = normalizeFamilyToken(reason.split(':')[0]);
  if (reasonPrefix) return reasonPrefix;
  if (relationship.type === 'STEP_IN_PROCESS') return 'process';
  if (relationship.type === 'MEMBER_OF') return 'membership';
  return 'structural';
};

const inferCertaintyTier = (
  relationship: GraphRelationship,
  provenanceFamily: string,
): RelationshipCertaintyTier => {
  const explicit = normalizeTier(relationship.certaintyTier);
  if (explicit) return explicit;

  const confidence = Number(relationship.confidence) || 0;
  const reason = normalizeToken(relationship.reason);

  if (confidence > 0 && confidence < 0.65) return 'heuristic';
  if (relationship.type === 'CO_CHANGES_WITH' || provenanceFamily === 'historical_cochange') return 'historical';
  if (provenanceFamily === 'precision_overlay' || provenanceFamily === 'micro_dataflow' || provenanceFamily === 'value_graph') {
    return 'semantic';
  }
  if (
    provenanceFamily === 'contract_shape'
    || provenanceFamily === 'slice_closure'
    || provenanceFamily === 'test_closure'
    || provenanceFamily === 'http_routing'
    || provenanceFamily === 'framework_laravel'
    || provenanceFamily === 'provenance'
    || relationship.type === 'VALIDATES_FIELD'
    || relationship.type === 'SERIALIZES_FIELD'
    || relationship.type === 'READS_FIELD'
    || relationship.type === 'WRITES_FIELD'
    || relationship.type === 'INVALIDATES_KEY'
    || relationship.type === 'TESTS_SHAPE'
  ) {
    return 'typed';
  }
  if (reason.includes('fuzzy')) return 'heuristic';
  return 'deterministic';
};

const inferAbsenceSemantics = (
  relationship: GraphRelationship,
  certaintyTier: RelationshipCertaintyTier,
): RelationshipAbsenceSemantics => {
  const explicit = normalizeAbsenceSemantics(relationship.absenceSemantics);
  if (explicit) return explicit;

  const reason = normalizeToken(relationship.reason);
  if (relationship.type === 'CO_CHANGES_WITH' || certaintyTier === 'historical' || certaintyTier === 'semantic') {
    return 'open_world';
  }
  if (
    relationship.type === 'VALIDATES_FIELD'
    || relationship.type === 'SERIALIZES_FIELD'
    || relationship.type === 'INVALIDATES_KEY'
    || relationship.type === 'TESTS_SHAPE'
    || reason.startsWith('feature-slice:')
    || reason.startsWith('gap:')
  ) {
    return 'closed_world';
  }
  return 'not_applicable';
};

export const parseWitnessPathIds = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return dedupe(value.map(item => normalizeToken(item)).filter(Boolean));
  }
  const text = String(value || '').trim();
  if (!text) return [];
  return dedupe(text.split('|').map(item => normalizeToken(item)).filter(Boolean));
};

export const serializeWitnessPathIds = (value: unknown): string => {
  return parseWitnessPathIds(value).join('|');
};

const inferWitnessPathIds = (
  relationship: GraphRelationship,
  provenanceFamily: string,
): string[] => {
  const inferred: string[] = [];
  const edgeId = normalizeToken(relationship.id);
  if (edgeId) inferred.push(`edge:${edgeId}`);
  if (relationship.step && Number(relationship.step) > 0) inferred.push(`step:${Math.floor(Number(relationship.step))}`);
  if (provenanceFamily) inferred.push(`family:${provenanceFamily}`);
  return dedupe(inferred, 6);
};

export const enrichRelationshipMetadata = (relationship: GraphRelationship): GraphRelationship => {
  const provenanceFamily = inferProvenanceFamily(relationship);
  const certaintyTier = inferCertaintyTier(relationship, provenanceFamily);
  const absenceSemantics = inferAbsenceSemantics(relationship, certaintyTier);
  const witnessPathIds = parseWitnessPathIds(relationship.witnessPathIds);

  return {
    ...relationship,
    provenanceFamily,
    certaintyTier,
    absenceSemantics,
    witnessPathIds: witnessPathIds.length > 0 ? witnessPathIds : inferWitnessPathIds(relationship, provenanceFamily),
  };
};
