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

test('precedents: hop-based fallback works even when anchor is not in any Process', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-precedents-hop-fallback-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/api'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/customHooks'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/routes'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Providers'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Charges'), { recursive: true });

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

  // Put these in *.test.ts so they are excluded from Process entry-point detection,
  // but still have deterministic http-* wiring edges.
  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/api/charge-account.test.ts'),
    [
      "import Axios from 'axios';",
      '',
      'export const chargeAccount = (accountId: number) => {',
      '  return Axios.post(`/accounts/${accountId}/charge`);',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/api/charge-campaign.test.ts'),
    [
      "import Axios from 'axios';",
      '',
      'export const chargeCampaign = (campaignId: number) => {',
      '  return Axios.post(`/campaigns/${campaignId}/charge`);',
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
      "Route::post('accounts/{account}/charge', 'API\\\\Charges\\\\AccountChargeController@store');",
      "Route::post('campaigns/{campaign}/charge', 'API\\\\Charges\\\\CampaignChargeController@store');",
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Charges/AccountChargeController.php'),
    [
      '<?php',
      '',
      'namespace App\\Http\\Controllers\\Dashboard\\API\\Charges;',
      '',
      'class AccountChargeController',
      '{',
      '    public function store(): array',
      '    {',
      '        return [];',
      '    }',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Charges/CampaignChargeController.php'),
    [
      '<?php',
      '',
      'namespace App\\Http\\Controllers\\Dashboard\\API\\Charges;',
      '',
      'class CampaignChargeController',
      '{',
      '    public function store(): array',
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

  const result = runTool('precedents', { query: 'chargeAccount', limit: 1, examples: 3 }, env);
  assert.equal(result.status, 'ok');
  assert.ok(Array.isArray(result.precedents));
  assert.ok(result.precedents.length > 0);

  const hopPrec = result.precedents.find(p => p?.kind === 'hop');
  assert.ok(hopPrec);
  assert.ok(String(hopPrec.signature || '').includes('HTTP:POST'));
  assert.ok(hopPrec.anchor?.controller?.name);

  const exampleControllerPaths = (hopPrec.examples || []).map(e => String(e?.controller?.filePath || ''));
  assert.ok(exampleControllerPaths.some(fp => fp.includes('CampaignChargeController.php')));
});

