import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { getCurrentCommit, getWorkingTreeFileChanges, isGitRepo } from '../../storage/git.js';

export type PrecisionOverlayMode = 'off' | 'auto' | 'scip' | 'shadow' | 'lsp-probe';
export type PrecisionProducerKind = 'scip' | 'lsp' | 'stack-graph' | 'none';

export interface PrecisionSnapshotV1 {
  schemaVersion: 1;
  workspaceRoot: string;
  producer: {
    kind: 'scip' | 'lsp' | 'stack-graph';
    mode: 'batch' | 'probe';
    name: string;
    version?: string;
    runId: string;
    generatedAt: string;
  };
  documents: Array<{
    path: string;
    language?: string;
    positionEncoding?: 'utf8' | 'utf16' | 'utf32';
  }>;
  symbols: Array<{
    externalId: string;
    displayName?: string;
    kind?: string;
    path: string;
    range: [number, number, number, number];
    enclosingExternalId?: string;
    isLocal?: boolean;
  }>;
  occurrences: Array<{
    externalId: string;
    path: string;
    range: [number, number, number, number];
    roles: Array<'definition' | 'reference' | 'implementation' | 'import'>;
  }>;
  relations: Array<{
    type:
      | 'DEFINES'
      | 'REFERENCES'
      | 'IMPLEMENTS'
      | 'OVERRIDES'
      | 'TYPE_DEFINITION'
      | 'IMPORTS'
      | 'CALLS'
      | 'EXTENDS';
    fromExternalId: string;
    toExternalId: string;
    path?: string;
    range?: [number, number, number, number];
    precisionTier: 'compiler' | 'language-server' | 'dsl';
    confidence: number;
    evidence?: string[];
  }>;
  unresolved: Array<{
    path: string;
    range: [number, number, number, number];
    reason: string;
  }>;
}

export interface PrecisionProducerResult {
  mode: PrecisionOverlayMode;
  producer: PrecisionProducerKind;
  skipped: boolean;
  skipReason?: string;
  warnings: string[];
  overlayPath: string;
  runDir?: string;
  runId?: string;
  cacheKey?: string;
  cacheHit?: boolean;
  snapshotPath?: string;
  producerMetaPath?: string;
  statsPath?: string;
  declaredRelations: number;
}

interface OverlayRelationRecord {
  type: string;
  source?: {
    id?: string;
    filePath?: string;
    name?: string;
    line?: number;
    startLine?: number;
  };
  target?: {
    id?: string;
    filePath?: string;
    name?: string;
    line?: number;
    startLine?: number;
  };
  confidence?: number;
  reason?: string;
  provider?: string;
}

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<CommandResult>;

export interface PrecisionProducerOptions {
  mode?: PrecisionOverlayMode;
  overlayPath?: string;
  forceRefresh?: boolean;
  onProgress?: (message: string) => void;
  commandRunner?: CommandRunner;
  scipJson?: string;
}

interface CommandSpec {
  command: string;
  args: string[];
}

const PRECISION_SCHEMA_VERSION = 1;
const DEFAULT_OVERLAY_PATH = '.gitnexus/precision-overlay.json';
const DEFAULT_MODE: PrecisionOverlayMode = 'auto';
const DEFAULT_RUNNER: CommandRunner = async (command, args, cwd) => {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk || '');
    });

    child.on('error', error => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
      });
    });

    child.on('close', exitCode => {
      resolve({
        exitCode: Number(exitCode) || 0,
        stdout,
        stderr,
      });
    });
  });
};

const normalizePath = (value: string): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const nowIso = (): string => new Date().toISOString();

export const normalizePrecisionOverlayMode = (value: unknown): PrecisionOverlayMode => {
  const normalized = String(value || DEFAULT_MODE).trim().toLowerCase();
  if (normalized === 'off' || normalized === 'none' || normalized === 'disabled') return 'off';
  if (normalized === 'auto') return 'auto';
  if (normalized === 'scip') return 'scip';
  if (normalized === 'shadow') return 'shadow';
  if (normalized === 'lsp-probe' || normalized === 'lsp_probe' || normalized === 'lspprobe') return 'lsp-probe';
  return DEFAULT_MODE;
};

const exists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const splitCommand = (value: string): string[] => {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const matches = raw.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!matches) return [];
  return matches
    .map(token => token.replace(/^"(.*)"$/, '$1').trim())
    .filter(Boolean);
};

const toCommandSpec = (value: string | null | undefined): CommandSpec | null => {
  const tokens = splitCommand(String(value || ''));
  if (tokens.length === 0) return null;
  return {
    command: tokens[0],
    args: tokens.slice(1),
  };
};

const probeCommand = async (
  runner: CommandRunner,
  cwd: string,
  spec: CommandSpec,
): Promise<boolean> => {
  const result = await runner(spec.command, [...spec.args, '--version'], cwd);
  if (result.exitCode === 0) return true;
  const helpResult = await runner(spec.command, [...spec.args, '--help'], cwd);
  return helpResult.exitCode === 0;
};

const firstAvailableCommand = async (
  runner: CommandRunner,
  cwd: string,
  candidates: Array<CommandSpec | null>,
): Promise<CommandSpec | null> => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (await probeCommand(runner, cwd, candidate)) return candidate;
  }
  return null;
};

const readHashInput = async (repoPath: string, relativePath: string): Promise<string> => {
  const fullPath = path.join(repoPath, relativePath);
  try {
    const content = await fs.readFile(fullPath);
    return createHash('sha1').update(content).digest('hex');
  } catch {
    return '';
  }
};

const buildCacheKey = async (
  repoPath: string,
  mode: PrecisionOverlayMode,
  scipSpec: CommandSpec | null,
): Promise<{ cacheKey: string; commit: string; dirtyFingerprint: string; inputFingerprint: string }> => {
  const gitAvailable = isGitRepo(repoPath);
  const commit = gitAvailable ? (getCurrentCommit(repoPath) || 'no-commit') : 'no-git';
  const workingChanges = gitAvailable
    ? getWorkingTreeFileChanges(repoPath)
    : { changed: [], deleted: [] };
  const dirtyFiles = [...workingChanges.changed, ...workingChanges.deleted]
    .map(normalizePath)
    .filter(Boolean)
    .sort();
  const dirtyFingerprint = createHash('sha1').update(JSON.stringify(dirtyFiles)).digest('hex');

  const fingerprintInputs = [
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'package.json',
    'tsconfig.json',
    'jsconfig.json',
    'composer.lock',
    'composer.json',
  ];

  const resolvedInputHashes: Array<[string, string]> = [];
  for (const fp of fingerprintInputs) {
    const hash = await readHashInput(repoPath, fp);
    if (!hash) continue;
    resolvedInputHashes.push([fp, hash]);
  }

  const payload = JSON.stringify({
    mode,
    schemaVersion: PRECISION_SCHEMA_VERSION,
    commit,
    dirtyFingerprint,
    command: scipSpec ? [scipSpec.command, ...scipSpec.args].join(' ') : '',
    inputs: resolvedInputHashes,
  });

  const inputFingerprint = createHash('sha1').update(payload).digest('hex');
  const cacheKey = inputFingerprint.slice(0, 16);
  return { cacheKey, commit, dirtyFingerprint, inputFingerprint };
};

const parseRange = (value: unknown): [number, number, number, number] => {
  if (!Array.isArray(value)) return [1, 0, 1, 0];

  const nums = value.map(item => Number(item)).filter(item => Number.isFinite(item));
  if (nums.length === 4) {
    return [Math.max(1, nums[0] + 1), Math.max(0, nums[1]), Math.max(1, nums[2] + 1), Math.max(0, nums[3])];
  }

  if (nums.length === 3) {
    return [Math.max(1, nums[0] + 1), Math.max(0, nums[1]), Math.max(1, nums[0] + 1), Math.max(0, nums[2])];
  }

  if (nums.length === 2) {
    return [Math.max(1, nums[0] + 1), 0, Math.max(1, nums[0] + 1), Math.max(0, nums[1])];
  }

  if (nums.length === 1) {
    return [Math.max(1, nums[0] + 1), 0, Math.max(1, nums[0] + 1), 0];
  }

  return [1, 0, 1, 0];
};

const clampConfidence = (value: unknown, fallback = 0.95): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0.5) return 0.5;
  if (n > 0.99) return 0.99;
  return Number(n.toFixed(3));
};

const extractSimpleName = (value: string): string => {
  const cleaned = String(value || '').trim();
  if (!cleaned) return '';
  const parts = cleaned
    .split(/[./#:()<>\s]+/g)
    .map(part => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? String(parts[parts.length - 1]) : cleaned;
};

type ParsedOccurrenceRole = 'definition' | 'reference' | 'implementation' | 'import';

const parseOccurrenceRoles = (occurrence: any): ParsedOccurrenceRole[] => {
  const roles: ParsedOccurrenceRole[] = [];
  const raw = occurrence?.symbolRoles ?? occurrence?.roles ?? 0;
  const asNumber = Number(raw);

  if (Number.isFinite(asNumber)) {
    if ((asNumber & 1) !== 0) roles.push('definition');
    if ((asNumber & 2) !== 0) roles.push('import');
  } else if (Array.isArray(raw)) {
    for (const token of raw) {
      const normalized = String(token || '').toLowerCase();
      if (normalized.includes('definition')) roles.push('definition');
      if (normalized.includes('import')) roles.push('import');
      if (normalized.includes('implementation')) roles.push('implementation');
      if (normalized.includes('reference')) roles.push('reference');
    }
  }

  if (!roles.includes('definition') && !roles.includes('reference')) {
    roles.push('reference');
  }

  return Array.from(new Set(roles));
};

type SymbolSpan = {
  externalId: string;
  path: string;
  range: [number, number, number, number];
};

const findContainingSymbol = (
  definitions: SymbolSpan[],
  range: [number, number, number, number],
): SymbolSpan | null => {
  const [line, char] = range;
  let best: SymbolSpan | null = null;
  let bestSpan = Number.MAX_SAFE_INTEGER;

  for (const definition of definitions) {
    const [startLine, startChar, endLine, endChar] = definition.range;
    const startsBefore = line > startLine || (line === startLine && char >= startChar);
    const endsAfter = line < endLine || (line === endLine && char <= endChar);
    if (!startsBefore || !endsAfter) continue;

    const span = Math.max(1, (endLine - startLine) * 10_000 + (endChar - startChar));
    if (span < bestSpan) {
      best = definition;
      bestSpan = span;
    }
  }

  return best;
};

const normalizeScipIndex = (
  rawIndex: any,
  repoPath: string,
  runId: string,
  mode: PrecisionOverlayMode,
): PrecisionSnapshotV1 => {
  const metadata = rawIndex?.metadata || {};
  const toolInfo = metadata?.toolInfo || {};
  const producerName = String(toolInfo?.name || 'scip-typescript').trim() || 'scip-typescript';
  const producerVersion = String(toolInfo?.version || '').trim();

  const documentsRaw = Array.isArray(rawIndex?.documents) ? rawIndex.documents : [];
  const documents: PrecisionSnapshotV1['documents'] = [];
  const symbolsMap = new Map<string, PrecisionSnapshotV1['symbols'][number]>();
  const definitionsByPath = new Map<string, SymbolSpan[]>();
  const occurrences: PrecisionSnapshotV1['occurrences'] = [];
  const relations: PrecisionSnapshotV1['relations'] = [];
  const unresolved: PrecisionSnapshotV1['unresolved'] = [];
  const relationDedup = new Set<string>();

  const addRelation = (relation: PrecisionSnapshotV1['relations'][number]) => {
    const key = `${relation.type}|${relation.fromExternalId}|${relation.toExternalId}|${relation.path || ''}|${relation.range?.[0] || ''}|${relation.range?.[1] || ''}`;
    if (relationDedup.has(key)) return;
    relationDedup.add(key);
    relations.push(relation);
  };

  for (const rawDocument of documentsRaw) {
    const relPath = normalizePath(
      String(rawDocument?.relativePath || rawDocument?.path || rawDocument?.filePath || ''),
    );
    if (!relPath) continue;

    documents.push({
      path: relPath,
      language: String(rawDocument?.language || '').trim() || undefined,
      positionEncoding: 'utf8',
    });

    const definitions = definitionsByPath.get(relPath) || [];
    definitionsByPath.set(relPath, definitions);

    const rawOccurrences = Array.isArray(rawDocument?.occurrences) ? rawDocument.occurrences : [];
    for (const rawOccurrence of rawOccurrences) {
      const externalId = String(rawOccurrence?.symbol || '').trim();
      if (!externalId) continue;
      const range = parseRange(rawOccurrence?.range);
      const roles = parseOccurrenceRoles(rawOccurrence);

      occurrences.push({
        externalId,
        path: relPath,
        range,
        roles,
      });

      const existingSymbol = symbolsMap.get(externalId);
      if (!existingSymbol) {
        symbolsMap.set(externalId, {
          externalId,
          displayName: extractSimpleName(externalId),
          path: relPath,
          range,
          isLocal: !externalId.startsWith('scip-'),
        });
      } else if (!existingSymbol.path || roles.includes('definition')) {
        existingSymbol.path = relPath;
        existingSymbol.range = range;
      }

      if (roles.includes('definition')) {
        definitions.push({
          externalId,
          path: relPath,
          range,
        });
      }
    }

    const rawSymbols = Array.isArray(rawDocument?.symbols) ? rawDocument.symbols : [];
    for (const rawSymbol of rawSymbols) {
      const externalId = String(rawSymbol?.symbol || rawSymbol?.externalId || '').trim();
      if (!externalId) continue;

      const existingSymbol = symbolsMap.get(externalId);
      if (!existingSymbol) {
        symbolsMap.set(externalId, {
          externalId,
          displayName: String(rawSymbol?.displayName || extractSimpleName(externalId)).trim() || extractSimpleName(externalId),
          kind: String(rawSymbol?.kind || '').trim() || undefined,
          path: relPath,
          range: [1, 0, 1, 0],
          isLocal: !externalId.startsWith('scip-'),
        });
      } else {
        existingSymbol.displayName = String(rawSymbol?.displayName || existingSymbol.displayName || extractSimpleName(externalId)).trim() || existingSymbol.displayName;
        existingSymbol.kind = String(rawSymbol?.kind || existingSymbol.kind || '').trim() || existingSymbol.kind;
      }

      const relationships = Array.isArray(rawSymbol?.relationships) ? rawSymbol.relationships : [];
      for (const rawRelation of relationships) {
        const targetExternalId = String(rawRelation?.symbol || '').trim();
        if (!targetExternalId) continue;

        let relationType: PrecisionSnapshotV1['relations'][number]['type'] | null = null;
        if (rawRelation?.isImplementation) relationType = 'IMPLEMENTS';
        else if (rawRelation?.isTypeDefinition) relationType = 'TYPE_DEFINITION';
        else if (rawRelation?.isDefinition) relationType = 'DEFINES';
        else if (rawRelation?.isReference) relationType = 'REFERENCES';
        if (!relationType) continue;

        addRelation({
          type: relationType,
          fromExternalId: externalId,
          toExternalId: targetExternalId,
          path: relPath,
          precisionTier: 'compiler',
          confidence: relationType === 'REFERENCES' ? 0.93 : 0.97,
          evidence: ['scip-symbol-relationship'],
        });
      }
    }
  }

  for (const occurrence of occurrences) {
    if (occurrence.roles.includes('definition')) continue;

    const definitions = definitionsByPath.get(occurrence.path) || [];
    const container = findContainingSymbol(definitions, occurrence.range);
    if (!container) {
      unresolved.push({
        path: occurrence.path,
        range: occurrence.range,
        reason: `scip-occurrence:unable-to-resolve-container:${occurrence.externalId}`,
      });
      continue;
    }

    if (container.externalId === occurrence.externalId) continue;

    const relationType = occurrence.roles.includes('import') ? 'IMPORTS' : 'REFERENCES';
    addRelation({
      type: relationType,
      fromExternalId: container.externalId,
      toExternalId: occurrence.externalId,
      path: occurrence.path,
      range: occurrence.range,
      precisionTier: 'compiler',
      confidence: relationType === 'IMPORTS' ? 0.96 : 0.93,
      evidence: [relationType === 'IMPORTS' ? 'scip-occurrence:import' : 'scip-occurrence:reference'],
    });
  }

  const symbols = [...symbolsMap.values()].map(symbol => {
    const displayName = String(symbol.displayName || '').trim();
    return {
      ...symbol,
      displayName: displayName || extractSimpleName(symbol.externalId),
      path: normalizePath(symbol.path || ''),
    };
  }).filter(symbol => Boolean(symbol.path));

  return {
    schemaVersion: 1,
    workspaceRoot: path.resolve(repoPath),
    producer: {
      kind: 'scip',
      mode: mode === 'lsp-probe' ? 'probe' : 'batch',
      name: producerName,
      version: producerVersion || undefined,
      runId,
      generatedAt: nowIso(),
    },
    documents,
    symbols,
    occurrences,
    relations,
    unresolved,
  };
};

const mapSnapshotRelationType = (
  relationType: PrecisionSnapshotV1['relations'][number]['type'],
): string | null => {
  if (relationType === 'DEFINES') return 'DEFINES';
  if (relationType === 'IMPORTS') return 'IMPORTS';
  if (relationType === 'IMPLEMENTS') return 'IMPLEMENTS';
  if (relationType === 'OVERRIDES') return 'OVERRIDES';
  if (relationType === 'TYPE_DEFINITION' || relationType === 'EXTENDS') return 'EXTENDS';
  if (relationType === 'CALLS' || relationType === 'REFERENCES') return 'CALLS';
  return null;
};

const snapshotToOverlayRelations = (
  snapshot: PrecisionSnapshotV1,
): OverlayRelationRecord[] => {
  const symbolMap = new Map(snapshot.symbols.map(symbol => [symbol.externalId, symbol]));
  const overlayRelations: OverlayRelationRecord[] = [];
  const dedupe = new Set<string>();

  for (const relation of snapshot.relations) {
    const type = mapSnapshotRelationType(relation.type);
    if (!type) continue;

    const sourceSymbol = symbolMap.get(relation.fromExternalId);
    const targetSymbol = symbolMap.get(relation.toExternalId);
    if (!sourceSymbol || !targetSymbol) continue;
    if (!sourceSymbol.path || !targetSymbol.path) continue;

    const sourceLine = Number(sourceSymbol.range?.[0] || 0);
    const targetLine = Number(targetSymbol.range?.[0] || 0);

    const sourceName = extractSimpleName(sourceSymbol.displayName || sourceSymbol.externalId);
    const targetName = extractSimpleName(targetSymbol.displayName || targetSymbol.externalId);

    const key = `${type}|${sourceSymbol.path}|${sourceLine}|${targetSymbol.path}|${targetLine}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);

    overlayRelations.push({
      type,
      source: {
        filePath: sourceSymbol.path,
        line: sourceLine > 0 ? sourceLine : undefined,
        ...(sourceName ? { name: sourceName } : {}),
      },
      target: {
        filePath: targetSymbol.path,
        line: targetLine > 0 ? targetLine : undefined,
        ...(targetName ? { name: targetName } : {}),
      },
      confidence: clampConfidence(relation.confidence, relation.type === 'REFERENCES' ? 0.92 : 0.96),
      reason: relation.evidence?.[0] || relation.type.toLowerCase(),
      provider: snapshot.producer.kind,
    });
  }

  return overlayRelations;
};

const writeSnapshotJsonl = async (
  filePath: string,
  snapshot: PrecisionSnapshotV1,
): Promise<void> => {
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: 'meta',
    schemaVersion: snapshot.schemaVersion,
    workspaceRoot: snapshot.workspaceRoot,
    producer: snapshot.producer,
  }));

  for (const document of snapshot.documents) {
    lines.push(JSON.stringify({ type: 'document', document }));
  }
  for (const symbol of snapshot.symbols) {
    lines.push(JSON.stringify({ type: 'symbol', symbol }));
  }
  for (const occurrence of snapshot.occurrences) {
    lines.push(JSON.stringify({ type: 'occurrence', occurrence }));
  }
  for (const relation of snapshot.relations) {
    lines.push(JSON.stringify({ type: 'relation', relation }));
  }
  for (const unresolved of snapshot.unresolved) {
    lines.push(JSON.stringify({ type: 'unresolved', unresolved }));
  }

  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf-8');
};

const parseJsonSafely = (raw: string): any | null => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const parseNormalizedSnapshot = (
  value: any,
  repoPath: string,
  runId: string,
  mode: PrecisionOverlayMode,
): PrecisionSnapshotV1 | null => {
  if (value && Number(value.schemaVersion) === 1 && value.producer && Array.isArray(value.relations)) {
    return value as PrecisionSnapshotV1;
  }

  if (value && Array.isArray(value.documents)) {
    return normalizeScipIndex(value, repoPath, runId, mode);
  }

  return null;
};

const runScipProducer = async (
  repoPath: string,
  runDir: string,
  runner: CommandRunner,
  onProgress: (message: string) => void,
): Promise<{ parsedScip: any | null; producerMeta: Record<string, any>; warnings: string[] }> => {
  const warnings: string[] = [];
  const localBin = path.join(repoPath, 'node_modules', '.bin', 'scip-typescript');

  const scipTypescriptSpec = await firstAvailableCommand(
    runner,
    repoPath,
    [
      toCommandSpec(process.env.GITNEXUS_SCIP_TYPESCRIPT_CMD),
      await exists(localBin) ? { command: localBin, args: [] } : null,
      { command: 'scip-typescript', args: [] },
    ],
  );

  if (!scipTypescriptSpec) {
    warnings.push('scip-typescript not found (set GITNEXUS_SCIP_TYPESCRIPT_CMD or install scip-typescript)');
    return {
      parsedScip: null,
      producerMeta: {
        kind: 'scip',
        status: 'missing',
      },
      warnings,
    };
  }

  const scipSpec = await firstAvailableCommand(
    runner,
    repoPath,
    [
      toCommandSpec(process.env.GITNEXUS_SCIP_CMD),
      { command: 'scip', args: [] },
    ],
  );

  if (!scipSpec) {
    warnings.push('scip CLI not found (required for `scip print --json`)');
    return {
      parsedScip: null,
      producerMeta: {
        kind: 'scip',
        status: 'missing-print-cli',
        command: [scipTypescriptSpec.command, ...scipTypescriptSpec.args].join(' '),
      },
      warnings,
    };
  }

  const runIndexPath = path.join(runDir, 'index.scip');
  const repoIndexPath = path.join(repoPath, 'index.scip');
  const repoIndexPreExisting = await exists(repoIndexPath);

  onProgress('Running scip-typescript index...');
  let indexResult = await runner(
    scipTypescriptSpec.command,
    [...scipTypescriptSpec.args, 'index', '--output', runIndexPath],
    repoPath,
  );

  let indexPathForPrint = runIndexPath;
  if (indexResult.exitCode !== 0 || !(await exists(runIndexPath))) {
    indexResult = await runner(
      scipTypescriptSpec.command,
      [...scipTypescriptSpec.args, 'index'],
      repoPath,
    );

    if (indexResult.exitCode !== 0) {
      warnings.push(`scip-typescript index failed (${String(indexResult.stderr || indexResult.stdout).trim().slice(0, 240)})`);
      return {
        parsedScip: null,
        producerMeta: {
          kind: 'scip',
          status: 'index-failed',
          command: [scipTypescriptSpec.command, ...scipTypescriptSpec.args].join(' '),
          stderr: String(indexResult.stderr || '').trim().slice(0, 500),
        },
        warnings,
      };
    }

    if (!(await exists(repoIndexPath))) {
      warnings.push('scip-typescript index completed but produced no index.scip artifact');
      return {
        parsedScip: null,
        producerMeta: {
          kind: 'scip',
          status: 'missing-index-output',
          command: [scipTypescriptSpec.command, ...scipTypescriptSpec.args].join(' '),
        },
        warnings,
      };
    }

    try {
      await fs.copyFile(repoIndexPath, runIndexPath);
      indexPathForPrint = runIndexPath;
      if (!repoIndexPreExisting) {
        await fs.rm(repoIndexPath, { force: true });
      }
    } catch {
      indexPathForPrint = repoIndexPath;
    }
  }

  onProgress('Running scip print --json...');
  const printCandidates = [
    [...scipSpec.args, 'print', '--json', indexPathForPrint],
    [...scipSpec.args, 'print', indexPathForPrint, '--json'],
  ];

  let printResult: CommandResult | null = null;
  for (const args of printCandidates) {
    const run = await runner(scipSpec.command, args, repoPath);
    if (run.exitCode === 0 && String(run.stdout || '').trim()) {
      printResult = run;
      break;
    }
    printResult = run;
  }

  if (!printResult || printResult.exitCode !== 0 || !String(printResult.stdout || '').trim()) {
    warnings.push(`scip print --json failed (${String(printResult?.stderr || printResult?.stdout || '').trim().slice(0, 240)})`);
    return {
      parsedScip: null,
      producerMeta: {
        kind: 'scip',
        status: 'print-failed',
        indexPath: indexPathForPrint,
        command: [scipSpec.command, ...scipSpec.args].join(' '),
      },
      warnings,
    };
  }

  const parsedScip = parseJsonSafely(printResult.stdout);
  if (!parsedScip) {
    warnings.push('scip print output was not valid JSON');
    return {
      parsedScip: null,
      producerMeta: {
        kind: 'scip',
        status: 'invalid-json',
      },
      warnings,
    };
  }

  return {
    parsedScip,
    producerMeta: {
      kind: 'scip',
      status: 'ok',
      indexPath: indexPathForPrint,
      scipCommand: [scipSpec.command, ...scipSpec.args].join(' '),
      scipTypescriptCommand: [scipTypescriptSpec.command, ...scipTypescriptSpec.args].join(' '),
    },
    warnings,
  };
};

const resolveOverlayPath = (repoPath: string, overlayPath?: string): string => {
  const selected = String(overlayPath || DEFAULT_OVERLAY_PATH).trim() || DEFAULT_OVERLAY_PATH;
  return path.isAbsolute(selected) ? selected : path.join(repoPath, selected);
};

export const producePrecisionOverlay = async (
  repoPath: string,
  options: PrecisionProducerOptions = {},
): Promise<PrecisionProducerResult> => {
  const mode = normalizePrecisionOverlayMode(options.mode);
  const onProgress = options.onProgress || (() => {});
  const runner = options.commandRunner || DEFAULT_RUNNER;
  const canonicalOverlayPath = resolveOverlayPath(repoPath, options.overlayPath);
  const warnings: string[] = [];

  const baseResult: PrecisionProducerResult = {
    mode,
    producer: 'none',
    skipped: true,
    warnings,
    overlayPath: canonicalOverlayPath,
    declaredRelations: 0,
  };

  if (mode === 'off') {
    return {
      ...baseResult,
      skipReason: 'precision-overlay mode is off',
    };
  }

  if (mode === 'lsp-probe') {
    return {
      ...baseResult,
      producer: 'lsp',
      skipReason: 'lsp-probe mode is on-demand only; persisted producer run skipped',
    };
  }

  const tsconfigExists = await exists(path.join(repoPath, 'tsconfig.json'))
    || await exists(path.join(repoPath, 'jsconfig.json'));
  if (!tsconfigExists && mode === 'auto') {
    return {
      ...baseResult,
      skipReason: 'auto mode skipped: no tsconfig/jsconfig at repo root',
    };
  }

  const candidateSpec = toCommandSpec(process.env.GITNEXUS_SCIP_TYPESCRIPT_CMD)
    || ((await exists(path.join(repoPath, 'node_modules/.bin/scip-typescript')))
      ? { command: path.join(repoPath, 'node_modules/.bin/scip-typescript'), args: [] }
      : { command: 'scip-typescript', args: [] });
  const { cacheKey, commit, dirtyFingerprint, inputFingerprint } = await buildCacheKey(repoPath, mode, candidateSpec);
  const precisionRoot = path.join(repoPath, '.gitnexus', 'precision');
  const runDir = path.join(precisionRoot, 'runs', cacheKey);
  const runSnapshotPath = path.join(runDir, 'snapshot.jsonl');
  const runOverlayPath = path.join(runDir, 'overlay.json');
  const runStatsPath = path.join(runDir, 'stats.json');
  const runMetaPath = path.join(runDir, 'producer-meta.json');

  baseResult.runDir = runDir;
  baseResult.runId = cacheKey;
  baseResult.cacheKey = cacheKey;
  baseResult.snapshotPath = runSnapshotPath;
  baseResult.producerMetaPath = runMetaPath;
  baseResult.statsPath = runStatsPath;

  const cacheReady = !options.forceRefresh
    && await exists(runOverlayPath)
    && await exists(runSnapshotPath)
    && await exists(runMetaPath)
    && await exists(runStatsPath);

  if (cacheReady) {
    if (mode !== 'shadow') {
      await fs.mkdir(path.dirname(canonicalOverlayPath), { recursive: true });
      await fs.copyFile(runOverlayPath, canonicalOverlayPath);
    }

    const cachedOverlay = parseJsonSafely(await fs.readFile(runOverlayPath, 'utf-8'));
    const declaredRelations = Array.isArray(cachedOverlay?.relations) ? cachedOverlay.relations.length : 0;

    return {
      ...baseResult,
      producer: 'scip',
      skipped: false,
      cacheHit: true,
      overlayPath: mode === 'shadow' ? runOverlayPath : canonicalOverlayPath,
      declaredRelations,
      warnings,
    };
  }

  onProgress('Preparing precision producer run...');
  await fs.mkdir(runDir, { recursive: true });

  let parsedScip: any | null = null;
  let producerMeta: Record<string, any> = {
    kind: 'scip',
    status: 'unknown',
  };

  if (options.scipJson) {
    parsedScip = parseJsonSafely(options.scipJson);
    if (!parsedScip) {
      warnings.push('Provided scipJson was not valid JSON');
    } else {
      producerMeta = {
        kind: 'scip',
        status: 'ok',
        source: 'options.scipJson',
      };
    }
  } else {
    const produced = await runScipProducer(repoPath, runDir, runner, onProgress);
    parsedScip = produced.parsedScip;
    producerMeta = produced.producerMeta;
    warnings.push(...produced.warnings);
  }

  if (!parsedScip) {
    await fs.writeFile(runMetaPath, JSON.stringify({
      ...producerMeta,
      mode,
      cacheKey,
      commit,
      dirtyFingerprint,
      inputFingerprint,
      generatedAt: nowIso(),
      warnings,
    }, null, 2), 'utf-8');

    await fs.writeFile(runStatsPath, JSON.stringify({
      mode,
      producer: 'scip',
      status: producerMeta.status || 'skipped',
      declaredRelations: 0,
      cacheHit: false,
      warnings,
      generatedAt: nowIso(),
    }, null, 2), 'utf-8');

    return {
      ...baseResult,
      producer: 'scip',
      skipped: true,
      skipReason: warnings[0] || 'producer failed',
      cacheHit: false,
      declaredRelations: 0,
      warnings,
      overlayPath: canonicalOverlayPath,
    };
  }

  const normalizedSnapshot = parseNormalizedSnapshot(parsedScip, repoPath, cacheKey, mode);
  if (!normalizedSnapshot) {
    warnings.push('Unable to normalize producer output into PrecisionSnapshotV1');
    return {
      ...baseResult,
      producer: 'scip',
      skipped: true,
      skipReason: warnings[0],
      cacheHit: false,
      warnings,
      declaredRelations: 0,
    };
  }

  const overlayRelations = snapshotToOverlayRelations(normalizedSnapshot);
  const overlayDocument = {
    schemaVersion: PRECISION_SCHEMA_VERSION,
    provider: normalizedSnapshot.producer.kind,
    mode: normalizedSnapshot.producer.mode,
    producer: normalizedSnapshot.producer,
    relations: overlayRelations,
  };

  await writeSnapshotJsonl(runSnapshotPath, normalizedSnapshot);
  await fs.writeFile(runOverlayPath, JSON.stringify(overlayDocument, null, 2), 'utf-8');
  await fs.writeFile(runMetaPath, JSON.stringify({
    ...producerMeta,
    mode,
    cacheKey,
    commit,
    dirtyFingerprint,
    inputFingerprint,
    generatedAt: nowIso(),
    producer: normalizedSnapshot.producer,
    counts: {
      documents: normalizedSnapshot.documents.length,
      symbols: normalizedSnapshot.symbols.length,
      occurrences: normalizedSnapshot.occurrences.length,
      relations: normalizedSnapshot.relations.length,
      unresolved: normalizedSnapshot.unresolved.length,
      overlayRelations: overlayRelations.length,
    },
    warnings,
  }, null, 2), 'utf-8');

  await fs.writeFile(runStatsPath, JSON.stringify({
    mode,
    producer: 'scip',
    cacheHit: false,
    declaredRelations: overlayRelations.length,
    snapshotSchemaVersion: normalizedSnapshot.schemaVersion,
    generatedAt: nowIso(),
    warnings,
  }, null, 2), 'utf-8');

  if (mode !== 'shadow') {
    await fs.mkdir(path.dirname(canonicalOverlayPath), { recursive: true });
    await fs.copyFile(runOverlayPath, canonicalOverlayPath);
  }

  return {
    ...baseResult,
    producer: 'scip',
    skipped: false,
    cacheHit: false,
    overlayPath: mode === 'shadow' ? runOverlayPath : canonicalOverlayPath,
    declaredRelations: overlayRelations.length,
    warnings,
  };
};
