import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolvePathInsideRepo } from '../dist/mcp/local/local-backend.js';

test('LocalBackend path safety: resolvePathInsideRepo keeps paths inside repo root', () => {
  const repoPath = path.join(os.tmpdir(), 'gitnexus-local-backend-path-safety-repo');

  const safeRelative = resolvePathInsideRepo(repoPath, 'src/index.ts');
  assert.ok(safeRelative);
  assert.equal(safeRelative.relativePath, 'src/index.ts');
  assert.equal(safeRelative.absolutePath, path.join(repoPath, 'src', 'index.ts'));

  const safeAbsolute = resolvePathInsideRepo(repoPath, path.join(repoPath, 'src', 'safe.ts'));
  assert.ok(safeAbsolute);
  assert.equal(safeAbsolute.relativePath, 'src/safe.ts');

  const traversal = resolvePathInsideRepo(repoPath, '../../etc/passwd');
  assert.equal(traversal, null);

  const absoluteOutside = resolvePathInsideRepo(repoPath, '/etc/passwd');
  assert.equal(absoluteOutside, null);
});

test('LocalBackend rename/source scan guard: file reads and writes use repo path resolver', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'src', 'mcp', 'local', 'local-backend.ts'), 'utf-8');

  assert.match(source, /const resolved = resolvePathInsideRepo\(repo\.repoPath,\s*sym\.filePath\)/);
  assert.match(source, /const resolved = resolvePathInsideRepo\(repo\.repoPath,\s*ref\.filePath\)/);
  assert.match(source, /const resolved = resolvePathInsideRepo\(repo\.repoPath,\s*normalizedFile\)/);
  assert.match(source, /const resolved = resolvePathInsideRepo\(repo\.repoPath,\s*change\.file_path\)/);
  assert.match(source, /const resolvedPath = resolvePathInsideRepo\(repo\.repoPath,\s*rawPath\)/);
});
