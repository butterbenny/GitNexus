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

test('precedents: returns exemplar processes with the same flow signature', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-precedents-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/api'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/customHooks'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/routes'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Providers'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Notifications'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Messages'), { recursive: true });

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
    path.join(repoPath, 'apps/dashboard/src/api/messages.ts'),
    [
      "import Axios from 'axios';",
      '',
      'export const fetchAccountMessages = (accountId: number) => {',
      '  return Axios.get(`/accounts/${accountId}/messages`);',
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
      "Route::get('accounts/{account}/notifications', 'API\\\\Notifications\\\\NotificationController@index');",
      "Route::get('accounts/{account}/messages', 'API\\\\Messages\\\\MessageController@index');",
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
      'class NotificationController',
      '{',
      '    public function index(): array',
      '    {',
      '        return [];',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Messages/MessageController.php'),
    [
      '<?php',
      '',
      'namespace App\\Http\\Controllers\\Dashboard\\API\\Messages;',
      '',
      'class MessageController',
      '{',
      '    public function index(): array',
      '    {',
      '        return [];',
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
  const output = runAnalyze(repoPath, env);
  assert.match(output, /Repository indexed successfully/i);

  const result = runTool('precedents', { query: 'fetchAccountNotifications', limit: 1, examples: 3 }, env);
  assert.equal(result.status, 'ok');
  assert.ok(Array.isArray(result.precedents));
  assert.ok(result.precedents.length > 0);

  const p0 = result.precedents.find(p => p?.kind === 'process');
  assert.ok(p0);
  assert.ok(typeof p0.signature === 'string' && p0.signature.length > 0);
  assert.ok(p0.signature.includes('HTTP:GET'));
  assert.ok(p0.anchor?.label);
  assert.ok(Array.isArray(p0.examples));

  // With two similar endpoints, we should find a non-identical exemplar process.
  const exampleTerminalPaths = p0.examples.map(e => String(e.terminal?.filePath || ''));
  assert.ok(exampleTerminalPaths.some(fp => fp.includes('MessageController.php')));
});
