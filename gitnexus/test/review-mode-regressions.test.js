import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ANALYZE_READY_RE = /Repository (indexed successfully|updated incrementally|already indexed \(no indexable changes\))|Already up to date/i;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureRepoPath = path.resolve(__dirname, '../../gitnexus-test-setup/fixture-laravel');

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

test('MCP review_mode: apiResource routes avoid false high route-target-missing', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-review-route-regression-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.cp(fixtureRepoPath, repoPath, { recursive: true });
  await fs.rm(path.join(repoPath, '.gitnexus'), { recursive: true, force: true });

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
  const output1 = runAnalyze(repoPath, env);
  assert.match(output1, ANALYZE_READY_RE);

  await fs.writeFile(
    path.join(repoPath, 'routes/api.php'),
    [
      '<?php',
      '',
      'use App\\Http\\Controllers\\UserController;',
      'use Illuminate\\Support\\Facades\\Route;',
      '',
      "Route::apiResource('users', '\\\\' . UserController::class, ['as' => 'api']);",
      '',
      '// touch',
      '',
    ].join('\n'),
    'utf-8'
  );

  const output2 = runAnalyze(repoPath, env);
  assert.match(output2, ANALYZE_READY_RE);

  const result = runTool('review_mode', {
    repo: repoPath,
    scope: 'unstaged',
    include_ui_contracts: false,
    include_evidence_spans: false,
    include_slice_stencil: false,
  }, env);
  assert.equal(result.status, 'ok');

  const routeTargetMissing = (result.review_kernel?.findings || []).find(finding => {
    return finding?.code === 'route-target-missing'
      && String(finding?.evidence?.filePath || '') === 'routes/api.php';
  });
  assert.equal(routeTargetMissing, undefined);

  const unresolved = (result.review_kernel?.findings || []).find(finding => {
    return finding?.code === 'route-target-unresolved'
      && String(finding?.evidence?.filePath || '') === 'routes/api.php';
  });
  if (unresolved) {
    assert.equal(unresolved.severity, 'medium');
  }
});

test('review_mode internals: slot normalization and severity gating for missing required slots', async () => {
  const module = await import('../dist/mcp/local/local-backend.js');
  const internals = module.__reviewModeInternals;
  assert.ok(internals, 'expected __reviewModeInternals export');

  assert.deepEqual(
    internals.normalizeSliceStencilTokens(["'anchor'", '"handler"', '`authorization`', ' entrypoint ', '', null]),
    ['anchor', 'handler', 'authorization', 'entrypoint'],
  );
  assert.deepEqual(
    internals.normalizeSliceStencilTokens(internals.parseStringList("['anchor', 'handler', '`authorization`']")),
    ['anchor', 'handler', 'authorization'],
  );

  assert.equal(internals.missingRequiredSlotSeverity(["'authorization'", "'entrypoint'"], true, false), 'medium');
  assert.equal(internals.missingRequiredSlotSeverity(["'anchor'"], true, false), 'high');
  assert.equal(internals.missingRequiredSlotSeverity(['authorization'], false, true), 'low');
});

test('MCP review_mode: convergence prioritizes suggested tests and findings', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-review-convergence-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'tests'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'src/marker.ts'),
    [
      'export const marker = 1;',
      '',
    ].join('\n'),
    'utf-8',
  );
  await fs.writeFile(
    path.join(repoPath, 'tests/a-first.test.ts'),
    [
      'export const aFirst = 1;',
      '',
    ].join('\n'),
    'utf-8',
  );
  await fs.writeFile(
    path.join(repoPath, 'tests/z-focus.test.ts'),
    [
      'export const zFocus = 1;',
      '',
    ].join('\n'),
    'utf-8',
  );

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
  const output1 = runAnalyze(repoPath, env);
  assert.match(output1, ANALYZE_READY_RE);

  await fs.writeFile(
    path.join(repoPath, 'tests/a-first.test.ts'),
    [
      'export const aFirst = 2;',
      '',
    ].join('\n'),
    'utf-8',
  );
  await fs.writeFile(
    path.join(repoPath, 'tests/z-focus.test.ts'),
    [
      'export const zFocus = 2;',
      '',
    ].join('\n'),
    'utf-8',
  );
  await fs.writeFile(
    path.join(repoPath, 'src/a-note.ts'),
    [
      'export const aNote = true;',
      '',
    ].join('\n'),
    'utf-8',
  );
  await fs.writeFile(
    path.join(repoPath, 'src/z-focus-impl.ts'),
    [
      'export const zFocusImpl = true;',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.mkdir(path.join(repoPath, '.gitnexus'), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, '.gitnexus/lamination_matrix.json'),
    JSON.stringify({
      topCells: [
        {
          cluster: 'Focus',
          signature: 'z focus impl',
          carbonCopyReadyScore: 100,
          signatureTopRoute: '',
          exemplarSlices: [
            {
              label: 'z focus impl',
              entryFile: 'src/z-focus-impl.ts',
              terminalFile: 'tests/z-focus.test.ts',
            },
          ],
        },
      ],
    }, null, 2),
    'utf-8',
  );

  const result = runTool('review_mode', {
    repo: repoPath,
    scope: 'unstaged',
    include_ui_contracts: false,
    include_evidence_spans: false,
    include_slice_stencil: false,
  }, env);
  assert.equal(result.status, 'ok');
  assert.equal(result._review_mode?.convergence?.enabled, true);
  assert.ok(Number(result._review_mode?.convergence?.matrix_cells || 0) >= 1);
  assert.ok(Number(result._review_mode?.convergence?.suggested_tests_boosted || 0) >= 1);
  assert.ok(Number(result._review_mode?.convergence?.findings_boosted || 0) >= 1);
  assert.ok((result._review_mode?.convergence?.ranking_weights?.suggested_tests?.convergence_score || 0) > 0);
  assert.ok((result._review_mode?.convergence?.ranking_weights?.findings?.severity || 0) > 0);

  const aFirstSuggested = (result.suggested_tests || []).find(test => test?.filePath === 'tests/a-first.test.ts');
  const zFocusSuggested = (result.suggested_tests || []).find(test => test?.filePath === 'tests/z-focus.test.ts');
  assert.ok(aFirstSuggested, 'expected a-first suggested test');
  assert.ok(zFocusSuggested, 'expected z-focus suggested test');
  assert.ok(
    Number(zFocusSuggested?.score || 0) > Number(aFirstSuggested?.score || 0),
    'expected convergence to boost z-focus suggested test score above a-first',
  );
  assert.equal(result.suggested_tests?.[0]?.filePath, 'tests/z-focus.test.ts');
  assert.ok(Number(result.suggested_tests?.[0]?.ranking?.score || 0) > 0);
  assert.ok(Number(result.suggested_tests?.[0]?.ranking?.components?.convergence_score || 0) > 0);

  const untrackedFindings = (result.review_kernel?.findings || []).filter(finding => finding?.code === 'untracked-file');
  assert.ok(untrackedFindings.length >= 2, 'expected untracked findings for both files');
  assert.equal(String(untrackedFindings[0]?.evidence?.filePath || ''), 'src/z-focus-impl.ts');
  assert.ok(Number(untrackedFindings[0]?.convergence?.score || 0) > 0);
  assert.ok(Number(untrackedFindings[0]?.ranking?.score || 0) > 0);
});

test('MCP review_mode: convergence matrix loads from reports fallback path', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-review-convergence-fallback-'));
  const repoName = 'lamination-fallback-repo';
  const repoPath = path.join(tmpRoot, repoName);
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'tests'), { recursive: true });

  const reportsRoot = path.join(process.cwd(), 'reports', `${repoName}-patterns`, 'pass-2');
  const reportsMatrixPath = path.join(reportsRoot, 'lamination_matrix.json');

  await fs.writeFile(
    path.join(repoPath, 'src/fallback-focus.ts'),
    [
      'export const fallbackFocus = 1;',
      '',
    ].join('\n'),
    'utf-8',
  );
  await fs.writeFile(
    path.join(repoPath, 'tests/fallback-focus.test.ts'),
    [
      'export const fallbackFocusTest = 1;',
      '',
    ].join('\n'),
    'utf-8',
  );

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
  const output1 = runAnalyze(repoPath, env);
  assert.match(output1, ANALYZE_READY_RE);

  await fs.writeFile(
    path.join(repoPath, 'tests/fallback-focus.test.ts'),
    [
      'export const fallbackFocusTest = 2;',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.mkdir(reportsRoot, { recursive: true });
  await fs.writeFile(
    reportsMatrixPath,
    JSON.stringify({
      topCells: [
        {
          cluster: 'Fallback',
          signature: 'fallback focus',
          carbonCopyReadyScore: 96,
          signatureTopRoute: '',
          exemplarSlices: [
            {
              label: 'fallback focus',
              entryFile: 'src/fallback-focus.ts',
              terminalFile: 'tests/fallback-focus.test.ts',
            },
          ],
        },
      ],
    }, null, 2),
    'utf-8',
  );

  try {
    const result = runTool('review_mode', {
      repo: repoPath,
      scope: 'unstaged',
      include_ui_contracts: false,
      include_evidence_spans: false,
      include_slice_stencil: false,
    }, env);
    assert.equal(result.status, 'ok');
    assert.equal(result._review_mode?.convergence?.enabled, true);
    assert.equal(result._review_mode?.convergence?.source_path, reportsMatrixPath);
  } finally {
    await fs.rm(path.join(process.cwd(), 'reports', `${repoName}-patterns`), { recursive: true, force: true });
  }
});
