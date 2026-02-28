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

test('MCP review_mode: emits changed symbols, suggested tests, and UI contract diffs', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-review-mode-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'tests'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/pages'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'src/doThing.ts'),
    [
      'export function doThing(): number {',
      '  return 1;',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'tests/doThing.test.ts'),
    [
      "import { doThing } from '../src/doThing';",
      '',
      'doThing();',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/FooPage.tsx'),
    [
      "import { useMutation, useQueryClient } from '@tanstack/react-query';",
      '',
      'export const FooPage = () => {',
      '  const queryClient = useQueryClient();',
      '',
      '  const { mutate } = useMutation({',
      '    mutationFn: async () => 1,',
      '    onSuccess: () => {',
      "      queryClient.invalidateQueries({ queryKey: ['foo'] });",
      '    },',
      '  });',
      '',
      '  return <button onClick={() => mutate()}>Save</button>;',
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
  const output1 = runAnalyze(repoPath, env);
  assert.match(output1, /Repository (indexed successfully|updated incrementally)/i);

  // Unstaged changes
  await fs.writeFile(
    path.join(repoPath, 'src/doThing.ts'),
    [
      'export function doThing(): number {',
      '  return 2;',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/FooPage.tsx'),
    [
      "import { useMutation, useQueryClient } from '@tanstack/react-query';",
      '',
      'export const FooPage = () => {',
      '  const queryClient = useQueryClient();',
      '',
      '  const { mutate } = useMutation({',
      '    mutationFn: async () => 1,',
      '    onSuccess: () => {',
      "      queryClient.invalidateQueries({ queryKey: ['foo'] });",
      "      queryClient.invalidateQueries({ queryKey: ['bar'] });",
      '    },',
      '  });',
      '',
      '  return <button onClick={() => mutate()}>Save</button>;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  const output2 = runAnalyze(repoPath, env);
  assert.match(output2, /Repository (indexed successfully|updated incrementally)/i);

  const result = runTool('review_mode', { repo: repoPath, scope: 'unstaged' }, env);
  assert.equal(result.status, 'ok');
  assert.ok(Array.isArray(result.changed_files) && result.changed_files.length >= 2);

  assert.ok(
    result.changed_files.some(f => f.filePath === 'src/doThing.ts'),
    'expected changed_files to include src/doThing.ts'
  );
  assert.ok(
    result.changed_files.some(f => f.filePath === 'apps/dashboard/src/pages/FooPage.tsx'),
    'expected changed_files to include FooPage.tsx'
  );

  assert.ok(
    Array.isArray(result.changed_symbols) && result.changed_symbols.some(s => s.filePath === 'src/doThing.ts' && s.name === 'doThing'),
    'expected changed_symbols to include doThing()'
  );

  assert.ok(
    Array.isArray(result.suggested_tests) && result.suggested_tests.some(t => t.filePath === 'tests/doThing.test.ts'),
    'expected suggested_tests to include tests/doThing.test.ts'
  );

  const doThingCard = (result.symbols || []).find(s => s?.symbol?.filePath === 'src/doThing.ts' && s?.symbol?.name === 'doThing');
  assert.ok(doThingCard, 'expected symbols[] to include doThing review card');
  assert.ok(
    Array.isArray(doThingCard.test_callers) && doThingCard.test_callers.some(c => c.filePath === 'tests/doThing.test.ts'),
    'expected doThing test_callers to include tests/doThing.test.ts'
  );

  const fooContract = (result.ui_contracts || []).find(u => u?.filePath === 'apps/dashboard/src/pages/FooPage.tsx');
  assert.ok(fooContract, 'expected ui_contracts to include FooPage.tsx');
  assert.ok(fooContract.diff, 'expected FooPage ui contract diff');
  assert.equal(fooContract.diff.base_ref, 'HEAD');
  assert.equal(fooContract.diff.effects_summary.base.invalidate, 1);
  assert.equal(fooContract.diff.effects_summary.current.invalidate, 2);

  // Scoped mode should drop FooPage.tsx
  const scoped = runTool('review_mode', { repo: repoPath, scope: 'unstaged', path_prefixes: ['src/'] }, env);
  assert.equal(scoped.status, 'ok');
  assert.ok(scoped.changed_files.every(f => String(f.filePath || '').startsWith('src/')));
  assert.ok(!scoped.changed_files.some(f => f.filePath === 'apps/dashboard/src/pages/FooPage.tsx'));
});

