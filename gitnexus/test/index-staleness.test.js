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
    [path.resolve('dist/cli/index.js'), 'analyze', repoPath, '--skip-embeddings'],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    }
  );
};

const runTool = (method, params, env) => {
  const script = [
    "import { LocalBackend } from './dist/mcp/local/local-backend.js';",
    'const backend = new LocalBackend();',
    'await backend.init();',
    `const result = await backend.callTool(${JSON.stringify(method)}, ${JSON.stringify(params)});`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');

  const raw = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
  return JSON.parse(raw);
};

test('MCP tools: include index_status when stale vs HEAD', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stale-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'src', 'a.ts'),
    [
      'export const fetchUsers = () => {',
      '  return 1;',
      '};',
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
  const first = runAnalyze(repoPath, env);
  assert.match(first, /Repository indexed successfully/i);

  // Advance HEAD without re-indexing
  await fs.writeFile(
    path.join(repoPath, 'src', 'a.ts'),
    [
      'export const fetchUsers = () => {',
      '  return 2;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'change']);

  const ctx = runTool('context', { name: 'fetchUsers' }, env);
  assert.equal(ctx.status, 'found');
  assert.ok(ctx.index_status);
  assert.equal(ctx.index_status.isStale, true);
  assert.ok(typeof ctx.index_status.refreshCommand === 'string' && ctx.index_status.refreshCommand.includes('analyze'));
  assert.ok(ctx.index_status.indexedCommit);
  assert.ok(ctx.index_status.headCommit);
  assert.notEqual(ctx.index_status.indexedCommit, ctx.index_status.headCommit);
});

