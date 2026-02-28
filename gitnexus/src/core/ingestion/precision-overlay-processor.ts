import fs from 'fs/promises';
import path from 'path';
import { generateId } from '../../lib/utils.js';
import { GraphNode, GraphRelationship, KnowledgeGraph, RelationshipType } from '../graph/types.js';
import { producePrecisionOverlay, PrecisionOverlayMode } from './precision-overlay-producer.js';

const DEFAULT_OVERLAY_PATH = '.gitnexus/precision-overlay.json';
const DEFAULT_PROVIDER = 'scip';
const DEFAULT_MAX_RELATIONS = 5000;
const DEFAULT_MIN_CONFIDENCE = 0.85;

const PRECISION_REL_TYPES: RelationshipType[] = [
  'CALLS',
  'IMPORTS',
  'DEFINES',
  'EXTENDS',
  'IMPLEMENTS',
];
const PRECISION_REL_TYPE_SET = new Set<RelationshipType>(PRECISION_REL_TYPES);

type OverlayNodeRef = {
  id?: string;
  filePath?: string;
  name?: string;
  label?: string;
  line?: number;
  startLine?: number;
};

type OverlayRelation = {
  type?: string;
  source?: OverlayNodeRef | string;
  target?: OverlayNodeRef | string;
  confidence?: number;
  reason?: string;
  provider?: string;
};

type OverlayDocument = {
  provider?: string;
  relations?: OverlayRelation[];
  edges?: OverlayRelation[];
};

interface OverlayNodeIndex {
  byId: Map<string, GraphNode>;
  byFilePath: Map<string, GraphNode[]>;
}

export interface PrecisionOverlayOptions {
  overlayPath?: string;
  overlayJson?: string;
  provider?: string;
  maxRelations?: number;
  minConfidence?: number;
  producerMode?: PrecisionOverlayMode;
  producerForceRefresh?: boolean;
  producerScipJson?: string;
  producerCommandRunner?: (
    command: string,
    args: string[],
    cwd: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface PrecisionOverlayResult {
  edges: GraphRelationship[];
  stats: {
    provider: string;
    overlayPath: string;
    overlayFound: boolean;
    declaredRelations: number;
    emittedEdges: number;
    skippedUnsupported: number;
    skippedUnresolved: number;
    skippedDuplicates: number;
    skippedMalformed: number;
    skippedLowConfidence: number;
    capped: boolean;
    maxRelations: number;
    minConfidence: number;
    producerMode?: PrecisionOverlayMode;
    producer?: string;
    producerCacheHit?: boolean;
    producerSkipped?: boolean;
    producerSkipReason?: string;
    producerRunDir?: string;
    producerWarnings?: string[];
    error?: string;
  };
}

const normalizePath = (value: string): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const sanitizeReasonSegment = (value: string): string => {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9:_\-/]+/g, '')
    .slice(0, 80);
};

const toNodeRef = (input: OverlayNodeRef | string | undefined): OverlayNodeRef => {
  if (!input) return {};
  if (typeof input === 'string') return { id: input };
  return {
    id: input.id ? String(input.id).trim() : undefined,
    filePath: input.filePath ? normalizePath(String(input.filePath)) : undefined,
    name: input.name ? String(input.name).trim() : undefined,
    label: input.label ? String(input.label).trim() : undefined,
    line: Number.isFinite(Number(input.line)) ? Number(input.line) : undefined,
    startLine: Number.isFinite(Number(input.startLine)) ? Number(input.startLine) : undefined,
  };
};

const buildNodeIndex = (knowledgeGraph: KnowledgeGraph): OverlayNodeIndex => {
  const byId = new Map<string, GraphNode>();
  const byFilePath = new Map<string, GraphNode[]>();

  for (const node of knowledgeGraph.nodes) {
    byId.set(node.id, node);
    const filePath = normalizePath(String(node.properties?.filePath || ''));
    if (!filePath) continue;
    const list = byFilePath.get(filePath) || [];
    list.push(node);
    byFilePath.set(filePath, list);
  }

  return { byId, byFilePath };
};

const chooseByLine = (candidates: GraphNode[], line: number): GraphNode[] => {
  const withLine = candidates.filter(node => {
    const start = Number(node.properties?.startLine || 0);
    const end = Number(node.properties?.endLine || 0);
    if (start > 0 && end > 0) return line >= start && line <= end;
    if (start > 0 && end <= 0) return line >= start;
    return false;
  });

  if (withLine.length <= 1) return withLine;

  return [...withLine].sort((left, right) => {
    const leftStart = Number(left.properties?.startLine || Number.MAX_SAFE_INTEGER);
    const leftEnd = Number(left.properties?.endLine || leftStart);
    const rightStart = Number(right.properties?.startLine || Number.MAX_SAFE_INTEGER);
    const rightEnd = Number(right.properties?.endLine || rightStart);
    const leftSpan = Math.max(1, leftEnd - leftStart + 1);
    const rightSpan = Math.max(1, rightEnd - rightStart + 1);
    if (leftSpan !== rightSpan) return leftSpan - rightSpan;
    if (leftStart !== rightStart) return leftStart - rightStart;
    return left.id.localeCompare(right.id);
  });
};

const resolveNodeId = (index: OverlayNodeIndex, reference: OverlayNodeRef): string | null => {
  if (reference.id) {
    const direct = index.byId.get(reference.id);
    return direct ? direct.id : null;
  }

  const filePath = normalizePath(String(reference.filePath || ''));
  if (!filePath) return null;

  let candidates = [...(index.byFilePath.get(filePath) || [])];
  if (candidates.length === 0) return null;

  if (reference.name) {
    candidates = candidates.filter(node => String(node.properties?.name || '').trim() === reference.name);
  }
  if (reference.label) {
    candidates = candidates.filter(node => String(node.label) === reference.label);
  }
  if (candidates.length === 0) return null;

  const line = reference.line ?? reference.startLine;
  if (Number.isFinite(line)) {
    const ranked = chooseByLine(candidates, Number(line));
    if (ranked.length > 0) {
      return ranked[0].id;
    }
  }

  if (candidates.length === 1) return candidates[0].id;
  return null;
};

const getDeclaredRelations = (document: OverlayDocument | OverlayRelation[] | null): OverlayRelation[] => {
  if (!document) return [];
  if (Array.isArray(document)) return document;
  if (Array.isArray(document.relations)) return document.relations;
  if (Array.isArray(document.edges)) return document.edges;
  return [];
};

const defaultConfidenceForProvider = (provider: string): number => {
  const key = String(provider || '').toLowerCase();
  if (key === 'scip') return 0.96;
  if (key === 'stack-graph' || key === 'stackgraph' || key === 'stack') return 0.94;
  if (key === 'lsp') return 0.92;
  return 0.9;
};

export const processPrecisionOverlay = async (
  repoPath: string,
  knowledgeGraph: KnowledgeGraph,
  onProgress?: (message: string, progress: number) => void,
  options: PrecisionOverlayOptions = {},
): Promise<PrecisionOverlayResult> => {
  const maxRelations = Math.max(100, Math.floor(options.maxRelations || DEFAULT_MAX_RELATIONS));
  const minConfidence = Math.max(0.5, Math.min(0.99, Number(options.minConfidence ?? DEFAULT_MIN_CONFIDENCE) || DEFAULT_MIN_CONFIDENCE));
  let overlayPath = path.isAbsolute(String(options.overlayPath || ''))
    ? String(options.overlayPath)
    : path.join(repoPath, String(options.overlayPath || DEFAULT_OVERLAY_PATH));
  const producerMode = options.producerMode;

  const baseStats: PrecisionOverlayResult['stats'] = {
    provider: String(options.provider || DEFAULT_PROVIDER),
    overlayPath,
    overlayFound: false,
    declaredRelations: 0,
    emittedEdges: 0,
    skippedUnsupported: 0,
    skippedUnresolved: 0,
    skippedDuplicates: 0,
    skippedMalformed: 0,
    skippedLowConfidence: 0,
    capped: false,
    maxRelations,
    minConfidence,
    ...(producerMode ? { producerMode } : {}),
  };

  if (producerMode === 'off') {
    return { edges: [], stats: baseStats };
  }

  if (!options.overlayJson && producerMode) {
    onProgress?.('Running precision overlay producer...', 0);
    const producerResult = await producePrecisionOverlay(repoPath, {
      mode: producerMode,
      overlayPath: options.overlayPath || DEFAULT_OVERLAY_PATH,
      forceRefresh: options.producerForceRefresh,
      onProgress: message => {
        onProgress?.(message, 5);
      },
      scipJson: options.producerScipJson,
      commandRunner: options.producerCommandRunner,
    });

    baseStats.producer = producerResult.producer;
    baseStats.producerCacheHit = producerResult.cacheHit;
    baseStats.producerSkipped = producerResult.skipped;
    baseStats.producerSkipReason = producerResult.skipReason;
    baseStats.producerRunDir = producerResult.runDir;
    baseStats.producerWarnings = producerResult.warnings;
    baseStats.overlayPath = producerResult.overlayPath || baseStats.overlayPath;
    overlayPath = baseStats.overlayPath;

    if (producerResult.skipped && producerResult.skipReason) {
      onProgress?.(`Precision producer skipped: ${producerResult.skipReason}`, 20);
    }

    if (producerMode === 'shadow' || producerMode === 'lsp-probe') {
      return { edges: [], stats: baseStats };
    }
  }

  onProgress?.('Loading precision overlay file...', 20);

  let overlayRaw = String(options.overlayJson || '');
  if (!overlayRaw) {
    try {
      overlayRaw = await fs.readFile(overlayPath, 'utf-8');
      baseStats.overlayFound = true;
    } catch {
      return { edges: [], stats: baseStats };
    }
  } else {
    baseStats.overlayFound = true;
  }

  let parsedOverlay: OverlayDocument | OverlayRelation[] | null = null;
  try {
    parsedOverlay = JSON.parse(overlayRaw);
  } catch (error) {
    return {
      edges: [],
      stats: {
        ...baseStats,
        error: `Invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      },
    };
  }

  const declaredRelations = getDeclaredRelations(parsedOverlay);
  const provider = String(
    options.provider
      || (!Array.isArray(parsedOverlay) && parsedOverlay?.provider)
      || DEFAULT_PROVIDER,
  ).trim() || DEFAULT_PROVIDER;

  baseStats.provider = provider;
  baseStats.declaredRelations = declaredRelations.length;

  if (declaredRelations.length === 0) {
    return { edges: [], stats: baseStats };
  }

  onProgress?.('Resolving precision overlay references...', 35);

  const nodeIndex = buildNodeIndex(knowledgeGraph);
  const existingEdgeKeys = new Set(
    knowledgeGraph.relationships.map(rel => `${rel.type}|${rel.sourceId}|${rel.targetId}`),
  );
  const emittedPairKeys = new Set<string>();
  const edges: GraphRelationship[] = [];

  const cappedRelations = declaredRelations.slice(0, maxRelations);
  if (declaredRelations.length > cappedRelations.length) {
    baseStats.capped = true;
  }

  for (const rawRelation of cappedRelations) {
    if (!rawRelation || typeof rawRelation !== 'object') {
      baseStats.skippedMalformed++;
      continue;
    }

    const relationType = String(rawRelation.type || '').trim().toUpperCase() as RelationshipType;
    if (!PRECISION_REL_TYPE_SET.has(relationType)) {
      baseStats.skippedUnsupported++;
      continue;
    }

    const sourceRef = toNodeRef(rawRelation.source);
    const targetRef = toNodeRef(rawRelation.target);
    if (!sourceRef || !targetRef) {
      baseStats.skippedMalformed++;
      continue;
    }

    const sourceId = resolveNodeId(nodeIndex, sourceRef);
    const targetId = resolveNodeId(nodeIndex, targetRef);
    if (!sourceId || !targetId) {
      baseStats.skippedUnresolved++;
      continue;
    }

    if (sourceId === targetId) {
      baseStats.skippedMalformed++;
      continue;
    }

    const rawConfidence = Number(rawRelation.confidence);
    if (Number.isFinite(rawConfidence) && rawConfidence < minConfidence) {
      baseStats.skippedLowConfidence++;
      continue;
    }

    const confidenceBase = Number.isFinite(rawConfidence)
      ? rawConfidence
      : defaultConfidenceForProvider(rawRelation.provider || provider);
    const confidence = Math.max(minConfidence, Math.min(0.99, confidenceBase));

    const pairKey = `${relationType}|${sourceId}|${targetId}`;
    if (existingEdgeKeys.has(pairKey) || emittedPairKeys.has(pairKey)) {
      baseStats.skippedDuplicates++;
      continue;
    }
    emittedPairKeys.add(pairKey);

    const reasonSuffix = sanitizeReasonSegment(String(rawRelation.reason || '')) || relationType.toLowerCase();
    const reason = `precision-overlay:${provider}:${reasonSuffix}`;
    const edgeId = generateId(relationType, `precision_${provider}_${sourceId}->${targetId}`);
    edges.push({
      id: edgeId,
      type: relationType,
      sourceId,
      targetId,
      confidence: Number(confidence.toFixed(3)),
      reason,
    });
  }

  onProgress?.('Precision overlay extraction complete.', 100);

  return {
    edges,
    stats: {
      ...baseStats,
      emittedEdges: edges.length,
    },
  };
};
