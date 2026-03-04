import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export type EmbeddingCacheMeta = {
  modelId: string;
  dimensions: number;
};

export type EmbeddingCacheEntry = {
  hash: string;
  embeddingBase64: string;
};

export type EmbeddingCacheByHash = Map<string, string>;
export type LoadedEmbeddingCache = {
  byHash: EmbeddingCacheByHash;
  loadedVersion: number;
};

type EmbeddingCacheFileV1 = {
  version: 1;
  updatedAt: string;
  meta: EmbeddingCacheMeta;
  entries: Record<string, EmbeddingCacheEntry>;
};

type EmbeddingCacheFileV2 = {
  version: 2;
  updatedAt: string;
  meta: EmbeddingCacheMeta;
  byHash: Record<string, string>;
};

type EmbeddingCacheFile = EmbeddingCacheFileV1 | EmbeddingCacheFileV2;

const EMBEDDING_CACHE_VERSION = 2;

export const computeEmbeddingTextHash = (text: string, meta: EmbeddingCacheMeta): string => {
  const hash = crypto.createHash('sha256');
  hash.update(String(meta.modelId || ''));
  hash.update('\n');
  hash.update(String(meta.dimensions || ''));
  hash.update('\n');
  hash.update(String(text || ''));
  return hash.digest('hex');
};

export const encodeEmbeddingBase64 = (embedding: number[]): string => {
  const arr = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i += 1) {
    arr[i] = Number(embedding[i]) || 0;
  }
  return Buffer.from(arr.buffer).toString('base64');
};

export const decodeEmbeddingBase64 = (base64: string, expectedDimensions: number): number[] | null => {
  try {
    const buf = Buffer.from(String(base64 || ''), 'base64');
    if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
    const float = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    if (expectedDimensions > 0 && float.length !== expectedDimensions) return null;
    return Array.from(float);
  } catch {
    return null;
  }
};

export const resolveDefaultEmbeddingCachePath = (storagePath: string): string => {
  return path.join(storagePath, 'embeddings', 'cache.json');
};

export const resolveGlobalEmbeddingCachePath = (): string => {
  const envHome = process.env.GITNEXUS_HOME?.trim();
  const baseDir = envHome ? path.resolve(envHome) : path.join(os.homedir(), '.gitnexus');
  return path.join(baseDir, 'embeddings', 'cache.json');
};

export const resolveEmbeddingCacheOverlayPath = (cachePath: string): string => {
  const resolved = String(cachePath || '').trim();
  if (!resolved) return '';
  if (resolved.endsWith('.json')) return `${resolved.slice(0, -5)}.overlay.jsonl`;
  return `${resolved}.overlay.jsonl`;
};

export const loadEmbeddingCacheOverlay = async (
  overlayPath: string,
): Promise<EmbeddingCacheByHash> => {
  try {
    const raw = await fs.readFile(overlayPath, 'utf-8');
    const byHash = new Map<string, string>();
    for (const line of String(raw || '').split('\n')) {
      const trimmed = String(line || '').trim();
      if (!trimmed) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const hash = String(parsed?.hash || '').trim();
      const embeddingBase64 = String(parsed?.embeddingBase64 || '').trim();
      if (!hash || !embeddingBase64) continue;
      byHash.set(hash, embeddingBase64);
    }
    return byHash;
  } catch {
    return new Map();
  }
};

export const appendEmbeddingCacheOverlay = async (
  overlayPath: string,
  entries: Array<{ hash: string; embeddingBase64: string }>,
): Promise<void> => {
  const normalizedPath = String(overlayPath || '').trim();
  if (!normalizedPath) return;
  if (!Array.isArray(entries) || entries.length === 0) return;

  const dir = path.dirname(normalizedPath);
  await fs.mkdir(dir, { recursive: true });

  const payload = entries
    .map(entry => ({
      hash: String(entry?.hash || '').trim(),
      embeddingBase64: String(entry?.embeddingBase64 || '').trim(),
    }))
    .filter(entry => entry.hash && entry.embeddingBase64)
    .map(entry => JSON.stringify(entry))
    .join('\n');

  if (!payload) return;
  await fs.appendFile(normalizedPath, `${payload}\n`, 'utf-8');
};

export const loadEmbeddingCache = async (
  cachePath: string,
  meta: EmbeddingCacheMeta,
): Promise<LoadedEmbeddingCache> => {
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as EmbeddingCacheFile;
    if (!parsed || typeof parsed !== 'object') return { byHash: new Map(), loadedVersion: 0 };
    if (String(parsed.meta?.modelId || '') !== String(meta.modelId || '')) return { byHash: new Map(), loadedVersion: 0 };
    if (Number(parsed.meta?.dimensions || 0) !== Number(meta.dimensions || 0)) return { byHash: new Map(), loadedVersion: 0 };

    const version = Number((parsed as any).version);
    if (version === 1) {
      const entries = (parsed as EmbeddingCacheFileV1).entries && typeof (parsed as EmbeddingCacheFileV1).entries === 'object'
        ? (parsed as EmbeddingCacheFileV1).entries
        : {};

      const byHash = new Map<string, string>();
      for (const entry of Object.values(entries)) {
        const hash = String(entry?.hash || '');
        if (!hash || byHash.has(hash)) continue;
        const base64 = String(entry?.embeddingBase64 || '');
        if (!base64) continue;
        byHash.set(hash, base64);
      }
      return { byHash, loadedVersion: 1 };
    }

    if (version === 2) {
      const rawByHash = (parsed as EmbeddingCacheFileV2).byHash && typeof (parsed as EmbeddingCacheFileV2).byHash === 'object'
        ? (parsed as EmbeddingCacheFileV2).byHash
        : {};

      const byHash = new Map<string, string>();
      for (const [hash, embeddingBase64] of Object.entries(rawByHash)) {
        const normalizedHash = String(hash || '');
        if (!normalizedHash) continue;
        const base64 = String(embeddingBase64 || '');
        if (!base64) continue;
        byHash.set(normalizedHash, base64);
      }
      return { byHash, loadedVersion: 2 };
    }

    return { byHash: new Map(), loadedVersion: 0 };
  } catch {
    return { byHash: new Map(), loadedVersion: 0 };
  }
};

export const saveEmbeddingCache = async (
  cachePath: string,
  meta: EmbeddingCacheMeta,
  byHash: EmbeddingCacheByHash,
): Promise<void> => {
  const dir = path.dirname(cachePath);
  await fs.mkdir(dir, { recursive: true });

  const payload: EmbeddingCacheFileV2 = {
    version: EMBEDDING_CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    meta,
    byHash: Object.fromEntries(byHash.entries()),
  };

  const tmp = `${cachePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload));
  await fs.rename(tmp, cachePath);
};
