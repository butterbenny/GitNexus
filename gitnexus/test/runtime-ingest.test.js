import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const runGit = (repoPath, args) => {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
};

test('CLI runtime-ingest: merges, normalizes, and replaces runtime snapshot payloads', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-runtime-ingest-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const ok = true;\n', 'utf-8');

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const inputPath = path.join(tmpRoot, 'runtime-input.json');
  await fs.writeFile(
    inputPath,
    JSON.stringify({
      request_spans: [
        { method: 'POST', route: '/api/payments', duration_ms: 820, payload_bytes: 245000 },
      ],
      db_queries: [
        { sql: 'select * from transactions where id = ?', duration_ms: 130, lock_wait_ms: 30 },
      ],
      payload_shapes: [
        { path: '/api/payments', item_count: 125, bytes: 245000, keys: ['payments', 'transactions'] },
      ],
    }, null, 2),
    'utf-8',
  );

  execFileSync(
    'node',
    [
      path.resolve('dist/cli/index.js'),
      'runtime-ingest',
      inputPath,
      '--repo',
      repoPath,
      '--request-span',
      JSON.stringify({ method: 'GET', route: '/api/inline', duration_ms: 210, status: 200 }),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, GITNEXUS_DISABLE_CLAUDE_HOOK: '1' },
      stdio: 'pipe',
      encoding: 'utf-8',
    },
  );

  const snapshotPath = path.join(repoPath, '.gitnexus', 'runtime-observations.json');
  const firstSnapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf-8'));
  assert.equal(firstSnapshot.request_spans.length, 2);
  assert.equal(firstSnapshot.db_queries.length, 1);
  assert.equal(firstSnapshot.payload_shapes.length, 1);

  execFileSync(
    'node',
    [
      path.resolve('dist/cli/index.js'),
      'runtime-ingest',
      inputPath,
      '--repo',
      repoPath,
      '--request-span',
      JSON.stringify({ method: 'GET', route: '/api/inline', duration_ms: 210, status: 200 }),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, GITNEXUS_DISABLE_CLAUDE_HOOK: '1' },
      stdio: 'pipe',
      encoding: 'utf-8',
    },
  );

  const secondSnapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf-8'));
  assert.equal(secondSnapshot.request_spans.length, 2, 'expected de-duplicated request spans after merge');
  assert.equal(secondSnapshot.db_queries.length, 1, 'expected de-duplicated DB queries after merge');
  assert.equal(secondSnapshot.payload_shapes.length, 1, 'expected de-duplicated payload shapes after merge');

  execFileSync(
    'node',
    [
      path.resolve('dist/cli/index.js'),
      'runtime-ingest',
      '--repo',
      repoPath,
      '--replace',
      '--request-span',
      JSON.stringify({ method: 'PATCH', route: '/api/reset', duration_ms: 55, status: 202 }),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, GITNEXUS_DISABLE_CLAUDE_HOOK: '1' },
      stdio: 'pipe',
      encoding: 'utf-8',
    },
  );

  const replacedSnapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf-8'));
  assert.equal(replacedSnapshot.request_spans.length, 1, 'expected replace mode to reset request spans');
  assert.equal(replacedSnapshot.db_queries.length, 0, 'expected replace mode to reset DB queries');
  assert.equal(replacedSnapshot.payload_shapes.length, 0, 'expected replace mode to reset payload shapes');
  assert.equal(replacedSnapshot.request_spans[0]?.route, '/api/reset');
});
