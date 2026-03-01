import { execFileSync } from 'child_process';
import { generateId } from '../../lib/utils.js';
import { GraphRelationship } from '../graph/types.js';

const COMMIT_MARKER = '__GITNEXUS_COMMIT__';
const DEFAULT_MAX_COMMITS = 350;
const DEFAULT_MIN_SUPPORT = 2;
const DEFAULT_MAX_FILES_PER_COMMIT = 35;
const DEFAULT_MAX_NEIGHBORS_PER_FILE = 8;
const MAX_GIT_LOG_BUFFER = 20 * 1024 * 1024;

type CochangeCandidate = {
  sourceFilePath: string;
  targetFilePath: string;
  support: number;
  ratio: number;
  confidence: number;
};

export interface GitHistoryCochangeOptions {
  maxCommits?: number;
  minSupport?: number;
  maxFilesPerCommit?: number;
  maxNeighborsPerFile?: number;
  gitLogOutput?: string;
}

export interface GitHistoryCochangeResult {
  edges: GraphRelationship[];
  stats: {
    scannedCommits: number;
    qualifyingCommits: number;
    skippedLargeCommits: number;
    pairCandidates: number;
    maxCommits: number;
    minSupport: number;
    maxFilesPerCommit: number;
    maxNeighborsPerFile: number;
  };
}

const normalizePath = (value: string): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const pairKey = (fileA: string, fileB: string): string => {
  return fileA < fileB ? `${fileA}\u0000${fileB}` : `${fileB}\u0000${fileA}`;
};

const parseCochangeCommits = (
  gitLogOutput: string,
  indexedFiles: Set<string>,
  maxFilesPerCommit: number,
): {
  commitFileSets: string[][];
  scannedCommits: number;
  skippedLargeCommits: number;
} => {
  const commitFileSets: string[][] = [];
  let scannedCommits = 0;
  let skippedLargeCommits = 0;
  let currentFiles = new Set<string>();

  const flush = () => {
    if (currentFiles.size <= 1) {
      currentFiles = new Set<string>();
      return;
    }

    if (currentFiles.size > maxFilesPerCommit) {
      skippedLargeCommits++;
      currentFiles = new Set<string>();
      return;
    }

    commitFileSets.push(Array.from(currentFiles).sort());
    currentFiles = new Set<string>();
  };

  const lines = String(gitLogOutput || '').split('\n');
  for (const rawLine of lines) {
    const line = normalizePath(rawLine);
    if (!line) continue;

    if (line === COMMIT_MARKER) {
      scannedCommits++;
      flush();
      continue;
    }

    if (!indexedFiles.has(line)) continue;
    currentFiles.add(line);
  }

  flush();
  return { commitFileSets, scannedCommits, skippedLargeCommits };
};

const computeConfidence = (support: number, ratio: number): number => {
  const score = 0.2 + Math.min(0.5, ratio * 0.45) + Math.min(0.15, support * 0.03);
  const clamped = Math.max(0.2, Math.min(0.85, score));
  return Number(clamped.toFixed(3));
};

const buildCochangeEdges = (
  commitFileSets: string[][],
  minSupport: number,
  maxNeighborsPerFile: number,
): GraphRelationship[] => {
  const fileTouchCounts = new Map<string, number>();
  const pairSupport = new Map<string, number>();

  for (const files of commitFileSets) {
    for (const filePath of files) {
      fileTouchCounts.set(filePath, (fileTouchCounts.get(filePath) || 0) + 1);
    }

    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = pairKey(files[i], files[j]);
        pairSupport.set(key, (pairSupport.get(key) || 0) + 1);
      }
    }
  }

  const candidatesBySource = new Map<string, CochangeCandidate[]>();
  for (const [key, support] of pairSupport) {
    if (support < minSupport) continue;

    const separator = key.indexOf('\u0000');
    if (separator <= 0) continue;
    const fileA = key.slice(0, separator);
    const fileB = key.slice(separator + 1);

    const fileASupport = fileTouchCounts.get(fileA) || 0;
    const fileBSupport = fileTouchCounts.get(fileB) || 0;
    const denominator = Math.max(1, Math.min(fileASupport, fileBSupport));
    const ratio = Number((support / denominator).toFixed(3));
    const confidence = computeConfidence(support, ratio);

    const candidateA: CochangeCandidate = {
      sourceFilePath: fileA,
      targetFilePath: fileB,
      support,
      ratio,
      confidence,
    };
    const candidateB: CochangeCandidate = {
      sourceFilePath: fileB,
      targetFilePath: fileA,
      support,
      ratio,
      confidence,
    };

    const listA = candidatesBySource.get(fileA) || [];
    listA.push(candidateA);
    candidatesBySource.set(fileA, listA);

    const listB = candidatesBySource.get(fileB) || [];
    listB.push(candidateB);
    candidatesBySource.set(fileB, listB);
  }

  const edges: GraphRelationship[] = [];
  for (const [sourceFilePath, candidates] of candidatesBySource) {
    const topCandidates = candidates
      .sort((left, right) => {
        if (right.support !== left.support) return right.support - left.support;
        if (right.confidence !== left.confidence) return right.confidence - left.confidence;
        return left.targetFilePath.localeCompare(right.targetFilePath);
      })
      .slice(0, maxNeighborsPerFile);

    for (const candidate of topCandidates) {
      const sourceId = generateId('File', sourceFilePath);
      const targetId = generateId('File', candidate.targetFilePath);
      edges.push({
        id: generateId('CO_CHANGES_WITH', `${sourceId}->${targetId}`),
        type: 'CO_CHANGES_WITH',
        sourceId,
        targetId,
        confidence: candidate.confidence,
        reason: `git-history:cochange:support=${candidate.support};ratio=${candidate.ratio.toFixed(3)}`,
      });
    }
  }

  return edges;
};

export const processGitHistoryCochange = async (
  repoPath: string,
  indexedFilePaths: string[],
  onProgress?: (message: string, progress: number) => void,
  options: GitHistoryCochangeOptions = {},
): Promise<GitHistoryCochangeResult> => {
  const maxCommits = Math.max(25, Math.floor(options.maxCommits || DEFAULT_MAX_COMMITS));
  const minSupport = Math.max(1, Math.floor(options.minSupport || DEFAULT_MIN_SUPPORT));
  const maxFilesPerCommit = Math.max(2, Math.floor(options.maxFilesPerCommit || DEFAULT_MAX_FILES_PER_COMMIT));
  const maxNeighborsPerFile = Math.max(1, Math.floor(options.maxNeighborsPerFile || DEFAULT_MAX_NEIGHBORS_PER_FILE));

  const indexedFiles = new Set(
    indexedFilePaths
      .map(filePath => normalizePath(filePath))
      .filter(Boolean),
  );

  const emptyResult = {
    edges: [],
    stats: {
      scannedCommits: 0,
      qualifyingCommits: 0,
      skippedLargeCommits: 0,
      pairCandidates: 0,
      maxCommits,
      minSupport,
      maxFilesPerCommit,
      maxNeighborsPerFile,
    },
  };

  if (indexedFiles.size === 0) {
    return emptyResult;
  }

  onProgress?.('Reading git history for cochange graph...', 0);

  let gitLogOutput = String(options.gitLogOutput || '');
  if (!gitLogOutput) {
    try {
      gitLogOutput = execFileSync(
        'git',
        ['log', '--name-only', `--pretty=format:${COMMIT_MARKER}`, '-n', String(maxCommits)],
        {
          cwd: repoPath,
          encoding: 'utf-8',
          maxBuffer: MAX_GIT_LOG_BUFFER,
        },
      );
    } catch {
      return emptyResult;
    }
  }

  onProgress?.('Parsing commit-level cochange sets...', 35);
  const parsed = parseCochangeCommits(gitLogOutput, indexedFiles, maxFilesPerCommit);
  if (parsed.commitFileSets.length === 0) {
    return {
      ...emptyResult,
      stats: {
        ...emptyResult.stats,
        scannedCommits: parsed.scannedCommits,
        skippedLargeCommits: parsed.skippedLargeCommits,
      },
    };
  }

  onProgress?.('Aggregating cochange support from git history...', 70);
  const edges = buildCochangeEdges(parsed.commitFileSets, minSupport, maxNeighborsPerFile);

  onProgress?.('Git-history cochange graph extraction complete.', 100);
  return {
    edges,
    stats: {
      scannedCommits: parsed.scannedCommits,
      qualifyingCommits: parsed.commitFileSets.length,
      skippedLargeCommits: parsed.skippedLargeCommits,
      pairCandidates: Math.floor(edges.length / 2),
      maxCommits,
      minSupport,
      maxFilesPerCommit,
      maxNeighborsPerFile,
    },
  };
};
