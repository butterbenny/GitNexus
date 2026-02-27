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
  try {
    return execFileSync(
      'node',
      [path.resolve('dist/cli/index.js'), 'analyze', repoPath, '--skip-embeddings'],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        encoding: 'utf-8',
      }
    );
  } catch (e) {
    const err = e;
    const stdout = (err?.stdout || '').toString();
    const stderr = (err?.stderr || '').toString();
    const status = err?.status ?? err?.code ?? 'unknown';
    throw new Error(
      [
        `analyze failed (status: ${status})`,
        stdout && `STDOUT:\n${stdout}`,
        stderr && `STDERR:\n${stderr}`,
      ]
        .filter(Boolean)
        .join('\n\n')
    );
  }
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

test('MCP ergonomics: context()/impact() include edge confidence + reason', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-mcp-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'src', 'a.ts'),
    [
      'export const fetchUsers = () => {',
      '  return 1;',
      '};',
      '',
      'export const callFetchUsers = () => {',
      '  return fetchUsers();',
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

  const ctx = runTool('context', { name: 'fetchUsers' }, env);
  assert.equal(ctx.status, 'found');
  const incomingCalls = ctx.incoming?.calls ?? [];
  assert.ok(Array.isArray(incomingCalls));
  const callFetchUsers = incomingCalls.find(e => e?.name === 'callFetchUsers');
  assert.ok(callFetchUsers);
  assert.equal(callFetchUsers.reason, 'same-file');
  assert.equal(typeof callFetchUsers.confidence, 'number');

  const impact = runTool(
    'impact',
    { name: 'callFetchUsers', direction: 'downstream', maxDepth: 1, minConfidence: 0 },
    env
  );
  const depth1 = impact.byDepth?.[1] ?? [];
  assert.ok(Array.isArray(depth1));
  const fetchUsers = depth1.find(e => e?.name === 'fetchUsers');
  assert.ok(fetchUsers);
  assert.equal(fetchUsers.reason, 'same-file');
  assert.equal(typeof fetchUsers.confidence, 'number');

  const plan = runTool('action_plan', { query: 'fetchUsers', limit_files: 5, limit_checks: 5 }, env);
  assert.equal(plan.status, 'ok');
  assert.ok(Array.isArray(plan.files));
  assert.ok(plan.files.some(f => f?.filePath === 'src/a.ts'));
  assert.ok(Array.isArray(plan.checks));
  assert.ok(plan.checks.length > 0);
  assert.ok(Array.isArray(plan.hops));
});
