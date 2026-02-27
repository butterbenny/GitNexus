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

test('MCP refresh: picks up analyze --no-registry via .gitnexus/meta.json mtime', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-no-registry-refresh-'));
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
  const first = runAnalyze(repoPath, [], env);
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

  const script = [
    "import assert from 'node:assert/strict';",
    "import { execFileSync } from 'node:child_process';",
    "import path from 'node:path';",
    "import { LocalBackend } from './dist/mcp/local/local-backend.js';",
    '',
    `const repoPath = ${JSON.stringify(repoPath)};`,
    `const env = ${JSON.stringify(env)};`,
    '',
    'const backend = new LocalBackend();',
    'await backend.init();',
    '',
    "const before = await backend.callTool('context', { name: 'fetchUsers' });",
    "assert.equal(before.status, 'found');",
    'assert.ok(before.index_status && before.index_status.isStale);',
    '',
    "// Refresh in a separate process without touching the global registry (~/.gitnexus).",
    "const out = execFileSync('node', [path.resolve('dist/cli/index.js'), 'analyze', repoPath, '--skip-embeddings', '--no-registry', '--no-hooks'], {",
    '  cwd: process.cwd(),',
    '  env: { ...process.env, ...env },',
    "  encoding: 'utf-8',",
    '});',
    "assert.match(out, /Repository indexed successfully|Repository updated incrementally/i);",
    '',
    "const after = await backend.callTool('context', { name: 'fetchUsers' });",
    "assert.equal(after.status, 'found');",
    '',
    'process.stdout.write(JSON.stringify({ before, after }));',
  ].join('\n');

  const raw = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
  const { after } = JSON.parse(raw);

  // If LocalBackend did not refresh from meta.json, it would still think the index is stale.
  assert.ok(!after.index_status);
});
