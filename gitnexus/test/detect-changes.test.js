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

test('MCP detect_changes: includes untracked files for unstaged scope', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-detect-changes-untracked-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
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

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
  const output = runAnalyze(repoPath, env);
  assert.match(output, /Repository (indexed successfully|updated incrementally)/i);

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
    path.join(repoPath, 'src/newFeature.ts'),
    [
      'export const newFeature = true;',
      '',
    ].join('\n'),
    'utf-8'
  );

  const result = runTool('detect_changes', { repo: repoPath, scope: 'unstaged' }, env);
  assert.ok(result.summary, 'expected summary block');
  assert.ok(Array.isArray(result.changed_files), 'expected changed_files list');
  assert.ok(result.changed_files.some(file => file.filePath === 'src/doThing.ts' && file.status === 'Modified'));
  assert.ok(result.changed_files.some(file => file.filePath === 'src/newFeature.ts' && file.status === 'Untracked'));
  assert.ok(Number(result.summary.untracked_files || 0) >= 1, 'expected untracked_files count >= 1');
});

test('MCP detect_changes: maps symbols by exact file path', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-detect-changes-paths-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, 'src/Foo.ts'),
    [
      'export function runFoo(): number {',
      '  return 1;',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );
  await fs.writeFile(
    path.join(repoPath, 'src/Foo.tsx'),
    [
      'export const FooView = () => {',
      '  return <div>Foo</div>;',
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
  const output = runAnalyze(repoPath, env);
  assert.match(output, /Repository (indexed successfully|updated incrementally)/i);

  await fs.writeFile(
    path.join(repoPath, 'src/Foo.ts'),
    [
      'export function runFoo(): number {',
      '  return 2;',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  const result = runTool('detect_changes', { repo: repoPath, scope: 'unstaged' }, env);
  assert.ok(Array.isArray(result.changed_files), 'expected changed_files list');
  assert.ok(result.changed_files.some(file => file.filePath === 'src/Foo.ts'));
  assert.ok(!result.changed_files.some(file => file.filePath === 'src/Foo.tsx'));
  assert.ok(Array.isArray(result.changed_symbols), 'expected changed_symbols list');
  assert.ok(
    result.changed_symbols.every(symbol => symbol.filePath === 'src/Foo.ts'),
    'expected changed_symbols to map only to exact changed file path'
  );
});
