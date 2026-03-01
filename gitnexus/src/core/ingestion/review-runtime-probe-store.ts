import fs from 'fs/promises';
import path from 'path';

const REVIEW_RUNTIME_PROBE_SCHEMA_VERSION = 1;
const REVIEW_RUNTIME_PROBE_FILE = 'review-runtime-probes.json';

export interface ReviewRuntimeProbeSnapshot {
  schemaVersion: number;
  generatedAt: string;
  repoPath: string;
  runtimeSource: string;
  requestCount: number;
  highPriorityCount: number;
  triggers: string[];
}

const nowIso = (): string => new Date().toISOString();

const emptySnapshot = (): ReviewRuntimeProbeSnapshot => ({
  schemaVersion: REVIEW_RUNTIME_PROBE_SCHEMA_VERSION,
  generatedAt: '',
  repoPath: '',
  runtimeSource: 'none',
  requestCount: 0,
  highPriorityCount: 0,
  triggers: [],
});

export const getReviewRuntimeProbeSnapshotPath = (storagePath: string): string => {
  return path.join(storagePath, 'manifests', REVIEW_RUNTIME_PROBE_FILE);
};

export const loadReviewRuntimeProbeSnapshot = async (
  storagePath: string,
): Promise<ReviewRuntimeProbeSnapshot> => {
  try {
    const raw = await fs.readFile(getReviewRuntimeProbeSnapshotPath(storagePath), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || Number(parsed.schemaVersion) !== REVIEW_RUNTIME_PROBE_SCHEMA_VERSION) {
      return emptySnapshot();
    }
    return {
      schemaVersion: REVIEW_RUNTIME_PROBE_SCHEMA_VERSION,
      generatedAt: String(parsed.generatedAt || ''),
      repoPath: String(parsed.repoPath || ''),
      runtimeSource: String(parsed.runtimeSource || 'none'),
      requestCount: Math.max(0, Number(parsed.requestCount || 0)),
      highPriorityCount: Math.max(0, Number(parsed.highPriorityCount || 0)),
      triggers: Array.isArray(parsed.triggers)
        ? parsed.triggers.map((item: unknown) => String(item || '').trim()).filter(Boolean).slice(0, 20)
        : [],
    };
  } catch {
    return emptySnapshot();
  }
};

export const saveReviewRuntimeProbeSnapshot = async (
  storagePath: string,
  input: Omit<ReviewRuntimeProbeSnapshot, 'schemaVersion' | 'generatedAt'> & { generatedAt?: string },
): Promise<string> => {
  const filePath = getReviewRuntimeProbeSnapshotPath(storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload: ReviewRuntimeProbeSnapshot = {
    schemaVersion: REVIEW_RUNTIME_PROBE_SCHEMA_VERSION,
    generatedAt: String(input.generatedAt || nowIso()),
    repoPath: String(input.repoPath || ''),
    runtimeSource: String(input.runtimeSource || 'none'),
    requestCount: Math.max(0, Number(input.requestCount || 0)),
    highPriorityCount: Math.max(0, Number(input.highPriorityCount || 0)),
    triggers: Array.isArray(input.triggers)
      ? input.triggers.map((item: unknown) => String(item || '').trim()).filter(Boolean).slice(0, 20)
      : [],
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return filePath;
};
