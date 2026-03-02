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
  await fs.mkdir(path.join(repoPath, 'app'), { recursive: true });
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

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/FooPage.test.ts'),
    [
      "import { FooPage } from './FooPage';",
      '',
      'void FooPage;',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/FooPage.test.ts'),
    [
      "import { FooPage } from './FooPage';",
      '',
      'FooPage();',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'app/PerfLoop.php'),
    [
      '<?php',
      '',
      'function touchLoop(array $items): void {',
      '    foreach ($items as $item) {',
      '        $id = $item[\'id\'] ?? null;',
      '    }',
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

  await fs.writeFile(
    path.join(repoPath, 'app/PerfLoop.php'),
    [
      '<?php',
      '',
      'function touchLoop(array $items, $model): void {',
      '    foreach ($items as $item) {',
      '        $id = $item[\'id\'] ?? null;',
      '        $match = array_filter($items, fn ($candidate) => ($candidate[\'id\'] ?? null) === $id);',
      '        $model->update([]);',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  const output2 = runAnalyze(repoPath, env);
  assert.match(output2, /Repository (indexed successfully|updated incrementally)/i);

  await fs.mkdir(path.join(repoPath, '.gitnexus'), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, '.gitnexus/runtime-observations.json'),
    JSON.stringify({
      generatedAt: '2026-01-02T00:00:00.000Z',
      request_spans: [
        {
          method: 'POST',
          route: '/api/foo',
          duration_ms: 980,
          payload_bytes: 320000,
          status: 200,
          file_path_hints: ['apps/dashboard/src/pages/FooPage.tsx'],
        },
        {
          method: 'POST',
          route: '/api/events/123/seating_groups/assign',
          duration_ms: 1420,
          payload_bytes: 520000,
          status: 200,
          file_path_hints: ['app/PerfLoop.php'],
        },
      ],
      db_queries: [
        {
          sql: 'update foo set updated_at = now() where id = ?',
          duration_ms: 210,
          lock_wait_ms: 60,
          rows_examined: 1200,
          file_path_hints: ['src/doThing.ts'],
        },
        {
          sql: 'update seating_assignments set seat_id = ? where ticket_id = ?',
          duration_ms: 420,
          lock_wait_ms: 140,
          rows_examined: 4200,
          count: 8,
          route: '/api/events/123/seating_groups/assign',
          file_path_hints: ['app/PerfLoop.php'],
        },
      ],
      payload_shapes: [
        {
          path: '/api/events/123/seating_groups/assign',
          item_count: 240,
          bytes: 410000,
          keys: ['event_id', 'group_ids', 'ticket_ids'],
          file_path_hints: ['app/PerfLoop.php'],
        },
      ],
    }, null, 2),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/UntrackedPage.tsx'),
    [
      'export const UntrackedPage = () => <div>untracked</div>;',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, '.php-cs-fixer.cache'),
    '{"php":"8.3","rules":[]}',
    'utf-8'
  );

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
    result.changed_files.some(f => f.filePath === 'apps/dashboard/src/pages/UntrackedPage.tsx' && f.status === 'Untracked'),
    'expected changed_files to include untracked dashboard file'
  );
  assert.ok(
    !result.changed_files.some(f => f.filePath === '.php-cs-fixer.cache'),
    'expected changed_files to exclude known tooling artifacts'
  );
  assert.ok(Array.isArray(result.untracked_files), 'expected untracked_files list');
  assert.ok(result.untracked_files.includes('apps/dashboard/src/pages/UntrackedPage.tsx'));
  assert.ok(!result.untracked_files.includes('.php-cs-fixer.cache'));
  assert.ok(Number(result.summary?.untracked_files || 0) >= 1, 'expected summary.untracked_files >= 1');
  assert.ok(Number(result.summary?.untracked_artifacts || 0) >= 1, 'expected summary.untracked_artifacts >= 1');
  assert.ok(Array.isArray(result.untracked_artifacts), 'expected untracked_artifacts list');
  assert.ok(
    result.untracked_artifacts.some(item => item.filePath === '.php-cs-fixer.cache' && String(item.guidance || '').includes('.git/info/exclude')),
    'expected .php-cs-fixer.cache to be classified as tooling artifact'
  );

  assert.ok(
    Array.isArray(result.changed_symbols) && result.changed_symbols.some(s => s.filePath === 'src/doThing.ts' && s.name === 'doThing'),
    'expected changed_symbols to include doThing()'
  );

  assert.ok(
    Array.isArray(result.suggested_tests) && result.suggested_tests.some(t => t.filePath === 'tests/doThing.test.ts'),
    'expected suggested_tests to include tests/doThing.test.ts'
  );
  const suggestedDoThingTest = result.suggested_tests.find(t => t.filePath === 'tests/doThing.test.ts');
  assert.ok(typeof suggestedDoThingTest?.command === 'string' && suggestedDoThingTest.command.length > 0);
  assert.ok(typeof suggestedDoThingTest?.cwd === 'string' && suggestedDoThingTest.cwd.length > 0);
  assert.ok(Array.isArray(result.test_commands), 'expected test_commands list');
  assert.ok(result.test_commands.some(t => typeof t?.command === 'string' && t.command.length > 0));
  const fooPageSuggestedTest = result.suggested_tests.find(t => t.filePath === 'apps/dashboard/src/pages/FooPage.test.ts');
  assert.ok(fooPageSuggestedTest, 'expected suggested_tests to include FooPage.test.ts');
  assert.equal(fooPageSuggestedTest.runner, 'vitest');
  assert.equal(fooPageSuggestedTest.cwd, 'apps/dashboard');
  assert.match(fooPageSuggestedTest.command, /^pnpm exec vitest run /);
  assert.ok(
    !String(fooPageSuggestedTest.command).startsWith('pnpm test'),
    'expected dashboard test command to avoid pnpm test'
  );
  assert.ok(Number(fooPageSuggestedTest?.ranking?.score || 0) > 0);
  assert.ok(Number(fooPageSuggestedTest?.ranking?.components?.base_score || 0) > 0);

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

  assert.ok(result.semantic_diffs, 'expected semantic_diffs payload');
  assert.ok(result.semantic_diffs.summary, 'expected semantic_diffs summary');
  assert.ok(Array.isArray(result.semantic_diffs.families), 'expected semantic_diffs families list');
  assert.ok(result.semantic_diffs.gap_signals, 'expected semantic_diffs gap_signals');
  assert.ok(Array.isArray(result.semantic_diffs.gap_signals.gaps), 'expected semantic_diffs gap_signals.gaps list');
  assert.equal(result.summary.semantic_families, result.semantic_diffs.summary.family_count);
  assert.equal(result.summary.semantic_gap_signals, result.semantic_diffs.summary.gap_signals);
  assert.ok(result.proof_pack, 'expected proof_pack payload');
  assert.ok(result.proof_pack.summary, 'expected proof_pack summary');
  assert.ok(Array.isArray(result.proof_pack.symbols), 'expected proof_pack symbols list');
  assert.ok(Array.isArray(result.proof_pack.edges), 'expected proof_pack edges list');
  assert.ok(
    result.proof_pack.symbols.some(item => item?.symbol?.filePath === 'src/doThing.ts'),
    'expected proof_pack symbols to include src/doThing.ts'
  );
  assert.equal(result.summary.proof_symbols, result.proof_pack.summary.symbol_spans);
  assert.equal(result.summary.proof_edges, result.proof_pack.summary.edge_spans);
  assert.ok(result.slice_stencil, 'expected slice_stencil payload');
  assert.ok(result.slice_stencil.summary, 'expected slice_stencil summary');
  assert.ok(Array.isArray(result.slice_stencil.slices), 'expected slice_stencil slices list');
  assert.equal(result.summary.stencil_slices, result.slice_stencil.summary.changed_slices);
  assert.equal(result.summary.stencil_templates, result.slice_stencil.summary.with_templates);
  assert.ok(result.review_kernel, 'expected review_kernel payload');
  assert.ok(result.review_kernel.risk, 'expected review_kernel risk section');
  assert.ok(Array.isArray(result.review_kernel.top_findings), 'expected review_kernel top_findings list');
  assert.ok(Array.isArray(result.review_kernel.findings), 'expected review_kernel findings list');
  assert.ok(
    result.review_kernel.findings.every(f => typeof f.reason === 'string' && Number.isFinite(Number(f.confidence))),
    'expected review findings to include reason + confidence'
  );
  assert.ok(Array.isArray(result.runtime_hotspots), 'expected runtime_hotspots payload');
  assert.ok(result.runtime_hotspots.length > 0, 'expected runtime hotspot overlap for changed files');
  assert.ok(Number(result.summary?.runtime_hotspots || 0) >= 1, 'expected summary.runtime_hotspots >= 1');
  assert.ok(result.runtime_evidence, 'expected runtime_evidence payload');
  assert.equal(result.runtime_evidence.focus_route, '/seating_groups/assign');
  assert.ok(Array.isArray(result.runtime_evidence.routes), 'expected runtime_evidence.routes list');
  assert.ok(Array.isArray(result.runtime_evidence.focus_routes), 'expected runtime_evidence.focus_routes list');
  assert.ok(result.runtime_evidence.focus_routes.length >= 1, 'expected focused route runtime evidence');
  const focusedRoutes = result.runtime_evidence.focus_routes.filter(item => String(item?.route || '').includes('/seating_groups/assign'));
  assert.ok(focusedRoutes.length >= 1, 'expected focused route list to include seating assign');
  assert.ok(
    focusedRoutes.some(item => Number(item?.request_latency_ms?.avg || 0) >= 1000),
    'expected focused route metrics to retain request latency evidence'
  );
  assert.ok(
    focusedRoutes.some(item => Number(item?.sql?.count || 0) >= 8 && Number(item?.sql?.lock_wait_ms || 0) >= 100),
    'expected focused route metrics to retain SQL/lock evidence'
  );
  assert.ok(Number(result.summary?.runtime_evidence_routes || 0) >= 1);
  assert.ok(Number(result.summary?.runtime_focus_routes || 0) >= 1);
  assert.ok(
    result.review_kernel.findings.some(f => String(f.code || '').startsWith('runtime-')),
    'expected runtime hotspots to feed review findings',
  );
  assert.ok(
    result.review_kernel.findings.some(f => String(f.code || '') === 'runtime-focus-route'),
    'expected focused runtime route finding'
  );
  assert.ok(Array.isArray(result.contract_parity), 'expected contract_parity payload');
  assert.ok(result.contract_parity.length >= 1, 'expected at least one parity entry');
  const assignParity = result.contract_parity.find(item => String(item?.pattern || '').includes('/seating_groups/assign'));
  assert.ok(assignParity, 'expected contract_parity to include seating assign route');
  assert.ok(Number(assignParity?.parity_score || 0) <= 0.65, 'expected low parity score for runtime-only route evidence');
  assert.ok(Number(result.summary?.contract_parity_routes || 0) >= 1);
  assert.ok(Number(result.summary?.contract_parity_low || 0) >= 1);
  assert.ok(Array.isArray(result.perf_backend_findings), 'expected perf_backend_findings payload');
  assert.ok(
    result.perf_backend_findings.some(item => item.filePath === 'app/PerfLoop.php' && item.code === 'perf-repeated-linear-scan'),
    'expected repeated scan perf finding'
  );
  assert.ok(
    result.perf_backend_findings.some(item => item.filePath === 'app/PerfLoop.php' && item.code === 'perf-write-amplification'),
    'expected write amplification perf finding'
  );
  assert.ok(
    result.perf_backend_findings.some(item => item.filePath === 'app/PerfLoop.php' && item.code === 'perf-noop-write'),
    'expected no-op write perf finding'
  );
  assert.ok(Number(result.summary?.perf_backend_findings || 0) >= 3);
  assert.ok(
    result.review_kernel.findings.some(f => String(f.code || '').startsWith('perf-')),
    'expected perf_backend_findings to feed review findings'
  );
  assert.ok(result.test_intelligence, 'expected test_intelligence payload');
  assert.equal(result.test_intelligence.mode, 'changed-vs-baseline-heuristic');
  assert.ok(Array.isArray(result.test_intelligence.changed_test_files));
  assert.ok(
    result.test_intelligence.changed_test_files.every(filePath => String(filePath).includes('.test.') || String(filePath).includes('.spec.')),
    'expected changed_test_files to include only test-like paths'
  );
  assert.ok(Array.isArray(result.test_intelligence.regression_failure_candidates));
  assert.ok(Array.isArray(result.test_intelligence.preexisting_failure_candidates));
  assert.ok(
    result.test_intelligence.regression_failure_candidates.includes('apps/dashboard/src/pages/FooPage.test.ts'),
    'expected FooPage.test.ts in regression candidates'
  );
  assert.equal(result.summary.regression_failure_candidates, result.test_intelligence.regression_failure_candidates.length);
  assert.equal(result.summary.preexisting_failure_candidates, result.test_intelligence.preexisting_failure_candidates.length);
  assert.ok(Array.isArray(result.review_kernel.hypotheses), 'expected review_kernel hypotheses list');
  assert.ok(Array.isArray(result.review_kernel.next_actions), 'expected review_kernel next_actions list');
  assert.ok(result.review_kernel.next_actions.some(step => String(step).includes('impact()')));
  assert.ok(result.coverage_banner, 'expected coverage_banner payload');
  assert.ok(result.coverage_banner.freshness, 'expected coverage_banner freshness section');
  assert.ok(result.coverage_banner.coverage, 'expected coverage_banner coverage section');
  assert.equal(result.coverage_banner.coverage.untracked_files, result.summary.untracked_files);
  assert.equal(result.coverage_banner.coverage.untracked_artifacts, result.summary.untracked_artifacts);
  assert.equal(result.summary.suggested_test_commands, result.test_commands.length);
  assert.equal(result._review_mode?.knobs?.include_evidence_spans, true);
  assert.equal(result._review_mode?.knobs?.include_slice_stencil, true);
  assert.ok((result._review_mode?.convergence?.ranking_weights?.suggested_tests?.convergence_score || 0) > 0);
  assert.ok((result._review_mode?.convergence?.ranking_weights?.findings?.severity || 0) > 0);

  const noStencil = runTool('review_mode', { repo: repoPath, scope: 'unstaged', include_slice_stencil: false }, env);
  assert.equal(noStencil.status, 'ok');
  assert.ok(Array.isArray(noStencil.slice_stencil?.slices), 'expected disabled review_mode to keep slice_stencil shape');
  assert.equal(noStencil.slice_stencil.slices.length, 0);
  assert.equal(noStencil.summary.stencil_slices, 0);

  // Scoped mode should drop FooPage.tsx
  const scoped = runTool('review_mode', { repo: repoPath, scope: 'unstaged', path_prefixes: ['src/'] }, env);
  assert.equal(scoped.status, 'ok');
  assert.ok(scoped.changed_files.every(f => String(f.filePath || '').startsWith('src/')));
  assert.ok(!scoped.changed_files.some(f => f.filePath === 'apps/dashboard/src/pages/FooPage.tsx'));
  assert.ok(scoped.semantic_diffs, 'expected scoped semantic_diffs payload');
});

test('MCP review_mode: falls back when direct test callers are missing', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-review-mode-fallback-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'tests'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'src/config.ts'),
    [
      'export class AppConfig {',
      "  static version = 'v1';",
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'tests/config.test.ts'),
    [
      "import { AppConfig } from '../src/config';",
      '',
      'void AppConfig;',
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

  await fs.writeFile(
    path.join(repoPath, 'src/config.ts'),
    [
      'export class AppConfig {',
      "  static version = 'v2';",
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  const output2 = runAnalyze(repoPath, env);
  assert.match(output2, /Repository (indexed successfully|updated incrementally)/i);

  const result = runTool('review_mode', { repo: repoPath, scope: 'unstaged', min_confidence: 0.95, limit_tests: 25 }, env);
  assert.equal(result.status, 'ok');
  assert.ok(Array.isArray(result.changed_files) && result.changed_files.some(f => f.filePath === 'src/config.ts'));
  assert.ok(Number(result.summary?.changed_symbols || 0) >= 1, 'expected changed symbols for src/config.ts');
  assert.ok(
    (result.symbols || []).every(card => Array.isArray(card?.test_callers) && card.test_callers.length === 0),
    'expected no direct high-confidence test callers'
  );
  assert.ok(
    Array.isArray(result.suggested_tests) && result.suggested_tests.some(t => t.filePath === 'tests/config.test.ts'),
    'expected fallback suggested_tests to include tests/config.test.ts'
  );
  assert.ok(
    result.suggested_tests
      .flatMap(t => Array.isArray(t?.reasons) ? t.reasons : [])
      .some(reason => String(reason).includes('low-confidence caller') || String(reason).includes('imports changed file')),
    'expected fallback reason metadata to be populated'
  );
});

test('MCP review_mode: reports tooling artifacts without product diffs', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-review-mode-artifacts-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, 'src/noop.ts'),
    [
      'export const noop = 1;',
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
    path.join(repoPath, '.php-cs-fixer.cache'),
    '{"php":"8.3","rules":[]}',
    'utf-8'
  );

  const result = runTool('review_mode', { repo: repoPath, scope: 'unstaged' }, env);
  assert.equal(result.status, 'ok');
  assert.equal(Number(result.summary?.changed_files || 0), 0);
  assert.equal(Array.isArray(result.changed_files) ? result.changed_files.length : -1, 0);
  assert.equal(Array.isArray(result.untracked_files) ? result.untracked_files.length : -1, 0);
  assert.ok(Number(result.summary?.untracked_artifacts || 0) >= 1, 'expected summary.untracked_artifacts >= 1');
  assert.ok(Array.isArray(result.untracked_artifacts), 'expected untracked_artifacts list');
  assert.ok(
    result.untracked_artifacts.some(item => item.filePath === '.php-cs-fixer.cache'),
    'expected .php-cs-fixer.cache artifact entry'
  );
  assert.ok(result.review_kernel, 'expected review_kernel payload');
  assert.ok(
    Array.isArray(result.review_kernel.findings)
      && result.review_kernel.findings.some(f => String(f.code || '') === 'tooling-artifact'),
    'expected tooling artifact finding in review kernel'
  );
  assert.ok(result.coverage_banner, 'expected coverage_banner payload');
  assert.equal(result.coverage_banner.coverage.untracked_artifacts, result.summary.untracked_artifacts);
});

test('MCP review_mode: compare scope falls back to all when compare is empty', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-review-mode-compare-fallback-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'tests'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'src/toggle.ts'),
    [
      'export const getToggle = (): boolean => true;',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'tests/toggle.test.ts'),
    [
      "import { getToggle } from '../src/toggle';",
      '',
      'void getToggle;',
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

  await fs.writeFile(
    path.join(repoPath, 'src/toggle.ts'),
    [
      'export const getToggle = (): boolean => false;',
      '',
    ].join('\n'),
    'utf-8'
  );

  const output2 = runAnalyze(repoPath, env);
  assert.match(output2, /Repository (indexed successfully|updated incrementally)/i);

  const result = runTool('review_mode', { repo: repoPath, scope: 'compare', base_ref: 'HEAD', limit_tests: 25 }, env);
  assert.equal(result.status, 'ok');
  assert.ok(Array.isArray(result.changed_files) && result.changed_files.some(f => f.filePath === 'src/toggle.ts'));
  assert.equal(result._review_mode?.diff?.requested_scope, 'compare');
  assert.equal(result._review_mode?.diff?.effective_scope, 'all');
  assert.equal(result._review_mode?.diff?.fallback_applied, true);
  assert.equal(result._review_mode?.diff?.source, 'compare-empty->all');
});
