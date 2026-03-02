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

test('MCP query_mode: packages top slices, symbols, and action hints for focused exploration', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-query-mode-'));
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
      "    'roles' => [",
      "      'admin' => [",
      "        'permissions' => [",
      "          'account.view',",
      '        ],',
      '      ],',
      '    ],',
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

  const result = runTool('query_mode', {
    query: 'fetchAccountNotifications',
  }, env);

  assert.equal(result.status, 'ok');
  assert.ok(result.query_mode?.query_plan);
  assert.ok(Array.isArray(result.query_mode?.slices));
  assert.ok(result.query_mode.slices.length > 0);
  assert.ok(Array.isArray(result.query_mode?.symbols));
  assert.ok(result.query_mode.symbols.length > 0);
  assert.ok(result.query_mode.symbols.some(s => String(s?.name || '').includes('fetchAccountNotifications')));
  assert.ok(Array.isArray(result.query_mode?.action_hints?.hops));
  assert.ok(Array.isArray(result.query_mode?.next_actions));
  assert.ok(result.query_mode.next_actions.some(step => String(step).includes('review_mode')));
  assert.ok(result.query_mode?.carbon_copy_ready, 'expected carbon_copy_ready summary');
  assert.ok(typeof result.query_mode.carbon_copy_ready.score === 'number');
  assert.ok(Array.isArray(result.query_mode.carbon_copy_ready.reasons));
  assert.ok(
    result.query_mode.slices.every(slice => !slice?.carbon_copy_ready || typeof slice.carbon_copy_ready.score === 'number'),
    'expected optional per-slice carbon_copy_ready scores',
  );
  assert.ok(
    result.query_mode.processes.every(proc => !proc?.carbon_copy_ready || typeof proc.carbon_copy_ready.score === 'number'),
    'expected optional per-process carbon_copy_ready scores',
  );
  assert.ok(result._query_mode?.convergence?.top_carbon_copy || result.query_mode?.carbon_copy_ready);
  assert.ok((result._query_mode?.convergence?.next_action_ranking_weights?.score || 0) > 0);
  if (result._query_mode?.convergence?.prioritized_next_action?.action) {
    assert.equal(
      result._query_mode.convergence.prioritized_next_action.action,
      result.query_mode?.next_actions?.[0],
    );
  }
  assert.equal(result._query_mode?.knobs?.include_precedents, true);
  assert.equal(result._query_mode?.knobs?.include_action_hints, true);
});
