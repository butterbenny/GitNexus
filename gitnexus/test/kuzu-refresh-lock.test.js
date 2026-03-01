import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const runGit = (repoPath, args) => {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
};

const runAnalyze = (repoPath, env) => {
  return execFileSync(
    'node',
    [path.resolve('dist/cli/index.js'), 'analyze', repoPath, '--skip-embeddings', '--no-registry', '--no-hooks'],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    }
  );
};

const setupIndexedRepo = async (tmpRoot) => {
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, 'src', 'a.ts'),
    [
      'export const ping = () => 1;',
      '',
    ].join('\n'),
    'utf-8'
  );

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
  const output = runAnalyze(repoPath, env);
  assert.match(output, /Repository indexed successfully|Repository updated incrementally/i);

  return { repoPath, dbPath: path.join(repoPath, '.gitnexus', 'kuzu'), env };
};

test('MCP kuzu adapter: waits for active refresh lock before opening DB', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-kuzu-refresh-lock-mcp-'));
  const { repoPath, dbPath } = await setupIndexedRepo(tmpRoot);

  const { acquireRefreshLock } = await import('../dist/storage/refresh-lock.js');
  const { initKuzu, closeKuzu } = await import('../dist/mcp/core/kuzu-adapter.js');

  const lockLease = await acquireRefreshLock(repoPath, { timeoutMs: 2_000, pollMs: 100 });
  setTimeout(() => {
    void lockLease.release();
  }, 600);

  const startedAt = Date.now();
  await initKuzu('repo-lock-test', dbPath);
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs >= 450, `expected initKuzu wait >= 450ms, got ${elapsedMs}ms`);
  await closeKuzu('repo-lock-test');
});

test('core kuzu adapter: waits for active refresh lock before writer open', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-kuzu-refresh-lock-core-'));
  const { repoPath, dbPath } = await setupIndexedRepo(tmpRoot);

  const { acquireRefreshLock } = await import('../dist/storage/refresh-lock.js');
  const { initKuzu, closeKuzu } = await import('../dist/core/kuzu/kuzu-adapter.js');

  const lockLease = await acquireRefreshLock(repoPath, { timeoutMs: 2_000, pollMs: 100 });
  setTimeout(() => {
    void lockLease.release();
  }, 600);

  const startedAt = Date.now();
  await initKuzu(dbPath);
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs >= 450, `expected writer initKuzu wait >= 450ms, got ${elapsedMs}ms`);
  await closeKuzu();
});
