import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const runGit = (repoPath, args) => {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
};

const runAnalyze = (repoPath, env) => {
  const result = spawnSync(
    'node',
    [path.resolve('dist/cli/index.js'), 'analyze', repoPath, '--skip-embeddings'],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    }
  );

  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');

  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(
      [
        `analyze failed (status: ${result.status})`,
        stdout && `STDOUT:\n${stdout}`,
        stderr && `STDERR:\n${stderr}`,
      ]
        .filter(Boolean)
        .join('\n\n')
    );
  }

  return stdout + stderr;
};

const runToolWithSemanticPatch = (method, params, env, semanticRows) => {
  const patch = JSON.stringify(Array.isArray(semanticRows) ? semanticRows : []);
  const script = [
    "import { LocalBackend } from './dist/mcp/local/local-backend.js';",
    'const backend = new LocalBackend();',
    'backend.hasSemanticVectorIndex = async () => true;',
    `backend.semanticSearch = async () => ${patch};`,
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

test('MCP query: semantic retrieval auto-mode follows brain promotion state', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-semantic-mode-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'src', 'users.ts'),
    [
      'export function fetchUsers(): number {',
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
  const analyzeOutput = runAnalyze(repoPath, env);
  assert.match(analyzeOutput, /Repository indexed successfully/i);

  const manifestPath = path.join(repoPath, '.gitnexus', 'manifests', 'brain.json');
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });

  const semanticRows = [
    {
      nodeId: 'Function:src/users.ts:fetchUsers',
      name: 'fetchUsers',
      type: 'Function',
      filePath: 'src/users.ts',
      distance: 0.12,
      startLine: 1,
      endLine: 3,
    },
  ];

  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      evalGraph: {
        canaryHarness: { promotionAllowed: true },
        regressionTracking: { openRegressions: 0 },
      },
      distillationEngine: {
        promotion: { promoted: true },
        riskScorer: { level: 'low' },
      },
    }, null, 2),
    'utf-8'
  );

  const assistResult = runToolWithSemanticPatch(
    'query',
    { repo: repoPath, query: 'zebra semantic intent token' },
    env,
    semanticRows
  );
  assert.equal(assistResult?.query_plan?.retrieval?.semantic_mode, 'assist');
  assert.equal(assistResult?.query_plan?.retrieval?.semantic_mode_source, 'brain-promotion');
  assert.equal(assistResult?.query_plan?.retrieval?.semantic_attempted, true);
  assert.equal(assistResult?.query_plan?.retrieval?.semantic_hits, 1);
  assert.equal(assistResult?.query_plan?.retrieval?.semantic_contributed_hits, 1);
  assert.equal(assistResult?.query_plan?.retrieval?.semantic_used, true);
  assert.ok(
    collectSymbols(assistResult).some(symbol => symbol?.id === 'Function:src/users.ts:fetchUsers'),
    'expected assist mode to surface semantic-only candidate'
  );

  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      evalGraph: {
        canaryHarness: { promotionAllowed: false },
        regressionTracking: { openRegressions: 2 },
      },
      distillationEngine: {
        promotion: { promoted: false },
        riskScorer: { level: 'high' },
      },
    }, null, 2),
    'utf-8'
  );

  const shadowResult = runToolWithSemanticPatch(
    'query',
    { repo: repoPath, query: 'zebra semantic intent token' },
    env,
    semanticRows
  );
  assert.equal(shadowResult?.query_plan?.retrieval?.semantic_mode, 'shadow');
  assert.equal(shadowResult?.query_plan?.retrieval?.semantic_mode_source, 'brain-shadow');
  assert.equal(shadowResult?.query_plan?.retrieval?.semantic_attempted, true);
  assert.equal(shadowResult?.query_plan?.retrieval?.semantic_hits, 1);
  assert.equal(shadowResult?.query_plan?.retrieval?.semantic_contributed_hits, 0);
  assert.equal(shadowResult?.query_plan?.retrieval?.semantic_used, false);
  assert.equal(collectSymbols(shadowResult).length, 0, 'expected shadow mode to keep semantic out of ranking');
});
