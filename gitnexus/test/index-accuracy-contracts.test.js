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
      },
    );
  } catch (e) {
    const err = e;
    const stdout = (err?.stdout || '').toString();
    const stderr = (err?.stderr || '').toString();
    const status = err?.status ?? err?.code ?? 'unknown';
    const signal = err?.signal ?? '';
    throw new Error(
      [
        `analyze failed (status: ${status}${signal ? `, signal: ${signal}` : ''})`,
        stdout && `STDOUT:\n${stdout}`,
        stderr && `STDERR:\n${stderr}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
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

const createAnalyzedFixtureRepo = async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-index-accuracy-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.cp(fixtureRepoPath, repoPath, { recursive: true });
  await fs.rm(path.join(repoPath, '.gitnexus'), { recursive: true, force: true });

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = {
    GITNEXUS_HOME: path.join(tmpRoot, 'global'),
    GITNEXUS_DISABLE_CLAUDE_HOOK: '1',
  };

  const output = runAnalyze(repoPath, env);
  assert.match(output, ANALYZE_READY_RE);

  return { repoPath, env };
};

test('Index accuracy: query returns proof-carrying slice cards by default', async () => {
  const { repoPath, env } = await createAnalyzedFixtureRepo();

  const query = runTool('query', {
    repo: repoPath,
    query: 'UserController',
  }, env);

  assert.ok(Array.isArray(query.slice_cards));
  assert.ok(query.slice_cards.length > 0);

  const topSlice = query.slice_cards[0];
  assert.ok(Array.isArray(topSlice.closure_slots));
  assert.ok(Array.isArray(topSlice.closed_slots));
  assert.ok(topSlice.gap_signals && typeof topSlice.gap_signals.total === 'number');
  assert.ok(topSlice.proof_spans, 'expected proof_spans on default query slice card');
  assert.ok(
    Array.isArray(topSlice.proof_spans?.symbols) && topSlice.proof_spans.symbols.length > 0,
    'expected proof symbol spans for slice card',
  );
  assert.ok(
    Array.isArray(topSlice.matched_members) && topSlice.matched_members.some(member => String(member?.filePath || '').includes('UserController.php')),
    'expected slice to carry matched members from UserController',
  );
});

test('Index accuracy: kernel heads expose expected contract fields on fixture repo', async () => {
  const { repoPath, env } = await createAnalyzedFixtureRepo();

  const queryMode = runTool('query_mode', {
    repo: repoPath,
    query: 'fetchUsers',
  }, env);
  assert.equal(queryMode.status, 'ok');
  assert.ok(queryMode.query_mode?.query_plan);
  assert.ok(Array.isArray(queryMode.query_mode?.slices));
  assert.ok(queryMode.query_mode.slices.length > 0);
  assert.ok(Array.isArray(queryMode.query_mode?.action_hints?.hops));
  assert.ok(
    queryMode.query_mode.action_hints.hops.some(hop => String(hop?.controller?.name || '').includes('UserController::index')),
    'expected query_mode hops to include UserController::index',
  );

  const implementMode = runTool('implement_mode', {
    repo: repoPath,
    query: 'fetchUsers',
  }, env);
  assert.equal(implementMode.status, 'ok');
  assert.ok(implementMode.implement_mode?.target);
  assert.ok(Array.isArray(implementMode.implement_mode?.write_plan));
  assert.ok(implementMode.implement_mode.write_plan.length > 0);
  assert.equal(implementMode.implement_mode?.post_edit_review?.tool, 'review_mode');
  assert.ok(Array.isArray(implementMode.implement_mode?.verification_checklist));

  const reviewMode = runTool('review_mode', {
    repo: repoPath,
    scope: 'all',
    include_ui_contracts: false,
  }, env);
  assert.equal(reviewMode.status, 'ok');
  assert.ok(reviewMode.summary);
  assert.ok(reviewMode.review_kernel);
  assert.ok(Array.isArray(reviewMode.review_kernel?.findings));
  assert.ok(Array.isArray(reviewMode.suggested_tests));

  const debugMode = runTool('debug_mode', {
    repo: repoPath,
    query: 'fetchUsers',
    symptom: '403 forbidden',
    runtime_observations: {
      request_spans: [
        { method: 'GET', route: '/api/users', duration_ms: 850, payload_bytes: 155000, status: 403 },
      ],
      db_queries: [
        {
          sql: 'select * from users where deleted_at is null',
          duration_ms: 160,
          lock_wait_ms: 50,
          rows_examined: 10000,
        },
      ],
    },
  }, env);
  assert.equal(debugMode.status, 'ok');
  assert.ok(debugMode.debug?.classification);
  assert.ok(Array.isArray(debugMode.debug?.candidates));
  assert.ok(debugMode.debug.candidates.length > 0);
  assert.ok(Array.isArray(debugMode.debug?.next_actions));
});

test('Index performance contract: fixture analyze no-op then incremental update remain healthy', async () => {
  const { repoPath, env } = await createAnalyzedFixtureRepo();

  const noOpOutput = runAnalyze(repoPath, env);
  assert.match(noOpOutput, ANALYZE_READY_RE);
  assert.match(noOpOutput, /Already up to date|updated incrementally|indexed successfully/i);

  const userControllerPath = path.join(repoPath, 'app/Http/Controllers/UserController.php');
  const source = await fs.readFile(userControllerPath, 'utf-8');
  await fs.writeFile(
    userControllerPath,
    `${source.trimEnd()}\n\n// incremental-regression-touch\n`,
    'utf-8',
  );

  const incrementalOutput = runAnalyze(repoPath, env);
  assert.match(incrementalOutput, ANALYZE_READY_RE);
  assert.match(incrementalOutput, /updated incrementally|indexed successfully/i);

  const context = runTool('context', {
    repo: repoPath,
    name: 'index',
    file_path: 'app/Http/Controllers/UserController.php',
  }, env);
  assert.equal(context.status, 'found');
  assert.ok(Array.isArray(context.incoming?.calls));
});
