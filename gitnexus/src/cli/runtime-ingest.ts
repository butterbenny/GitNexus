import fs from 'fs/promises';
import path from 'path';
import {
  emptyRuntimeObservationSnapshot,
  loadRuntimeObservationSnapshot,
  mergeRuntimeObservationSnapshots,
  parseRuntimeObservationPayload,
  parseRuntimeObservationText,
} from '../core/ingestion/runtime-observation-store.js';
import { safeStringify } from '../lib/safe-json.js';
import { getGitRoot, isGitRepo } from '../storage/git.js';

const output = (data: any): void => {
  const text = typeof data === 'string' ? data : safeStringify(data, 2);
  process.stderr.write(text + '\n');
};

const normalizeList = (value?: string[]): string[] => {
  if (!Array.isArray(value) || value.length === 0) return [];
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean);
};

const parseInlineJsonList = (items: string[], label: string): any[] => {
  const parsed: any[] = [];
  for (const item of items) {
    try {
      parsed.push(JSON.parse(item));
    } catch (error: any) {
      throw new Error(`Invalid ${label} JSON: ${error?.message || 'parse error'}`);
    }
  }
  return parsed;
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
};

const resolveRepoRoot = (value?: string): string | null => {
  const basePath = value ? path.resolve(value) : process.cwd();
  const gitRoot = getGitRoot(basePath);
  if (gitRoot) return gitRoot;
  if (isGitRepo(basePath)) return basePath;
  return null;
};

export async function runtimeIngestCommand(inputPath: string | undefined, options?: {
  repo?: string;
  input?: string[];
  output?: string;
  replace?: boolean;
  print?: boolean;
  requestSpan?: string[];
  dbQuery?: string[];
  payloadShape?: string[];
}): Promise<void> {
  const repoRoot = resolveRepoRoot(options?.repo);
  if (!repoRoot) {
    console.error('Usage: gitnexus runtime-ingest [input] [--repo <path>]. Repo path must be inside a git worktree.');
    process.exit(1);
  }

  const storagePath = path.join(repoRoot, '.gitnexus');
  const outputPath = options?.output
    ? path.resolve(options.output)
    : path.join(storagePath, 'runtime-observations.json');

  const inputPaths = [
    ...normalizeList(inputPath ? [inputPath] : []),
    ...normalizeList(options?.input),
  ].map(item => (path.isAbsolute(item) ? item : path.resolve(repoRoot, item)));

  const snapshots = [];

  for (const filePath of inputPaths) {
    const raw = await fs.readFile(filePath, 'utf-8');
    const extension = path.extname(filePath).toLowerCase();
    const snapshot = parseRuntimeObservationText(raw, extension === '.ndjson' ? 'ndjson' : 'json');
    snapshot.source_files = [filePath];
    snapshots.push(snapshot);
  }

  const hasInline = normalizeList(options?.requestSpan).length > 0
    || normalizeList(options?.dbQuery).length > 0
    || normalizeList(options?.payloadShape).length > 0;
  if (hasInline) {
    const inlineSnapshot = parseRuntimeObservationPayload({
      request_spans: parseInlineJsonList(normalizeList(options?.requestSpan), '--request-span'),
      db_queries: parseInlineJsonList(normalizeList(options?.dbQuery), '--db-query'),
      payload_shapes: parseInlineJsonList(normalizeList(options?.payloadShape), '--payload-shape'),
    });
    inlineSnapshot.source_files = ['inline-cli'];
    snapshots.push(inlineSnapshot);
  }

  if (process.stdin.isTTY === false) {
    const stdinRaw = await readStdin();
    const cleaned = String(stdinRaw || '').trim();
    if (cleaned) {
      const stdinSnapshot = parseRuntimeObservationText(cleaned);
      stdinSnapshot.source_files = ['stdin'];
      snapshots.push(stdinSnapshot);
    }
  }

  const incoming = mergeRuntimeObservationSnapshots(snapshots);
  const existing = options?.replace
    ? emptyRuntimeObservationSnapshot()
    : await loadRuntimeObservationSnapshot(storagePath, {
      repoPath: repoRoot,
      extraPaths: [outputPath],
    });
  const merged = mergeRuntimeObservationSnapshots([existing, incoming]);
  merged.generatedAt = new Date().toISOString();

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, safeStringify(merged, 2), 'utf-8');

  output({
    status: 'ok',
    repo: repoRoot,
    output: outputPath,
    mode: options?.replace ? 'replace' : 'merge',
    added: {
      request_spans: incoming.request_spans.length,
      db_queries: incoming.db_queries.length,
      payload_shapes: incoming.payload_shapes.length,
    },
    total: {
      request_spans: merged.request_spans.length,
      db_queries: merged.db_queries.length,
      payload_shapes: merged.payload_shapes.length,
      source_files: merged.source_files.length,
    },
  });

  if (options?.print) {
    output({ snapshot: merged });
  }
}
