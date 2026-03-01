import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import {
  BrainPacket,
  BrainTickInput,
  BridgePacket,
  ConstraintGraphSummary,
  GraphModelBridgeSummary,
  PlanEnvelope,
} from './types.js';

const BRIDGE_STORE_SCHEMA_VERSION = 1;
const BRIDGE_STORE_FILE = 'bridge-packets.json';
const LEARNED_MODEL_SCHEMA_VERSION = 1;
const LEARNED_MODEL_VERSION = 'shadow-v1';
const LEARNED_MODEL_FILE = 'bridge-learned-model.json';
const MAX_BRIDGE_PACKETS = 400;
const MAX_LATEST_PACKETS = 8;
const MAX_SHADOW_PREDICTIONS = 8;
const MAX_PACKET_SLICES = 6;
const MAX_PACKET_PROOF_HASHES = 16;
const MAX_TOKENS_PER_SLICE = 80;
const LEARNED_BRIDGE_MIN_RUNS = 5;
const LEARNED_BRIDGE_MIN_PACKETS = 20;

interface BridgeStore {
  schemaVersion: number;
  runCount: number;
  packets: BridgePacket[];
}

interface LearnedSliceProfile {
  sliceId: string;
  tokenWeights: Record<string, number>;
  tokenCount: number;
}

interface LearnedBridgeModel {
  schemaVersion: number;
  modelVersion: string;
  trainedAt: string;
  packetCount: number;
  sliceProfiles: LearnedSliceProfile[];
}

const nowIso = (): string => new Date().toISOString();

const dedupe = <T>(items: T[]): T[] => Array.from(new Set(items));
const toTimestamp = (value: string): number => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

const sortPacketsByCreatedAt = (packets: BridgePacket[], direction: 'asc' | 'desc'): BridgePacket[] => {
  const sorted = packets.slice().sort((a, b) => {
    const delta = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
    if (delta !== 0) return delta;
    return a.id.localeCompare(b.id);
  });
  return direction === 'desc' ? sorted.reverse() : sorted;
};

const hashValue = (value: string): string => {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
};

const getStorePath = (storagePath: string): string => {
  return path.join(storagePath, 'manifests', BRIDGE_STORE_FILE);
};

const getModelPath = (storagePath: string): string => {
  return path.join(storagePath, 'manifests', LEARNED_MODEL_FILE);
};

const emptyStore = (): BridgeStore => ({
  schemaVersion: BRIDGE_STORE_SCHEMA_VERSION,
  runCount: 0,
  packets: [],
});

const normalizePacket = (raw: any): BridgePacket | null => {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const sliceId = String(raw.sliceId || '').trim();
  const topologySketch = String(raw.topologySketch || '').trim();
  const createdAt = String(raw.createdAt || '').trim() || nowIso();
  if (!id || !sliceId || !topologySketch) return null;

  const toStringList = (value: any): string[] => {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item || '').trim()).filter(Boolean);
  };

  return {
    id,
    sliceId,
    topologySketch,
    keyContracts: dedupe(toStringList(raw.keyContracts)).slice(0, 10),
    gaps: dedupe(toStringList(raw.gaps)).slice(0, 10),
    precedentHints: dedupe(toStringList(raw.precedentHints)).slice(0, 10),
    proofHashes: dedupe(toStringList(raw.proofHashes)).slice(0, MAX_PACKET_PROOF_HASHES),
    createdAt,
  };
};

const loadStore = async (storagePath: string): Promise<BridgeStore> => {
  try {
    const raw = await fs.readFile(getStorePath(storagePath), 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      !parsed
      || Number(parsed.schemaVersion) !== BRIDGE_STORE_SCHEMA_VERSION
      || !Array.isArray(parsed.packets)
    ) {
      return emptyStore();
    }
    return {
      schemaVersion: BRIDGE_STORE_SCHEMA_VERSION,
      runCount: Math.max(0, Number(parsed.runCount || parsed.packets.length || 0)),
      packets: sortPacketsByCreatedAt(
        parsed.packets
          .map((item: any) => normalizePacket(item))
          .filter((item: BridgePacket | null): item is BridgePacket => Boolean(item)),
        'asc',
      ),
    };
  } catch {
    return emptyStore();
  }
};

const saveStore = async (storagePath: string, store: BridgeStore): Promise<string> => {
  const filePath = getStorePath(storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
  return filePath;
};

const loadModel = async (storagePath: string): Promise<LearnedBridgeModel | null> => {
  try {
    const raw = await fs.readFile(getModelPath(storagePath), 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      !parsed
      || Number(parsed.schemaVersion) !== LEARNED_MODEL_SCHEMA_VERSION
      || !Array.isArray(parsed.sliceProfiles)
    ) {
      return null;
    }
    return {
      schemaVersion: LEARNED_MODEL_SCHEMA_VERSION,
      modelVersion: String(parsed.modelVersion || LEARNED_MODEL_VERSION),
      trainedAt: String(parsed.trainedAt || ''),
      packetCount: Math.max(0, Number(parsed.packetCount || 0)),
      sliceProfiles: parsed.sliceProfiles
        .map((item: any) => ({
          sliceId: String(item?.sliceId || ''),
          tokenWeights: item?.tokenWeights && typeof item.tokenWeights === 'object'
            ? item.tokenWeights
            : {},
          tokenCount: Math.max(0, Number(item?.tokenCount || 0)),
        }))
        .filter((item: LearnedSliceProfile) => item.sliceId.length > 0),
    };
  } catch {
    return null;
  }
};

const saveModel = async (storagePath: string, model: LearnedBridgeModel): Promise<string> => {
  const filePath = getModelPath(storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(model, null, 2), 'utf-8');
  return filePath;
};

const tokenize = (value: string): string[] => {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9:_/-]+/g, ' ')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(item => item.length >= 3);
};

const getPacketTokens = (packet: BridgePacket): string[] => {
  const source = [packet.topologySketch]
    .concat(packet.keyContracts)
    .concat(packet.gaps)
    .concat(packet.precedentHints)
    .join(' ');
  return tokenize(source);
};

const trainModel = (packets: BridgePacket[]): LearnedBridgeModel | null => {
  const bySlice = new Map<string, Map<string, number>>();
  for (const packet of packets) {
    const tokens = getPacketTokens(packet);
    if (tokens.length === 0) continue;
    const tokenCounts = bySlice.get(packet.sliceId) || new Map<string, number>();
    for (const token of tokens) {
      tokenCounts.set(token, Number(tokenCounts.get(token) || 0) + 1);
    }
    bySlice.set(packet.sliceId, tokenCounts);
  }

  const sliceProfiles: LearnedSliceProfile[] = Array.from(bySlice.entries())
    .map(([sliceId, tokenCounts]) => {
      const ranked = Array.from(tokenCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_TOKENS_PER_SLICE);
      const total = ranked.reduce((acc, item) => acc + Number(item[1] || 0), 0);
      if (total <= 0) return null;
      const tokenWeights = ranked.reduce<Record<string, number>>((acc, item) => {
        acc[item[0]] = Number((Number(item[1] || 0) / total).toFixed(4));
        return acc;
      }, {});
      return {
        sliceId,
        tokenWeights,
        tokenCount: total,
      };
    })
    .filter((item): item is LearnedSliceProfile => Boolean(item))
    .sort((a, b) => a.sliceId.localeCompare(b.sliceId));

  if (sliceProfiles.length === 0) return null;
  return {
    schemaVersion: LEARNED_MODEL_SCHEMA_VERSION,
    modelVersion: LEARNED_MODEL_VERSION,
    trainedAt: nowIso(),
    packetCount: packets.length,
    sliceProfiles,
  };
};

const predictWithModel = (
  model: LearnedBridgeModel,
  packets: BridgePacket[],
): Array<{ packetId: string; predictedSliceId: string; confidence: number }> => {
  const predictions: Array<{ packetId: string; predictedSliceId: string; confidence: number }> = [];
  for (const packet of packets.slice(0, MAX_SHADOW_PREDICTIONS)) {
    const tokens = getPacketTokens(packet);
    if (tokens.length === 0) continue;
    const scored = model.sliceProfiles
      .map(profile => {
        let score = 0;
        for (const token of tokens) {
          score += Number(profile.tokenWeights[token] || 0);
        }
        return {
          sliceId: profile.sliceId,
          score,
        };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (scored.length === 0) continue;
    const total = scored.reduce((acc, item) => acc + item.score, 0);
    const confidence = total > 0 ? Number((scored[0].score / total).toFixed(4)) : 0;
    predictions.push({
      packetId: packet.id,
      predictedSliceId: scored[0].sliceId,
      confidence,
    });
  }
  return predictions;
};

const resolveSliceIds = (plan: PlanEnvelope, brainPacket?: BrainPacket): string[] => {
  const fromPacket = (brainPacket?.primarySlices || []).map(item => item.id).filter(Boolean);
  const fromAnchors = plan.anchors
    .filter(anchor => anchor.kind === 'slice')
    .map(anchor => anchor.id)
    .filter(Boolean);
  const sliceIds = dedupe(fromPacket.concat(fromAnchors)).slice(0, MAX_PACKET_SLICES);
  if (sliceIds.length > 0) return sliceIds;
  return [`slice:${plan.mode}:${plan.contextShape}`];
};

const buildTopologySketch = (plan: PlanEnvelope): string => {
  const operatorFlow = plan.operators.map(item => item.name).slice(0, 8).join(' -> ');
  const anchors = plan.anchors.map(item => item.label).slice(0, 3).join(', ');
  const sketch = `${plan.mode}/${plan.contextShape} | anchors: ${anchors || 'none'} | ops: ${operatorFlow || 'none'}`;
  return sketch.slice(0, 220);
};

const buildProofHashes = (
  plan: PlanEnvelope,
  brainPacket?: BrainPacket,
): string[] => {
  const claims = dedupe(
    plan.proofObjectives.map(item => item.id)
      .concat(brainPacket?.proofPack.objectives.map(item => item.id) || [])
      .concat(brainPacket?.runtimeWitnesses.map(item => item.id) || [])
      .concat(brainPacket?.constraints.map(item => item.id) || []),
  );
  return claims
    .map(item => `proof:${hashValue(item)}`)
    .slice(0, MAX_PACKET_PROOF_HASHES);
};

const buildBridgePackets = (
  plan: PlanEnvelope,
  brainPacket: BrainPacket | undefined,
  constraintGraph: ConstraintGraphSummary | undefined,
): BridgePacket[] => {
  const sliceIds = resolveSliceIds(plan, brainPacket);
  const topologySketch = buildTopologySketch(plan);
  const keyContracts = dedupe(
    (brainPacket?.constraints || []).map(item => item.summary)
      .concat((constraintGraph?.violations || []).map(item => item.summary)),
  ).slice(0, 10);
  const gaps = dedupe(
    (brainPacket?.gaps || []).map(item => item.summary)
      .concat((constraintGraph?.violations || []).map(item => item.id)),
  ).slice(0, 10);
  const precedentHints = dedupe(
    (brainPacket?.precedents || []).map(item => item.id),
  ).slice(0, 10);
  const proofHashes = buildProofHashes(plan, brainPacket);
  const createdAt = nowIso();

  return sliceIds.map(sliceId => {
    const idBase = `${sliceId}|${topologySketch}|${proofHashes.join('|')}`;
    return {
      id: `bridge:${hashValue(idBase)}`,
      sliceId,
      topologySketch,
      keyContracts,
      gaps,
      precedentHints,
      proofHashes,
      createdAt,
    };
  });
};

const upsertPackets = (
  existing: BridgePacket[],
  generated: BridgePacket[],
): BridgePacket[] => {
  const byId = new Map<string, BridgePacket>();
  for (const packet of existing.concat(generated)) {
    const current = byId.get(packet.id);
    if (!current || toTimestamp(packet.createdAt) >= toTimestamp(current.createdAt)) {
      byId.set(packet.id, packet);
    }
  }
  return sortPacketsByCreatedAt(Array.from(byId.values()), 'asc')
    .slice(-MAX_BRIDGE_PACKETS);
};

export const runGraphModelBridge = async (
  input: BrainTickInput,
  plan: PlanEnvelope,
  brainPacket?: BrainPacket,
  constraintGraph?: ConstraintGraphSummary,
): Promise<GraphModelBridgeSummary> => {
  const warnings: string[] = [];
  const store = await loadStore(input.storagePath);
  const generated = buildBridgePackets(plan, brainPacket, constraintGraph);
  store.runCount += 1;
  store.packets = upsertPackets(store.packets, generated);
  const storePath = await saveStore(input.storagePath, store);
  const modelPath = getModelPath(input.storagePath);

  const packetCount = store.packets.length;
  const sliceBacked = store.packets.filter(item => !item.sliceId.startsWith('slice:')).length;
  const proofBacked = store.packets.filter(item => item.proofHashes.length > 0).length;
  const avgProofHashes = packetCount > 0
    ? Number((store.packets.reduce((acc, item) => acc + item.proofHashes.length, 0) / packetCount).toFixed(4))
    : 0;
  const learnedCandidateReady = (
    store.runCount >= LEARNED_BRIDGE_MIN_RUNS
    && packetCount >= LEARNED_BRIDGE_MIN_PACKETS
    && proofBacked / Math.max(1, packetCount) >= 0.7
  );
  let learnedModel = await loadModel(input.storagePath);
  const shouldTrainModel = learnedCandidateReady && (!learnedModel || learnedModel.packetCount !== packetCount);
  if (shouldTrainModel) {
    const trained = trainModel(store.packets);
    if (trained) {
      learnedModel = trained;
      await saveModel(input.storagePath, learnedModel);
    } else {
      warnings.push('GraphModelBridge learned bridge skipped training due to sparse packet tokens');
    }
  }
  const shadowPredictions = learnedModel ? predictWithModel(learnedModel, generated) : [];
  const averageConfidence = shadowPredictions.length > 0
    ? Number((shadowPredictions.reduce((acc, item) => acc + item.confidence, 0) / shadowPredictions.length).toFixed(4))
    : 0;

  if (!brainPacket) warnings.push('GraphModelBridge ran without BrainPacket; packets used planner-only fallback');
  if (generated.length === 0) warnings.push('GraphModelBridge emitted no packets');
  if (generated.some(item => item.proofHashes.length === 0)) {
    warnings.push('GraphModelBridge produced packets without proof hashes');
  }
  const latestPackets = sortPacketsByCreatedAt(store.packets, 'desc').slice(0, MAX_LATEST_PACKETS);

  return {
    generatedAt: nowIso(),
    storePath,
    runCount: store.runCount,
    packetCount,
    latestPackets,
    coverage: {
      sliceBacked,
      proofBacked,
      avgProofHashes,
    },
    promotion: {
      symbolicEnabled: true,
      learnedCandidateReady,
    },
    learned: {
      mode: learnedModel ? 'shadow' : 'inactive',
      modelPath,
      modelVersion: learnedModel?.modelVersion || LEARNED_MODEL_VERSION,
      trainedAt: learnedModel?.trainedAt || '',
      trainingPacketCount: learnedModel?.packetCount || 0,
      shadowPredictions,
      averageConfidence,
    },
    warnings,
  };
};
