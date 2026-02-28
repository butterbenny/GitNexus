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

const collectSymbols = (result) => {
  const syms = [];
  if (Array.isArray(result?.process_symbols)) syms.push(...result.process_symbols);
  if (Array.isArray(result?.definitions)) syms.push(...result.definitions);
  return syms;
};

test('MCP query/action_plan: supports path_prefixes scoping', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-path-prefixes-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'apps', 'backend', 'src'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps', 'dashboard', 'src'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'apps', 'backend', 'src', 'users.ts'),
    [
      'export function fetchUsers(): number {',
      '  return 1;',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps', 'dashboard', 'src', 'users.ts'),
    [
      'export function fetchUsers(): number {',
      '  return 2;',
      '}',
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
  const analyzeOutput = runAnalyze(repoPath, env);
  assert.match(analyzeOutput, /Repository indexed successfully/i);

  const unscoped = runTool('query', { query: 'fetchUsers' }, env);
  const unscopedSymbols = collectSymbols(unscoped);
  assert.ok(unscopedSymbols.some(s => s?.filePath === 'apps/backend/src/users.ts'), 'expected unscoped query to include backend symbol');
  assert.ok(unscopedSymbols.some(s => s?.filePath === 'apps/dashboard/src/users.ts'), 'expected unscoped query to include dashboard symbol');

  const scoped = runTool('query', { query: 'fetchUsers', path_prefixes: ['apps/backend/'] }, env);
  const scopedSymbols = collectSymbols(scoped);
  assert.ok(scopedSymbols.length > 0, 'expected scoped query to return at least one symbol');
  assert.ok(
    scopedSymbols.every(s => typeof s?.filePath === 'string' && s.filePath.startsWith('apps/backend/')),
    'expected all scoped symbols to be under apps/backend/'
  );

  const scopedAbs = runTool(
    'query',
    { query: 'fetchUsers', path_prefixes: [path.join(repoPath, 'apps', 'backend')] },
    env
  );
  const scopedAbsSymbols = collectSymbols(scopedAbs);
  assert.ok(scopedAbsSymbols.length > 0, 'expected absolute scoped query to return at least one symbol');
  assert.ok(
    scopedAbsSymbols.every(s => typeof s?.filePath === 'string' && s.filePath.startsWith('apps/backend/')),
    'expected absolute scoped symbols to be under apps/backend/'
  );

  const plan = runTool(
    'action_plan',
    { query: 'fetchUsers', path_prefixes: ['apps/backend/'], limit_files: 50, limit_checks: 5 },
    env
  );
  assert.equal(plan?.status, 'ok');
  assert.ok(Array.isArray(plan?.files) && plan.files.length > 0, 'expected action_plan to return scoped files');
  assert.ok(
    plan.files.every((f) => typeof f?.filePath === 'string' && f.filePath.startsWith('apps/backend/')),
    'expected all action_plan files to be under apps/backend/'
  );
});

