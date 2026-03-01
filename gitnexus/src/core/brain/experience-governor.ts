import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import {
  BrainTickInput,
  ExperienceCard,
  ExperienceCardStage,
  ExperienceCardType,
  ExperienceCardView,
  ExperienceGovernorSummary,
  PlanEnvelope,
  RuntimeTruthSummary,
} from './types.js';

const EXPERIENCE_STORE_SCHEMA_VERSION = 1;
const EXPERIENCE_STORE_FILE = 'experience-cards.json';
const MAX_CARDS = 400;
const MAX_RETRIEVED_CARDS = 5;

interface ExperienceStore {
  schemaVersion: number;
  cards: ExperienceCard[];
}

interface Segment {
  stage: ExperienceCardStage;
  trigger: string;
  supportingProof: string[];
}

const nowIso = (): string => new Date().toISOString();

const normalizePath = (value: unknown): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const hashValue = (value: string): string => {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
};

const getStorePath = (storagePath: string): string => {
  return path.join(storagePath, 'manifests', EXPERIENCE_STORE_FILE);
};

const emptyStore = (): ExperienceStore => ({
  schemaVersion: EXPERIENCE_STORE_SCHEMA_VERSION,
  cards: [],
});

const loadStore = async (storagePath: string): Promise<ExperienceStore> => {
  try {
    const raw = await fs.readFile(getStorePath(storagePath), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || Number(parsed.schemaVersion) !== EXPERIENCE_STORE_SCHEMA_VERSION || !Array.isArray(parsed.cards)) {
      return emptyStore();
    }
    return {
      schemaVersion: EXPERIENCE_STORE_SCHEMA_VERSION,
      cards: parsed.cards,
    };
  } catch {
    return emptyStore();
  }
};

const saveStore = async (storagePath: string, store: ExperienceStore): Promise<string> => {
  const filePath = getStorePath(storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
  return filePath;
};

const createTaxonomyCounts = (): Record<ExperienceCardType, number> => ({
  query: 0,
  review: 0,
  implement: 0,
  debug: 0,
  'anti-pattern': 0,
  runtime: 0,
  'constraint-exception': 0,
});

const createStageCounts = (): Record<ExperienceCardStage, number> => ({
  anchor: 0,
  expand: 0,
  probe: 0,
  patch: 0,
  verify: 0,
});

const inferSliceFamily = (plan: PlanEnvelope): string | undefined => {
  const filePath = normalizePath(plan.anchors.find(anchor => anchor.filePath)?.filePath || '');
  if (!filePath) return undefined;
  const parts = filePath.split('/');
  if (parts.length <= 1) return parts[0];
  return `${parts[0]}/${parts[1]}`;
};

const buildSegments = (input: BrainTickInput, plan: PlanEnvelope, runtimeTruth?: RuntimeTruthSummary): Segment[] => {
  const segments: Segment[] = [];
  const topAnchors = plan.anchors.slice(0, 3).map(anchor => anchor.label);
  if (topAnchors.length > 0) {
    segments.push({
      stage: 'anchor',
      trigger: `anchors:${topAnchors.join(', ')}`,
      supportingProof: topAnchors,
    });
  }

  if (plan.operators.some(operator => operator.name === 'expand_slice')) {
    segments.push({
      stage: 'expand',
      trigger: `operators:${plan.operators.length}`,
      supportingProof: plan.operators.slice(0, 5).map(operator => operator.name),
    });
  }

  if ((plan.requestedProbes || []).length > 0) {
    segments.push({
      stage: 'probe',
      trigger: `probes:${plan.requestedProbes.length}`,
      supportingProof: plan.requestedProbes
        .flatMap(probe => probe.targetFamilies)
        .slice(0, 6),
    });
  }

  if (plan.mode === 'implement' || plan.mode === 'review') {
    segments.push({
      stage: 'patch',
      trigger: `changed-paths:${(input.changedPaths || []).length}`,
      supportingProof: (input.changedPaths || []).map(normalizePath).filter(Boolean).slice(0, 6),
    });
  }

  segments.push({
    stage: 'verify',
    trigger: `proof-objectives:${plan.proofObjectives.length}`,
    supportingProof: plan.proofObjectives.map(item => item.id).slice(0, 6),
  });

  if ((runtimeTruth?.contradictions || []).length > 0) {
    segments.push({
      stage: 'probe',
      trigger: `runtime-contradictions:${runtimeTruth?.contradictions.length || 0}`,
      supportingProof: runtimeTruth?.contradictions.map(item => item.id).slice(0, 6) || [],
    });
  }

  return segments;
};

const inferCardType = (
  mode: PlanEnvelope['mode'],
  stage: ExperienceCardStage,
  runtimeTruth?: RuntimeTruthSummary,
): ExperienceCardType => {
  if (stage === 'probe' && (runtimeTruth?.witnesses.length || 0) > 0) return 'runtime';
  if (stage === 'probe' && (runtimeTruth?.contradictions.length || 0) > 0) return 'anti-pattern';
  if (mode === 'query') return 'query';
  if (mode === 'review') return 'review';
  if (mode === 'implement') return 'implement';
  return 'debug';
};

const inferOutcome = (
  stage: ExperienceCardStage,
  runtimeTruth?: RuntimeTruthSummary,
): ExperienceCard['outcome'] => {
  if (stage === 'probe') {
    if ((runtimeTruth?.contradictions || []).length > 0) return 'failure';
    if ((runtimeTruth?.witnesses || []).length > 0) return 'success';
    return 'partial';
  }
  if (stage === 'verify' && (runtimeTruth?.witnesses || []).length === 0) return 'partial';
  return 'success';
};

const scoreCard = (
  outcome: ExperienceCard['outcome'],
  mode: PlanEnvelope['mode'],
  stage: ExperienceCardStage,
): { utilityScore: number; trustScore: number; freshnessScore: number } => {
  const outcomeScore = outcome === 'success' ? 0.86 : outcome === 'partial' ? 0.6 : 0.38;
  const modeBonus = mode === 'debug' ? 0.06 : mode === 'implement' ? 0.04 : 0.02;
  const stageBonus = stage === 'verify' ? 0.04 : stage === 'probe' ? 0.05 : 0.02;
  return {
    utilityScore: Math.min(1, outcomeScore + modeBonus + stageBonus),
    trustScore: outcome === 'failure' ? 0.72 : 0.86,
    freshnessScore: 1,
  };
};

const toLesson = (mode: PlanEnvelope['mode'], stage: ExperienceCardStage, trigger: string, outcome: ExperienceCard['outcome']): string => {
  if (stage === 'probe' && outcome === 'failure') {
    return `Do not over-trust static intuition when ${trigger}; prefer runtime witness collection first.`;
  }
  if (stage === 'probe') {
    return `Runtime probe planning for ${mode} should begin from ${trigger}.`;
  }
  if (stage === 'patch') {
    return `For ${mode}, companion edits should stay within the anchored slice family before expanding scope.`;
  }
  if (stage === 'verify') {
    return `Verification should close required proof objectives tied to ${trigger}.`;
  }
  return `For ${mode}, use ${stage} stage evidence from ${trigger} before progressing.`;
};

const buildCard = (
  input: BrainTickInput,
  plan: PlanEnvelope,
  segment: Segment,
  runtimeTruth?: RuntimeTruthSummary,
): ExperienceCard => {
  const type = inferCardType(plan.mode, segment.stage, runtimeTruth);
  const outcome = inferOutcome(segment.stage, runtimeTruth);
  const score = scoreCard(outcome, plan.mode, segment.stage);
  const idBase = `${input.repoFingerprint}|${plan.mode}|${type}|${segment.stage}|${segment.trigger}`;
  const timestamp = nowIso();
  return {
    id: `exp:${hashValue(idBase)}`,
    repoFingerprint: input.repoFingerprint,
    mode: plan.mode,
    type,
    sliceFamily: inferSliceFamily(plan),
    stage: segment.stage,
    trigger: segment.trigger,
    lesson: toLesson(plan.mode, segment.stage, segment.trigger, outcome),
    supportingProof: segment.supportingProof,
    applicableWhen: [
      `mode:${plan.mode}`,
      `stage:${segment.stage}`,
      ...(segment.stage === 'probe' ? ['runtime-available-or-requested'] : []),
    ],
    notApplicableWhen: [
      ...(segment.stage === 'probe' ? ['no-runtime-data-and-no-probe-request'] : []),
    ],
    outcome,
    utilityScore: score.utilityScore,
    trustScore: score.trustScore,
    freshnessScore: score.freshnessScore,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

const decayCards = (cards: ExperienceCard[], repoFingerprint: string): { retained: ExperienceCard[]; dropped: number } => {
  const retained: ExperienceCard[] = [];
  let dropped = 0;
  for (const card of cards) {
    const repoMatch = card.repoFingerprint === repoFingerprint;
    const freshnessMultiplier = repoMatch ? 0.98 : 0.72;
    const utilityMultiplier = repoMatch ? 0.96 : 0.8;
    const nextFreshness = Math.max(0, Number(card.freshnessScore || 0) * freshnessMultiplier);
    const nextUtility = Math.max(0, Number(card.utilityScore || 0) * utilityMultiplier);
    const nextTrust = Math.max(0, Number(card.trustScore || 0) * (repoMatch ? 1 : 0.9));
    if (nextUtility < 0.15 || nextFreshness < 0.12 || nextTrust < 0.2) {
      dropped += 1;
      continue;
    }
    retained.push({
      ...card,
      utilityScore: Number(nextUtility.toFixed(4)),
      freshnessScore: Number(nextFreshness.toFixed(4)),
      trustScore: Number(nextTrust.toFixed(4)),
      updatedAt: nowIso(),
    });
  }
  return { retained, dropped };
};

const mergeCards = (existingCards: ExperienceCard[], generatedCards: ExperienceCard[]): ExperienceCard[] => {
  const byId = new Map<string, ExperienceCard>();
  for (const card of existingCards) {
    byId.set(card.id, card);
  }
  for (const card of generatedCards) {
    const existing = byId.get(card.id);
    if (!existing) {
      byId.set(card.id, card);
      continue;
    }
    byId.set(card.id, {
      ...existing,
      ...card,
      utilityScore: Number(Math.max(existing.utilityScore, card.utilityScore).toFixed(4)),
      trustScore: Number(Math.max(existing.trustScore, card.trustScore).toFixed(4)),
      freshnessScore: Number(Math.max(existing.freshnessScore, card.freshnessScore).toFixed(4)),
      updatedAt: nowIso(),
    });
  }
  return Array.from(byId.values())
    .sort((a, b) => (b.utilityScore * b.trustScore * b.freshnessScore) - (a.utilityScore * a.trustScore * a.freshnessScore))
    .slice(0, MAX_CARDS);
};

const selectCards = (
  cards: ExperienceCard[],
  plan: PlanEnvelope,
  runtimeTruth?: RuntimeTruthSummary,
): ExperienceCardView[] => {
  const planStages = new Set<ExperienceCardStage>();
  for (const operator of plan.operators) {
    if (operator.name === 'resolve_anchor') planStages.add('anchor');
    if (operator.name === 'expand_slice') planStages.add('expand');
    if (operator.name === 'request_runtime_probe') planStages.add('probe');
  }
  if (plan.mode === 'implement' || plan.mode === 'review') planStages.add('patch');
  planStages.add('verify');

  const hasRuntimeContradictions = (runtimeTruth?.contradictions || []).length > 0;
  const hasRuntimeWitnesses = (runtimeTruth?.witnesses || []).length > 0;
  return cards
    .filter(card => card.mode === plan.mode || card.type === 'anti-pattern' || card.type === 'runtime')
    .filter(card => {
      if (hasRuntimeContradictions) return true;
      if (!hasRuntimeWitnesses && card.notApplicableWhen.includes('no-runtime-data-and-no-probe-request')) return false;
      return true;
    })
    .map(card => {
      const stageBonus = planStages.has(card.stage) ? 0.25 : 0;
      const contradictionBonus = hasRuntimeContradictions && card.type === 'anti-pattern' ? 0.3 : 0;
      const score = (card.utilityScore * card.trustScore * card.freshnessScore) + stageBonus + contradictionBonus;
      return { card, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RETRIEVED_CARDS)
    .map(item => ({
      id: item.card.id,
      type: item.card.type,
      stage: item.card.stage,
      lesson: item.card.lesson,
      utility: Number(item.card.utilityScore.toFixed(4)),
      outcome: item.card.outcome,
    }));
};

const summarize = (
  cards: ExperienceCard[],
  generatedCards: ExperienceCard[],
  dropped: number,
  retrievedCards: ExperienceCardView[],
  storePath: string,
  warnings: string[],
): ExperienceGovernorSummary => {
  const taxonomy = createTaxonomyCounts();
  const stages = createStageCounts();
  for (const card of cards) {
    taxonomy[card.type] += 1;
    stages[card.stage] += 1;
  }
  return {
    generatedAt: nowIso(),
    storePath,
    totals: {
      cards: cards.length,
      generated: generatedCards.length,
      retained: cards.length - generatedCards.length,
      dropped,
    },
    taxonomy,
    stages,
    retrievedCards,
    warnings,
  };
};

export const runExperienceGovernor = async (
  input: BrainTickInput,
  plan: PlanEnvelope,
  runtimeTruth?: RuntimeTruthSummary,
): Promise<ExperienceGovernorSummary> => {
  const warnings: string[] = [];
  const store = await loadStore(input.storagePath);
  const decayed = decayCards(store.cards, input.repoFingerprint);
  const segments = buildSegments(input, plan, runtimeTruth);
  if (segments.length === 0) warnings.push('No subtask segments inferred for this tick.');

  const generatedCards = segments.map(segment => buildCard(input, plan, segment, runtimeTruth));
  if ((runtimeTruth?.contradictions || []).length > 0) {
    generatedCards.push(buildCard(input, plan, {
      stage: 'probe',
      trigger: `contradiction-filter:${runtimeTruth?.contradictions.length || 0}`,
      supportingProof: runtimeTruth?.contradictions.map(item => item.id).slice(0, 6) || [],
    }, runtimeTruth));
  }

  const mergedCards = mergeCards(decayed.retained, generatedCards);
  const retrievedCards = selectCards(mergedCards, plan, runtimeTruth);
  const storePath = await saveStore(input.storagePath, {
    schemaVersion: EXPERIENCE_STORE_SCHEMA_VERSION,
    cards: mergedCards,
  });

  return summarize(mergedCards, generatedCards, decayed.dropped, retrievedCards, storePath, warnings);
};
