import path from 'node:path';
import { KnowledgeGraph } from '../graph/types.js';
import { generateId } from '../../lib/utils.js';

const MJML_INCLUDE_RE = /<mj-include\b[^>]*\bpath\s*=\s*(['"])([^'"]+)\1[^>]*\/?>/gi;

const extractMjmlIncludePaths = (content: string): string[] => {
  const paths = new Set<string>();

  for (const match of content.matchAll(MJML_INCLUDE_RE)) {
    const raw = String(match[2] || '').trim();
    if (!raw) continue;
    paths.add(raw);
  }

  return Array.from(paths);
};

const normalizeIncludePath = (raw: string): string | null => {
  let value = raw.trim();
  if (!value) return null;
  if (value.includes('://')) return null;

  value = value.replace(/\\/g, '/');

  const queryStart = value.indexOf('?');
  if (queryStart !== -1) value = value.slice(0, queryStart);
  const hashStart = value.indexOf('#');
  if (hashStart !== -1) value = value.slice(0, hashStart);

  value = value.trim();
  if (!value) return null;
  return value;
};

const resolveMjmlIncludePath = (sourcePath: string, rawIncludePath: string): string | null => {
  const includePath = normalizeIncludePath(rawIncludePath);
  if (!includePath) return null;

  let resolved: string;
  if (includePath.startsWith('/')) {
    resolved = includePath.replace(/^\/+/, '');
  } else {
    resolved = path.posix.join(path.posix.dirname(sourcePath), includePath);
  }

  resolved = path.posix.normalize(resolved);
  if (!resolved || resolved === '.' || resolved.startsWith('../') || resolved === '..') return null;

  return resolved;
};

export const processMjmlIncludes = (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  allFilePaths: Set<string>,
): { edgesAdded: number } => {
  let edgesAdded = 0;

  for (const file of files) {
    if (!file.path.endsWith('.mjml')) continue;

    const includePaths = extractMjmlIncludePaths(file.content);
    if (includePaths.length === 0) continue;

    const sourceId = generateId('File', file.path);
    const seen = new Set<string>();

    for (const rawIncludePath of includePaths) {
      const resolved = resolveMjmlIncludePath(file.path, rawIncludePath);
      if (!resolved) continue;
      if (!allFilePaths.has(resolved)) continue;

      const targetId = generateId('File', resolved);
      const key = `${sourceId}->${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const relId = generateId('IMPORTS', key);
      graph.addRelationship({
        id: relId,
        type: 'IMPORTS',
        sourceId,
        targetId,
        confidence: 1.0,
        reason: 'mjml-include',
      });
      edgesAdded++;
    }
  }

  return { edgesAdded };
};

