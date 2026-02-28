/**
 * Archetypes CLI Command
 *
 * Derives “flow signatures” from Process traces to surface common archetypes
 * and exemplar execution flows — without changing graph schema.
 */

import { LocalBackend } from '../mcp/local/local-backend.js';
import { safeStringify } from '../lib/safe-json.js';

let _backend: LocalBackend | null = null;

async function getBackend(): Promise<LocalBackend> {
  if (_backend) return _backend;
  _backend = new LocalBackend();
  const ok = await _backend.init();
  if (!ok) {
    console.error('GitNexus: No indexed repositories found. Run: gitnexus analyze');
    process.exit(1);
  }
  return _backend;
}

function output(data: any): void {
  const text = typeof data === 'string' ? data : safeStringify(data, 2);
  // stderr because KuzuDB captures stdout at OS level
  process.stderr.write(text + '\n');
}

export async function archetypesCommand(options?: {
  repo?: string;
  limit?: string;
  examples?: string;
  pathPrefix?: string[];
  minHttpConfidence?: string;
}): Promise<void> {
  const backend = await getBackend();

  const limit = options?.limit ? parseInt(options.limit) : undefined;
  const examplesPerSignature = options?.examples ? parseInt(options.examples) : undefined;
  const minHttpConfidence = options?.minHttpConfidence ? parseFloat(options.minHttpConfidence) : undefined;

  const result = await backend.queryArchetypes(options?.repo, {
    limit,
    examplesPerSignature,
    minHttpConfidence,
    path_prefixes: options?.pathPrefix,
  });

  output(result);
}
