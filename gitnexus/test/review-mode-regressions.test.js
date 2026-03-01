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
