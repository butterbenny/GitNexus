import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ANALYZE_READY_RE = /Repository (indexed successfully|updated incrementally)|Already up to date/i;

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

test('MCP ui_contract: extracts interaction→side-effect contract and endpoint hops', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-ui-contract-'));
  const repoPath = await fs.mkdtemp(path.join(process.cwd(), 'testdata-ui-contract-'));

  try {
    await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/api'), { recursive: true });
    await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/customHooks'), { recursive: true });
    await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/pages'), { recursive: true });
    await fs.mkdir(path.join(repoPath, 'apps/backend/routes'), { recursive: true });
    await fs.mkdir(path.join(repoPath, 'apps/backend/app/Providers'), { recursive: true });
    await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Notifications'), { recursive: true });

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
      path.join(repoPath, 'apps/dashboard/src/pages/NotificationsPage.tsx'),
      [
        "import { useState } from 'react';",
        "import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';",
        "import { useNavigate } from 'react-router-dom';",
        "import { fetchAccountNotifications } from '../api/notifications';",
        '',
        "const toast = { success: (_msg: string) => {} };",
        '',
        'export const NotificationsPage = () => {',
        '  const [open, setOpen] = useState(false);',
        '  const queryClient = useQueryClient();',
        '  const navigate = useNavigate();',
        '',
        '  useQuery({',
        "    queryKey: ['notifications', 123],",
        '    queryFn: () => fetchAccountNotifications(123),',
        '    staleTime: 0,',
        '    refetchOnWindowFocus: true,',
        '  });',
        '',
        '  const { mutate: saveNotifications, isPending } = useMutation({',
        '    mutationFn: () => fetchAccountNotifications(123),',
        '    onSuccess: () => {',
        "      queryClient.invalidateQueries({ queryKey: ['notifications'] });",
        "      queryClient.setQueryData(['notifications', 123], () => []);",
        "      toast.success('Saved');",
        "      navigate('/done');",
        '      setOpen(false);',
        '    },',
        '  });',
        '',
        '  const runSave = () => saveNotifications();',
        '  const onSave = () => runSave();',
        '',
        '  return (',
        '    <Dialog open={open} onOpenChange={setOpen}>',
        '      <button disabled={isPending} onClick={onSave}>Save</button>',
        '    </Dialog>',
        '  );',
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

    const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
    const output = runAnalyze(repoPath, env);
    assert.match(output, ANALYZE_READY_RE);

    const result = runTool('ui_contract', { repo: repoPath, file_path: 'apps/dashboard/src/pages/NotificationsPage.tsx' }, env);
    assert.equal(result.status, 'ok');
    assert.equal(result.file_path, 'apps/dashboard/src/pages/NotificationsPage.tsx');

    const contract = result.contract;
    assert.ok(Array.isArray(contract.controlled));
    assert.ok(contract.controlled.length > 0);
    assert.ok(Array.isArray(contract.queries));
    assert.ok(contract.queries.some(q => q.hook === 'useQuery' && String(q.refetchOnWindowFocus || '') === 'true'));
    assert.ok(Array.isArray(contract.cacheLinks));

    const notificationsQuery = contract.queries.find(q => String(q.queryKey || '').includes('notifications') && String(q.queryKey || '').includes('123'));
    assert.ok(notificationsQuery);
    assert.ok(Array.isArray(notificationsQuery.refetchTriggers));
    assert.ok((notificationsQuery.refetchTriggers || []).some(t => t.method === 'invalidateQueries' && String(t.queryKey || '').includes('notifications') && t.match === 'prefix'));
    assert.ok(Array.isArray(notificationsQuery.cacheWriteTriggers));
    assert.ok((notificationsQuery.cacheWriteTriggers || []).some(t => t.method === 'setQueryData' && String(t.queryKey || '').includes('notifications') && String(t.queryKey || '').includes('123') && t.match === 'exact'));

    const invalidation = contract.cacheLinks.find(l => l?.operation?.method === 'invalidateQueries' && String(l?.operation?.queryKey || '').includes('notifications'));
    assert.ok(invalidation);
    assert.ok((invalidation.matches || []).some(m => String(m.queryKey || '').includes('notifications') && m.match === 'prefix'));
    const write = contract.cacheLinks.find(l => l?.operation?.method === 'setQueryData' && String(l?.operation?.queryKey || '').includes('notifications'));
    assert.ok(write);
    assert.ok((write.matches || []).some(m => String(m.queryKey || '').includes('notifications') && m.match === 'exact'));

    const click = contract.interactions.find(i => i.event === 'onClick');
    assert.ok(click);
    assert.ok(Array.isArray(click.gates));
    assert.ok(click.gates.some(g => g.attribute === 'disabled' && String(g.value || '').includes('isPending')));

    const kinds = new Set((click.effects || []).map(e => e.kind));
    assert.ok(kinds.has('mutation'));
    assert.ok(kinds.has('invalidate'));
    assert.ok(kinds.has('toast'));
    assert.ok(kinds.has('navigate'));
    assert.ok(kinds.has('state-update'));

    const smellKinds = new Set((click.smells || []).map(s => s.kind));
    assert.ok(!smellKinds.has('mutation-without-invalidation'));
    assert.ok(!smellKinds.has('mutation-without-pending-ux'));

    const endpoint = (result.endpoints || []).find(e => e?.http?.reason === 'http-get:/api/accounts/*/notifications');
    assert.ok(endpoint);
    assert.ok(String(endpoint.controller?.name || '').includes('NotificationController::index'));

    const openChange = contract.interactions.find(i => i.event === 'onOpenChange');
    assert.ok(openChange);
    const openChangeKinds = new Set((openChange.effects || []).map(e => e.kind));
    assert.ok(openChangeKinds.has('state-update'));
  } finally {
    if (repoPath.startsWith(process.cwd())) {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  }
});

test('MCP ui_contract: base_ref diff is stable when unchanged', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-ui-contract-diff-'));

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
  const output = runAnalyze(process.cwd(), env);
  assert.match(output, ANALYZE_READY_RE);

  const result = runTool('ui_contract', { repo: process.cwd(), file_path: 'src/core/derived/archetypes.ts', base_ref: 'HEAD', include_endpoints: false }, env);
  assert.equal(result.status, 'ok');
  assert.ok(result.diff);
  assert.deepEqual(result.diff.interactions_added, []);
  assert.deepEqual(result.diff.interactions_removed, []);
  assert.deepEqual(result.diff.controlled_added, []);
  assert.deepEqual(result.diff.controlled_removed, []);
  assert.deepEqual(result.diff.queries_added, []);
  assert.deepEqual(result.diff.queries_removed, []);
  assert.deepEqual(result.diff.interaction_effects_diff, []);
});
