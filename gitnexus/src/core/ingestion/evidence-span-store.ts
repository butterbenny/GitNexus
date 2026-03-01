import fs from 'fs/promises';
import path from 'path';
import { EvidenceSpanSnapshot } from './evidence-span-processor.js';

const EVIDENCE_SPAN_FILE_NAME = 'evidence-spans.json';
type EvidenceSnapshotCacheEntry = {
  mtimeMs: number;
  size: number;
  snapshot: EvidenceSpanSnapshot;
};
type EvidenceSpanLookup = {
  nodesById: Map<string, EvidenceSpanSnapshot['nodes'][number]>;
  edgesById: Map<string, EvidenceSpanSnapshot['edges'][number]>;
};
const evidenceSnapshotCache = new Map<string, EvidenceSnapshotCacheEntry>();
const evidenceLookupCache = new WeakMap<EvidenceSpanSnapshot, EvidenceSpanLookup>();

const makeEmptySnapshot = (): EvidenceSpanSnapshot => ({
  version: 1,
  generatedAt: '',
  stats: {
    nodeEvidenceCount: 0,
    edgeEvidenceCount: 0,
    uniqueFiles: 0,
    primarySpanCount: 0,
    witnessSpanCount: 0,
    proofSpanCount: 0,
  },
  nodes: [],
  edges: [],
});

const normalizePath = (value: unknown): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

export const getEvidenceSpanSnapshotPath = (storagePath: string): string => {
  return path.join(storagePath, EVIDENCE_SPAN_FILE_NAME);
};

const sanitizeSnapshot = (value: any): EvidenceSpanSnapshot => {
  if (!value || typeof value !== 'object') return makeEmptySnapshot();

  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  const edges = Array.isArray(value.edges) ? value.edges : [];

  const snapshot: EvidenceSpanSnapshot = {
    version: 1,
    generatedAt: String(value.generatedAt || ''),
    stats: {
      nodeEvidenceCount: Number(value?.stats?.nodeEvidenceCount) || nodes.length,
      edgeEvidenceCount: Number(value?.stats?.edgeEvidenceCount) || edges.length,
      uniqueFiles: Number(value?.stats?.uniqueFiles) || 0,
      primarySpanCount: Number(value?.stats?.primarySpanCount) || 0,
      witnessSpanCount: Number(value?.stats?.witnessSpanCount) || 0,
      proofSpanCount: Number(value?.stats?.proofSpanCount) || 0,
    },
    nodes: nodes
      .map(node => ({
        ...node,
        nodeId: String(node?.nodeId || ''),
        nodeLabel: String(node?.nodeLabel || ''),
        nodeName: String(node?.nodeName || ''),
      }))
      .filter(node => node.nodeId),
    edges: edges
      .map(edge => ({
        ...edge,
        edgeId: String(edge?.edgeId || ''),
        relationType: String(edge?.relationType || ''),
        sourceId: String(edge?.sourceId || ''),
        targetId: String(edge?.targetId || ''),
        reason: String(edge?.reason || ''),
      }))
      .filter(edge => edge.edgeId),
  };

  return snapshot;
};

export const loadEvidenceSpanSnapshot = async (storagePath: string): Promise<EvidenceSpanSnapshot> => {
  const filePath = getEvidenceSpanSnapshotPath(storagePath);
  try {
    const stat = await fs.stat(filePath);
    const cached = evidenceSnapshotCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.snapshot;
    }

    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const snapshot = sanitizeSnapshot(parsed);
    evidenceSnapshotCache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      snapshot,
    });
    return snapshot;
  } catch {
    evidenceSnapshotCache.delete(filePath);
    return makeEmptySnapshot();
  }
};

export const saveEvidenceSpanSnapshot = async (
  storagePath: string,
  snapshot: EvidenceSpanSnapshot,
): Promise<string> => {
  const filePath = getEvidenceSpanSnapshotPath(storagePath);
  await fs.mkdir(storagePath, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  return filePath;
};

export const summarizeEvidenceSpanSnapshot = (
  snapshot: EvidenceSpanSnapshot,
  options?: {
    limit?: number;
    symbolId?: string;
    filePath?: string;
    includeEdges?: boolean;
    includeNodes?: boolean;
  },
): {
  updated_at: string;
  stats: EvidenceSpanSnapshot['stats'];
  nodes: EvidenceSpanSnapshot['nodes'];
  edges: EvidenceSpanSnapshot['edges'];
} => {
  const limit = Math.max(1, Math.min(200, Math.floor(Number(options?.limit) || 20)));
  const symbolId = String(options?.symbolId || '').trim();
  const filePathFilter = normalizePath(options?.filePath || '');
  const includeEdges = options?.includeEdges !== false;
  const includeNodes = options?.includeNodes !== false;

  const normalizeSpanPath = (filePath: string): string => normalizePath(filePath);

  const nodes = includeNodes
    ? snapshot.nodes
      .filter(node => {
        if (symbolId && node.nodeId !== symbolId) return false;
        if (filePathFilter) {
          const primaryPath = normalizeSpanPath(node.primarySpan?.filePath || '');
          if (primaryPath !== filePathFilter) return false;
        }
        return true;
      })
      .slice(0, limit)
    : [];

  const edges = includeEdges
    ? snapshot.edges
      .filter(edge => {
        if (symbolId && edge.sourceId !== symbolId && edge.targetId !== symbolId) return false;
        if (filePathFilter) {
          const hasMatchingSpan = [
            ...(Array.isArray(edge.witnessSpans) ? edge.witnessSpans : []),
            ...(Array.isArray(edge.proofSpans) ? edge.proofSpans : []),
          ].some(span => normalizeSpanPath(span?.filePath || '') === filePathFilter);
          if (!hasMatchingSpan) return false;
        }
        return true;
      })
      .slice(0, limit)
    : [];

  return {
    updated_at: snapshot.generatedAt,
    stats: snapshot.stats,
    nodes,
    edges,
  };
};

export const getEvidenceSpanLookup = (snapshot: EvidenceSpanSnapshot): EvidenceSpanLookup => {
  const cached = evidenceLookupCache.get(snapshot);
  if (cached) return cached;

  const nodesById = new Map<string, EvidenceSpanSnapshot['nodes'][number]>();
  for (const node of Array.isArray(snapshot.nodes) ? snapshot.nodes : []) {
    const nodeId = String(node?.nodeId || '').trim();
    if (!nodeId) continue;
    nodesById.set(nodeId, node);
  }

  const edgesById = new Map<string, EvidenceSpanSnapshot['edges'][number]>();
  for (const edge of Array.isArray(snapshot.edges) ? snapshot.edges : []) {
    const edgeId = String(edge?.edgeId || '').trim();
    if (!edgeId) continue;
    edgesById.set(edgeId, edge);
  }

  const lookup: EvidenceSpanLookup = {
    nodesById,
    edgesById,
  };
  evidenceLookupCache.set(snapshot, lookup);
  return lookup;
};
