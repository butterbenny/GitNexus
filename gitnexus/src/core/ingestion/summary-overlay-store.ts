import fs from 'fs/promises';
import path from 'path';
import {
  StructuredSummaryEntry,
  StructuredSummaryLevel,
  StructuredSummaryOverlaySnapshot,
} from './summary-overlay-processor.js';

const SUMMARY_OVERLAY_FILE_NAME = 'summary-overlays.json';

const SUMMARY_LEVELS: StructuredSummaryLevel[] = [
  'symbol',
  'file',
  'slice',
  'community',
  'process',
  'archetype',
];

const makeEmptySnapshot = (): StructuredSummaryOverlaySnapshot => ({
  version: 1,
  generatedAt: '',
  stats: {
    symbolCount: 0,
    fileCount: 0,
    sliceCount: 0,
    communityCount: 0,
    processCount: 0,
    archetypeCount: 0,
    truncated: {
      symbols: false,
      files: false,
      slices: false,
      communities: false,
      processes: false,
      archetypes: false,
    },
  },
  symbols: [],
  files: [],
  slices: [],
  communities: [],
  processes: [],
  archetypes: [],
});

const normalizePath = (value: unknown): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

export const getStructuredSummarySnapshotPath = (storagePath: string): string => {
  return path.join(storagePath, SUMMARY_OVERLAY_FILE_NAME);
};

const normalizeEntry = (entry: any): StructuredSummaryEntry | null => {
  if (!entry || typeof entry !== 'object') return null;
  const level = String(entry.level || '').trim() as StructuredSummaryLevel;
  if (!SUMMARY_LEVELS.includes(level)) return null;
  const id = String(entry.id || '').trim();
  const entityId = String(entry.entityId || '').trim();
  if (!id || !entityId) return null;

  const toArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item || '').trim()).filter(Boolean);
  };

  return {
    id,
    level,
    entityId,
    name: String(entry.name || '').trim(),
    label: String(entry.label || '').trim(),
    filePath: normalizePath(entry.filePath),
    responsibilities: toArray(entry.responsibilities),
    inboundCallers: toArray(entry.inboundCallers),
    downstreamEffects: toArray(entry.downstreamEffects),
    contracts: {
      auth: toArray(entry?.contracts?.auth),
      cache: toArray(entry?.contracts?.cache),
      shape: toArray(entry?.contracts?.shape),
    },
    companions: toArray(entry.companions),
    siblingPrecedents: toArray(entry.siblingPrecedents),
  };
};

const sanitizeSnapshot = (value: any): StructuredSummaryOverlaySnapshot => {
  if (!value || typeof value !== 'object') return makeEmptySnapshot();

  const normalizeList = (entries: unknown): StructuredSummaryEntry[] => {
    if (!Array.isArray(entries)) return [];
    return entries
      .map(normalizeEntry)
      .filter((entry): entry is StructuredSummaryEntry => entry !== null);
  };

  const symbols = normalizeList(value.symbols);
  const files = normalizeList(value.files);
  const slices = normalizeList(value.slices);
  const communities = normalizeList(value.communities);
  const processes = normalizeList(value.processes);
  const archetypes = normalizeList(value.archetypes);

  return {
    version: 1,
    generatedAt: String(value.generatedAt || ''),
    stats: {
      symbolCount: Number(value?.stats?.symbolCount) || symbols.length,
      fileCount: Number(value?.stats?.fileCount) || files.length,
      sliceCount: Number(value?.stats?.sliceCount) || slices.length,
      communityCount: Number(value?.stats?.communityCount) || communities.length,
      processCount: Number(value?.stats?.processCount) || processes.length,
      archetypeCount: Number(value?.stats?.archetypeCount) || archetypes.length,
      truncated: {
        symbols: Boolean(value?.stats?.truncated?.symbols),
        files: Boolean(value?.stats?.truncated?.files),
        slices: Boolean(value?.stats?.truncated?.slices),
        communities: Boolean(value?.stats?.truncated?.communities),
        processes: Boolean(value?.stats?.truncated?.processes),
        archetypes: Boolean(value?.stats?.truncated?.archetypes),
      },
    },
    symbols,
    files,
    slices,
    communities,
    processes,
    archetypes,
  };
};

export const loadStructuredSummarySnapshot = async (
  storagePath: string,
): Promise<StructuredSummaryOverlaySnapshot> => {
  const filePath = getStructuredSummarySnapshotPath(storagePath);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return sanitizeSnapshot(parsed);
  } catch {
    return makeEmptySnapshot();
  }
};

export const saveStructuredSummarySnapshot = async (
  storagePath: string,
  snapshot: StructuredSummaryOverlaySnapshot,
): Promise<string> => {
  const filePath = getStructuredSummarySnapshotPath(storagePath);
  await fs.mkdir(storagePath, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  return filePath;
};

export const summarizeStructuredSummarySnapshot = (
  snapshot: StructuredSummaryOverlaySnapshot,
  options?: {
    level?: StructuredSummaryLevel | string;
    entityId?: string;
    filePath?: string;
    query?: string;
    limit?: number;
  },
): {
  updated_at: string;
  stats: StructuredSummaryOverlaySnapshot['stats'];
  levels: Record<StructuredSummaryLevel, StructuredSummaryEntry[]>;
} => {
  const level = String(options?.level || '').trim() as StructuredSummaryLevel;
  const selectedLevels = SUMMARY_LEVELS.includes(level) ? [level] : SUMMARY_LEVELS;
  const entityId = String(options?.entityId || '').trim();
  const filePathFilter = normalizePath(options?.filePath || '');
  const query = String(options?.query || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, Math.floor(Number(options?.limit) || 20)));

  const matches = (entry: StructuredSummaryEntry): boolean => {
    if (entityId && entry.entityId !== entityId && entry.id !== entityId) return false;
    if (filePathFilter && normalizePath(entry.filePath) !== filePathFilter) return false;
    if (!query) return true;

    const haystack = [
      entry.name,
      entry.label,
      entry.filePath,
      ...entry.responsibilities,
      ...entry.inboundCallers,
      ...entry.downstreamEffects,
      ...entry.contracts.auth,
      ...entry.contracts.cache,
      ...entry.contracts.shape,
      ...entry.companions,
      ...entry.siblingPrecedents,
    ]
      .join(' ')
      .toLowerCase();

    return haystack.includes(query);
  };

  const levels: Record<StructuredSummaryLevel, StructuredSummaryEntry[]> = {
    symbol: [],
    file: [],
    slice: [],
    community: [],
    process: [],
    archetype: [],
  };

  const byLevel: Record<StructuredSummaryLevel, StructuredSummaryEntry[]> = {
    symbol: snapshot.symbols,
    file: snapshot.files,
    slice: snapshot.slices,
    community: snapshot.communities,
    process: snapshot.processes,
    archetype: snapshot.archetypes,
  };

  for (const summaryLevel of selectedLevels) {
    levels[summaryLevel] = byLevel[summaryLevel].filter(matches).slice(0, limit);
  }

  return {
    updated_at: snapshot.generatedAt,
    stats: snapshot.stats,
    levels,
  };
};
