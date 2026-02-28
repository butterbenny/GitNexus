import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const runGit = (repoPath, args) => {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
};

const runAnalyze = (repoPath, args, env) => {
  try {
    return execFileSync(
      'node',
      [path.resolve('dist/cli/index.js'), 'analyze', repoPath, '--skip-embeddings', ...args],
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

test('MCP repo resolution: supports repo as absolute path without registry', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-mcp-repo-path-'));
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

  const out = runAnalyze(repoPath, ['--no-registry', '--no-hooks'], env);
  assert.match(out, /Repository indexed successfully|Repository updated incrementally/i);

  const script = [
    "import assert from 'node:assert/strict';",
    "import { realpathSync } from 'node:fs';",
    "import { LocalBackend } from './dist/mcp/local/local-backend.js';",
    '',
    `const repoPath = ${JSON.stringify(repoPath)};`,
    'const expected = realpathSync(repoPath);',
    '',
    'const backend = new LocalBackend();',
    'await backend.init();',
    '',
    "const before = await backend.callTool('list_repos');",
    'assert.ok(Array.isArray(before));',
    'assert.equal(before.length, 0);',
    '',
    "const ctx = await backend.callTool('context', { repo: repoPath, name: 'fetchUsers' });",
    "assert.equal(ctx.status, 'found');",
    '',
    "const after = await backend.callTool('list_repos');",
    'assert.ok(Array.isArray(after));',
    'assert.ok(after.some(r => {',
    '  try { return realpathSync(String(r?.path || \"\")) === expected; } catch { return false; }',
    '}));',
    '',
    'process.stdout.write(JSON.stringify({ before, after }));',
  ].join('\n');

  execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
});
