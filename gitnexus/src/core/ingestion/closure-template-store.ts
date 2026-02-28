import fs from 'fs/promises';
import path from 'path';
import {
  ClosureTemplateEntry,
  ClosureTemplateSnapshot,
} from './closure-template-processor.js';

const CLOSURE_TEMPLATE_FILE_NAME = 'closure-templates.json';

const makeEmptySnapshot = (): ClosureTemplateSnapshot => ({
  version: 1,
  generatedAt: '',
  stats: {
    totalTemplates: 0,
    totalSlices: 0,
    totalCoveredSlots: 0,
    totalRoleExpectations: 0,
  },
  templates: [],
});

const normalizeArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean);
};

const sanitizeTemplateEntry = (value: any): ClosureTemplateEntry | null => {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '').trim();
  const templateKey = String(value.templateKey || '').trim();
  const sliceType = String(value.sliceType || '').trim();
  if (!id || !templateKey || !sliceType) return null;

  const roleCoverage = Array.isArray(value.roleCoverage)
    ? value.roleCoverage
      .map(item => ({
        role: String(item?.role || '').trim(),
        coverage: Number(item?.coverage || 0) || 0,
        count: Number(item?.count || 0) || 0,
      }))
      .filter(item => item.role)
    : [];

  const slotCoverage = Array.isArray(value.slotCoverage)
    ? value.slotCoverage
      .map(item => ({
        slot: String(item?.slot || '').trim(),
        coverage: Number(item?.coverage || 0) || 0,
        count: Number(item?.count || 0) || 0,
      }))
      .filter(item => item.slot)
    : [];

  return {
    id,
    templateKey,
    sliceType,
    requiredSlots: normalizeArray(value.requiredSlots),
    optionalSlots: normalizeArray(value.optionalSlots),
    roleCoverage,
    slotCoverage,
    sliceCount: Number(value.sliceCount || 0) || 0,
    avgClosureScore: Number(value.avgClosureScore || 0) || 0,
    exemplarSliceIds: normalizeArray(value.exemplarSliceIds),
  };
};

const sanitizeSnapshot = (value: any): ClosureTemplateSnapshot => {
  if (!value || typeof value !== 'object') return makeEmptySnapshot();
  const templates = Array.isArray(value.templates)
    ? value.templates
      .map(sanitizeTemplateEntry)
      .filter((entry): entry is ClosureTemplateEntry => entry !== null)
    : [];

  return {
    version: 1,
    generatedAt: String(value.generatedAt || ''),
    stats: {
      totalTemplates: Number(value?.stats?.totalTemplates) || templates.length,
      totalSlices: Number(value?.stats?.totalSlices) || 0,
      totalCoveredSlots: Number(value?.stats?.totalCoveredSlots) || templates.reduce((sum, template) => sum + template.slotCoverage.length, 0),
      totalRoleExpectations: Number(value?.stats?.totalRoleExpectations) || templates.reduce((sum, template) => sum + template.roleCoverage.length, 0),
    },
    templates,
  };
};

export const getClosureTemplateSnapshotPath = (storagePath: string): string => {
  return path.join(storagePath, CLOSURE_TEMPLATE_FILE_NAME);
};

export const loadClosureTemplateSnapshot = async (
  storagePath: string,
): Promise<ClosureTemplateSnapshot> => {
  const filePath = getClosureTemplateSnapshotPath(storagePath);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return sanitizeSnapshot(parsed);
  } catch {
    return makeEmptySnapshot();
  }
};

export const saveClosureTemplateSnapshot = async (
  storagePath: string,
  snapshot: ClosureTemplateSnapshot,
): Promise<string> => {
  const filePath = getClosureTemplateSnapshotPath(storagePath);
  await fs.mkdir(storagePath, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  return filePath;
};

export const summarizeClosureTemplateSnapshot = (
  snapshot: ClosureTemplateSnapshot,
  options?: {
    sliceType?: string;
    templateKey?: string;
    query?: string;
    limit?: number;
  },
): {
  updated_at: string;
  stats: ClosureTemplateSnapshot['stats'];
  templates: ClosureTemplateEntry[];
} => {
  const sliceType = String(options?.sliceType || '').trim().toLowerCase();
  const templateKey = String(options?.templateKey || '').trim();
  const query = String(options?.query || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, Math.floor(Number(options?.limit) || 20)));

  const matches = (template: ClosureTemplateEntry): boolean => {
    if (sliceType && template.sliceType.toLowerCase() !== sliceType) return false;
    if (templateKey && template.templateKey !== templateKey && template.id !== templateKey) return false;
    if (!query) return true;
    const haystack = [
      template.templateKey,
      template.sliceType,
      ...template.requiredSlots,
      ...template.optionalSlots,
      ...template.roleCoverage.map(item => item.role),
      ...template.slotCoverage.map(item => item.slot),
      ...template.exemplarSliceIds,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  };

  return {
    updated_at: snapshot.generatedAt,
    stats: snapshot.stats,
    templates: snapshot.templates.filter(matches).slice(0, limit),
  };
};
