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

test('MCP debug_mode: ranks auth broken loop candidates using symptom + hop evidence', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-debug-mode-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/api'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/customHooks'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/routes'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Providers'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Notifications'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'app/Domains/AccessControl/Permissions'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'config'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/customHooks/useConfigureHttpClient.ts'),
    [
      "import Axios from 'axios';",
      '',
      'export const useConfigureHttpClient = () => {',
      "  const apiUrl = 'https://example.com';",
      '  Axios.defaults.baseURL = `${apiUrl}/api`;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/api/notifications.ts'),
    [
      "import Axios from 'axios';",
      '',
      'export const fetchAccountNotifications = (accountId: number) => {',
      '  return Axios.get(`/accounts/${accountId}/notifications`);',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Providers/RouteServiceProvider.php'),
    [
      '<?php',
      '',
      'namespace App\\Providers;',
      '',
      'use Illuminate\\Foundation\\Support\\Providers\\RouteServiceProvider as ServiceProvider;',
      'use Illuminate\\Support\\Facades\\Route;',
      '',
      'class RouteServiceProvider extends ServiceProvider',
      '{',
      "    protected $namespace = 'App\\\\Http\\\\Controllers';",
      '',
      '    public function map(): void',
      '    {',
      '        $this->mapDashboardRoutes();',
      '    }',
      '',
      '    protected function mapDashboardRoutes(): void',
      '    {',
      "        Route::prefix('api')",
      "            ->middleware('api')",
      "            ->namespace($this->namespace . '\\\\Dashboard')",
      "            ->group(base_path('routes/dashboard.php'));",
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/routes/dashboard.php'),
    [
      '<?php',
      '',
      'use Illuminate\\Support\\Facades\\Route;',
      '',
      "Route::apiResource('accounts.notifications', 'API\\\\Notifications\\\\NotificationController');",
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Notifications/NotificationController.php'),
    [
      '<?php',
      '',
      'namespace App\\Http\\Controllers\\Dashboard\\API\\Notifications;',
      '',
      'use App\\Domains\\AccessControl\\Permissions\\AccountPermission;',
      '',
      'class NotificationController',
      '{',
      '    public function index(): array',
      '    {',
      '        $this->authorize(AccountPermission::VIEW);',
      '        return [];',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'app/Domains/AccessControl/Permissions/AccountPermission.php'),
    [
      '<?php',
      '',
      'namespace App\\Domains\\AccessControl\\Permissions;',
      '',
      'enum AccountPermission: string',
      '{',
      "    case VIEW = 'account.view';",
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'config/permissions.php'),
    [
      '<?php',
      '',
      'return [',
      "    'roles' => [],",
      '];',
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
  assert.match(output, /Repository indexed successfully/i);

  const debug = runTool('debug_mode', {
    query: 'fetchAccountNotifications',
    symptom: '403 forbidden on notifications page',
    failing_tests: ['NotificationsApiTest::test_forbidden_without_permission'],
    runtime_observations: {
      request_spans: [
        { method: 'GET', route: '/api/accounts/42/notifications', duration_ms: 920, payload_bytes: 402120, status: 403 },
      ],
      db_queries: [
        {
          sql: 'select * from notifications where account_id = 42',
          duration_ms: 180,
          lock_wait_ms: 65,
          rows_examined: 12000,
          explain_plan: 'Using temporary; Using filesort',
        },
      ],
      payload_shapes: [
        { path: '/api/accounts/42/notifications', item_count: 240, bytes: 402120, keys: ['accounts', 'notifications'] },
      ],
    },
  }, env);

  assert.equal(debug.status, 'ok');
  assert.equal(debug.debug?.classification?.family, 'auth');
  assert.ok(Array.isArray(debug.debug?.anchors?.hops));
  assert.ok(debug.debug.anchors.hops.length > 0);
  assert.ok(Array.isArray(debug.debug?.candidates));
  assert.ok(debug.debug.candidates.length > 0);
  assert.ok(
    debug.debug.candidates.some(c =>
      Array.isArray(c?.findings) &&
      (c.findings.includes('no-role-grants') || c.findings.includes('missing-permission-closure'))
    ),
    'expected auth findings from debug candidates'
  );
  assert.ok(Array.isArray(debug.debug?.next_actions));
  assert.ok(debug.debug?.prioritized_candidate, 'expected prioritized_candidate payload');
  assert.equal(debug.debug.prioritized_candidate.source, 'converged');
  assert.ok(Number(debug.debug.prioritized_candidate.route_alignment || 0) > 0);
  assert.ok(Array.isArray(debug.debug.prioritized_candidate.findings));
  assert.ok(Array.isArray(debug.debug.prioritized_candidate.fix_recipe_ids));
  assert.ok(
    String(debug.debug.next_actions[0] || '').startsWith('Start with converged candidate'),
    'expected first next action to prioritize top converged candidate',
  );
  assert.equal(
    String(debug.debug.prioritized_candidate.next_action || ''),
    String(debug.debug.next_actions[0] || ''),
    'expected prioritized candidate next action to be first next_actions entry',
  );
  assert.ok(debug.debug.next_actions.some(step => String(step).includes('review_mode')));
  assert.ok(Array.isArray(debug.debug?.timeline), 'expected timeline output');
  assert.ok(debug.debug.timeline.length > 0, 'expected timeline steps');
  assert.ok(
    debug.debug.timeline.some(step => Number(step?.runtime_route_matches?.request_spans || 0) >= 1),
    'expected timeline to include runtime route match coverage',
  );
  assert.ok(Array.isArray(debug.debug?.coverage?.warnings), 'expected coverage warnings');
  assert.equal(debug.debug?.coverage?.runtime_observations, true, 'expected runtime observation coverage flag');
  assert.ok(
    Number(debug.debug?.coverage?.runtime_route_matches?.match_ratio || 0) > 0,
    'expected runtime route matcher coverage ratio to be reported',
  );
  assert.ok(
    Number(debug.debug?.coverage?.converged_candidates || 0) > 0,
    'expected converged candidate count from route-index coverage',
  );
  assert.ok(Array.isArray(debug.debug?.confidence_breakdown?.claims), 'expected confidence breakdown claims');
  assert.ok(
    debug.debug.candidates.some(c => Number(c?.route_alignment || 0) > 0),
    'expected ranked candidates to include non-zero route alignment',
  );
  assert.ok(
    debug.debug.candidates.every(c => Array.isArray(c?.fix_recipes)),
    'expected candidate fix recipes to be emitted',
  );
  assert.ok(
    debug.debug.candidates.some(c =>
      Array.isArray(c?.findings)
      && (
        c.findings.includes('slow-request-path')
        || c.findings.includes('slow-db-query')
        || c.findings.includes('lock-contention')
      )
    ),
    'expected runtime-derived findings in debug candidates',
  );
  assert.ok(
    debug.debug.candidates.some(c =>
      Array.isArray(c?.evidence?.matched_routes)
      && c.evidence.matched_routes.some(route => String(route?.pattern || '').includes('/api/accounts/*/notifications'))
    ),
    'expected runtime candidates to include matched route evidence from hop route index',
  );
  assert.equal(debug.debug?.verification_contract?.post_edit_review?.tool, 'review_mode');
  assert.equal(debug._debug_mode?.knobs?.include_precedents, true);
  assert.equal(debug._debug_mode?.knobs?.runtime_observations, true);
  assert.ok(Number(debug._debug_mode?.knobs?.route_converged_candidates || 0) > 0);
});

test('MCP debug_mode: auto-loads runtime observations from snapshot sidecar', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-debug-mode-runtime-snapshot-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, 'src/slowPath.ts'),
    [
      'export const slowPath = (items: number[]): number => {',
      '  let total = 0;',
      '  for (const item of items) {',
      '    total += items.find(v => v === item) ?? 0;',
      '  }',
      '  return total;',
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
  assert.match(output, /Repository indexed successfully/i);

  await fs.mkdir(path.join(repoPath, '.gitnexus'), { recursive: true });
  await fs.writeFile(
    path.join(repoPath, '.gitnexus/runtime-observations.json'),
    JSON.stringify({
      generatedAt: '2026-01-01T00:00:00.000Z',
      request_spans: [
        { method: 'POST', route: '/api/slow-path', duration_ms: 1450, payload_bytes: 620000, file_path_hints: ['src/slowPath.ts'] },
      ],
      db_queries: [
        {
          sql: 'select * from jobs where queue = ?',
          duration_ms: 260,
          lock_wait_ms: 90,
          rows_examined: 34000,
          file_path_hints: ['src/slowPath.ts'],
          explain_plan: 'Using temporary',
        },
      ],
      payload_shapes: [
        { path: '/api/slow-path', item_count: 500, bytes: 620000, keys: ['items'] },
      ],
    }, null, 2),
    'utf-8'
  );

  const debug = runTool('debug_mode', {
    query: 'slowPath',
    symptom: 'timeout while processing slow path',
  }, env);

  assert.equal(debug.status, 'ok');
  assert.equal(debug.debug?.coverage?.runtime_observations, true);
  assert.equal(debug.debug?.runtime_observations?.source, 'snapshot');
  assert.equal(debug._debug_mode?.knobs?.runtime_source, 'snapshot');
  assert.ok(
    Array.isArray(debug.debug?.candidates)
      && debug.debug.candidates.some(c => Array.isArray(c?.findings) && (
        c.findings.includes('slow-request-path')
        || c.findings.includes('slow-db-query')
        || c.findings.includes('lock-contention')
      )),
    'expected runtime snapshot findings in candidates',
  );
});
