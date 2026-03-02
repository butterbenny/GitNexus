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
      },
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
        .join('\n\n'),
    );
  }
};

const runQueryWithForcedPrimaryMiss = ({ repoPath, query, forcedMissQuery }, env) => {
  const script = [
    "import { LocalBackend } from './dist/mcp/local/local-backend.js';",
    'const backend = new LocalBackend();',
    'await backend.init();',
    'const originalBm25Search = backend.bm25Search.bind(backend);',
    `const forcedMissQuery = ${JSON.stringify(forcedMissQuery)};`,
    'backend.bm25Search = async (repo, q, limit) => {',
    '  if (String(q || \'\').trim() === forcedMissQuery) return [];',
    '  return originalBm25Search(repo, q, limit);',
    '};',
    `const result = await backend.callTool('query', ${JSON.stringify({ repo: repoPath, query })});`,
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
  const symbols = [];
  if (Array.isArray(result?.process_symbols)) symbols.push(...result.process_symbols);
  if (Array.isArray(result?.definitions)) symbols.push(...result.definitions);
  return symbols;
};

test('MCP query: adaptive BM25 fallback recovers results when primary probe misses', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-adaptive-bm25-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'src', 'payments.ts'),
    [
      'export function chargeSavedPaymentMethod(): string {',
      "  return 'ok';",
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = {
    GITNEXUS_HOME: path.join(tmpRoot, 'global'),
    GITNEXUS_DISABLE_CLAUDE_HOOK: '1',
  };

  const analyzeOutput = runAnalyze(repoPath, env);
  assert.match(analyzeOutput, /Repository indexed successfully/i);

  const query = 'charge saved payment method flow';
  const result = runQueryWithForcedPrimaryMiss(
    { repoPath, query, forcedMissQuery: query },
    env,
  );

  const retrieval = result?.query_plan?.retrieval || {};
  assert.equal(retrieval.bm25_adaptive_attempted, true);
  assert.ok((retrieval.bm25_adaptive_probe_count || 0) > 0, 'expected adaptive probes to be emitted');
  assert.ok((retrieval.bm25_adaptive_hits || 0) > 0, 'expected adaptive fallback to recover BM25 hits');
  assert.ok((retrieval.bm25_hits || 0) > 0, 'expected total BM25 hits to include adaptive results');

  const symbols = collectSymbols(result);
  assert.ok(
    symbols.some(symbol => String(symbol?.name || '').includes('chargeSavedPaymentMethod')),
    'expected recovered symbols to include chargeSavedPaymentMethod',
  );
});

test('MCP query: fuzzy prod queries de-prioritize test files while explicit test queries retain test coverage', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-adaptive-bm25-test-bias-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'tests'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'src', 'payments.ts'),
    [
      'export function chargeSavedPaymentMethod(): string {',
      "  return 'ok';",
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  await fs.writeFile(
    path.join(repoPath, 'tests', 'payments.spec.ts'),
    [
      'export function chargeSavedPaymentMethodSpecHelper(): string {',
      "  return 'spec';",
      '}',
      '',
    ].join('\n'),
    'utf-8',
  );

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = {
    GITNEXUS_HOME: path.join(tmpRoot, 'global'),
    GITNEXUS_DISABLE_CLAUDE_HOOK: '1',
  };
  const analyzeOutput = runAnalyze(repoPath, env);
  assert.match(analyzeOutput, /Repository indexed successfully/i);

  const prodQuery = 'charge saved payment method flow';
  const prodResult = runQueryWithForcedPrimaryMiss(
    { repoPath, query: prodQuery, forcedMissQuery: prodQuery },
    env,
  );
  const prodSymbols = collectSymbols(prodResult);
  assert.ok(prodSymbols.length > 0, 'expected symbols for prod fuzzy query');
  assert.equal(
    String(prodSymbols[0]?.filePath || '').includes('tests/'),
    false,
    'expected top prod fuzzy result to avoid test files',
  );

  const testQuery = 'charge saved payment method test flow';
  const testResult = runQueryWithForcedPrimaryMiss(
    { repoPath, query: testQuery, forcedMissQuery: testQuery },
    env,
  );
  const testSymbols = collectSymbols(testResult);
  assert.ok(
    testSymbols.some(symbol => String(symbol?.filePath || '').includes('tests/')),
    'expected explicit test query to retain test symbol coverage',
  );
});
