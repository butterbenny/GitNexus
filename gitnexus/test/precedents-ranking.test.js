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

const setupNotificationsRepo = async (tmpRoot) => {
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/api'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/customHooks'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/routes'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Providers'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Notifications'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'apps/backend/app/Http/Controllers/Dashboard/API/Messages'), { recursive: true });
  await fs.mkdir(path.join(repoPath, '.agents/review'), { recursive: true });

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

  await fs.writeFile(
    path.join(repoPath, '.agents/review/pattern-catalog.md'),
    [
      '## API flows',
      '',
      '### Notification resource flow',
      'Template:',
      '`apps/dashboard/src/api/notifications.ts`',
      'Also good:',
      '`apps/dashboard/src/api/messages.ts`',
      '',
      '### CatalogOnlySentinel flow',
      'Template:',
      '`apps/dashboard/src/api/notifications.ts`',
      'Also good:',
      '`apps/dashboard/src/api/messages.ts`',
      'Notes:',
      '- Use ziggurat callback ladder when the submit stays thin and the follow-up mutation owns secondary failure semantics.',
      '',
    ].join('\n'),
    'utf-8'
  );

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['branch', '-M', 'main']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
  const output = runAnalyze(repoPath, env);
  assert.match(output, /Repository indexed successfully/i);

  return { repoPath, env };
};

const setupMutationFlowRepo = async (tmpRoot) => {
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/pages'), { recursive: true });
  await fs.mkdir(path.join(repoPath, '.agents/review'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/GenericSubmit.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const GenericSubmit = () => {',
      '  const { mutate: saveThing } = useMutation({',
      '    mutationFn: async () => null,',
      '  });',
      '',
      '  return (',
      '    <form onSubmit={handleSubmit(values => saveThing(values))}>',
      '      <button type="submit">Save</button>',
      '    </form>',
      '  );',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/ComplexSubmit.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const ComplexSubmit = () => {',
      '  const { mutate: linkThing } = useMutation({',
      '    mutationFn: async () => null,',
      '  });',
      '',
      '  const { mutate: createThing } = useMutation({',
      '    mutationFn: async () => null,',
      '    onSuccess: data => {',
      '      linkThing(data.id);',
      '    },',
      '  });',
      '',
      '  return (',
      '    <form onSubmit={handleSubmit(values => createThing(values))}>',
      '      <button type="submit">Save</button>',
      '    </form>',
      '  );',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/SequencedMutation.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const SequencedMutation = () => {',
      '  const { mutate: submitThing } = useMutation({',
      '    mutationFn: async values => {',
      '      await createThing(values);',
      '      await updateThing(values);',
      '      return null;',
      '    },',
      '  });',
      '',
      '  return <button onClick={() => submitThing({})}>Save</button>;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/SuccessBehavior.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const SuccessBehavior = () => {',
      '  const { mutate: saveThing } = useMutation({',
      '    mutationFn: async values => values,',
      '    onSuccess: data => {',
      '      queryClient.invalidateQueries({ queryKey: thingQueryKeys.list() });',
      '      queryClient.setQueryData(thingQueryKeys.detail(data.id), data);',
      "      toast.success('Saved');",
      "      navigate('/things');",
      '      setIsOpen(false);',
      '    },',
      '  });',
      '',
      '  return (',
      '    <Dialog.Root open={isOpen} onOpenChange={setIsOpen}>',
      '      <form onSubmit={handleSubmit(values => saveThing(values))}>',
      '        <button type="submit">Save</button>',
      '      </form>',
      '    </Dialog.Root>',
      '  );',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/OptimisticTableRowSuccess.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const OptimisticTableRowSuccess = () => {',
      '  const { mutate: saveRow } = useMutation({',
      '    mutationFn: async row => row,',
      '    onMutate: row => {',
      '      table.addRowPending(row.id);',
      '    },',
      '    onSettled: (_data, _error, row) => {',
      '      table.removeRowPending(row.id);',
      '    },',
      '    onSuccess: row => {',
      '      table.addRowReplacement({',
      '        rowId: row.id,',
      '        maxHeight: 100,',
      '        content: (',
      '          <TableRowSuccessState',
      '            successMessage={"Saved row"}',
      '            undoMutationFn={() => undoRow(row.id)}',
      '            invalidationKeys={[thingQueryKeys.list(filters), metricsQueryKeys.current(accountId)]}',
      '          />',
      '        ),',
      '      });',
      '    },',
      '  });',
      '',
      '  return <button onClick={() => saveRow({ id: rowId })}>Save</button>;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/PendingOnlyTableAction.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const PendingOnlyTableAction = () => {',
      '  const { mutate: ignoreRow } = useMutation({',
      '    mutationFn: async row => row,',
      '    onMutate: row => {',
      '      table.addRowPending(row.id);',
      '    },',
      '    onSuccess: () => {',
      '      queryClient.invalidateQueries({ queryKey: thingQueryKeys.list(filters) });',
      '      queryClient.invalidateQueries({ queryKey: metricsQueryKeys.current(accountId) });',
      '    },',
      '    onSettled: (_data, _error, row) => {',
      '      table.removeRowPending(row.id);',
      '    },',
      '  });',
      '',
      '  return <button onClick={() => ignoreRow({ id: rowId })}>Ignore</button>;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/SelectionPrefill.tsx'),
    [
      'export const SelectionPrefill = () => {',
      '  return (',
      '    <Select.Root',
      '      onValueChange={value => {',
      "        setValue('assignee_id', value);",
      "        setValue('assignee_label', `Assignee ${value}`);",
      '      }}',
      '    />',
      '  );',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/SelectionAsyncEnrichment.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const SelectionAsyncEnrichment = () => {',
      '  const { mutate: loadThing } = useMutation({',
      '    mutationFn: async selectedThingId => fetchThing(selectedThingId),',
      '    onSuccess: thing => {',
      "      setValue('thing_name', thing.name);",
      "      setValue('thing_email', thing.email);",
      '    },',
      '  });',
      '',
      '  return (',
      '    <Select.Root',
      '      onValueChange={value => {',
      "        resetField('secondaryThing');",
      "        setValue('staleSummary', {});",
      '        loadThing(value);',
      '      }}',
      '    />',
      '  );',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/SelectionEffectSync.tsx'),
    [
      "import { useEffect } from 'react';",
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const SelectionEffectSync = () => {',
      '  const { mutate: selectCampaign } = useMutation({',
      '    mutationFn: async selectedCampaignId => fetchCampaign(selectedCampaignId),',
      '    onSuccess: campaign => {',
      "      setValue('customFields', campaign.customFields);",
      '    },',
      '  });',
      '',
      '  useEffect(() => {',
      '    if (selectedCampaignId) {',
      '      selectCampaign(selectedCampaignId);',
      '    } else {',
      "      setValue('customFields', {});",
      "      resetField('selectedFund');",
      '    }',
      '  }, [selectedCampaignId, selectCampaign, setValue]);',
      '',
      '  return null;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/PendingControlledDialog.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const PendingControlledDialog = () => {',
      '  const [isOpen, setIsOpen] = useState(false);',
      '  const { mutate: submitThing, isPending } = useMutation({',
      '    mutationFn: async values => values,',
      '    onSuccess: () => {',
      '      setIsOpen(false);',
      '    },',
      '  });',
      '',
      '  return (',
      '    <Dialog.Root open={isOpen} onOpenChange={setIsOpen}>',
      '      <form onSubmit={handleSubmit(values => submitThing(values))}>',
      '        <Form.SubmitButton isSubmitting={isPending}>Save</Form.SubmitButton>',
      '      </form>',
      '    </Dialog.Root>',
      '  );',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/PendingUncontrolledAlertDialog.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const PendingUncontrolledAlertDialog = () => {',
      '  const { mutate: resumeSharing } = useMutation({',
      "    mutationFn: async () => updateThing({ status: 'active' }),",
      '    onSuccess: () => {',
      '      goBack();',
      '    },',
      '  });',
      '',
      '  return (',
      '    <AlertDialog.Root type="warning">',
      '      <AlertDialog.Action onClick={() => resumeSharing()}>',
      '        Resume',
      '      </AlertDialog.Action>',
      '    </AlertDialog.Root>',
      '  );',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/EnabledFollowUpQuery.tsx'),
    [
      "import { useQuery } from '@tanstack/react-query';",
      '',
      'export const EnabledFollowUpQuery = () => {',
      '  const { data } = useQuery({',
      '    queryKey: thingQueryKeys.detail(selectedThingId),',
      '    queryFn: () => fetchThing(selectedThingId),',
      '    enabled: !!selectedThingId,',
      '  });',
      '',
      '  return data;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/InteractiveRefetch.tsx'),
    [
      "import { keepPreviousData, useQuery } from '@tanstack/react-query';",
      '',
      'export const InteractiveRefetch = () => {',
      '  const { data } = useQuery({',
      '    queryKey: thingQueryKeys.list(filters),',
      '    queryFn: () => fetchThings(filters),',
      '    enabled: hasValidFilters,',
      '    placeholderData: keepPreviousData,',
      '  });',
      '',
      '  return data;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/SuspenseBoundarySurface.tsx'),
    [
      "import { useQuery, useSuspenseQuery } from '@tanstack/react-query';",
      '',
      'export const SuspenseBoundarySurface = () => {',
      '  const { data: thing } = useSuspenseQuery({',
      '    queryKey: thingQueryKeys.detail(thingId),',
      '    queryFn: () => fetchThing(thingId),',
      '  });',
      '',
      '  const { data: relatedThing } = useQuery({',
      '    queryKey: thingQueryKeys.related(selectedThingId),',
      '    queryFn: () => fetchRelatedThing(selectedThingId),',
      '    enabled: !!selectedThingId,',
      '  });',
      '',
      '  return [thing, relatedThing];',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/SuspenseOptionalGateOnly.tsx'),
    [
      "import { useSuspenseQuery } from '@tanstack/react-query';",
      '',
      'export const SuspenseOptionalGateOnly = () => {',
      '  const { data } = useSuspenseQuery({',
      "    queryKey: ['thing', selectedThingId],",
      '    queryFn: () => conditionallyFetchOrNull(() => fetchThing(selectedThingId), !!selectedThingId),',
      '  });',
      '',
      '  return data;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/SuspenseInteractiveRefetch.tsx'),
    [
      "import { useSuspenseQuery } from '@tanstack/react-query';",
      '',
      'export const SuspenseInteractiveRefetch = () => {',
      '  const { data } = useSuspenseQuery({',
      "    queryKey: ['things', filters],",
      '    queryFn: () => fetchThings(filters),',
      '  });',
      '',
      '  return data;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/FocusRefreshAfterExternalFlow.tsx'),
    [
      "import { useQuery } from '@tanstack/react-query';",
      '',
      'export const FocusRefreshAfterExternalFlow = () => {',
      '  const { data } = useQuery({',
      "    queryKey: ['wallet-status', accountId],",
      '    queryFn: () => fetchWalletStatus(accountId),',
      '    enabled: !!accountId,',
      "    refetchOnWindowFocus: 'always',",
      '  });',
      '',
      '  return data;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/PollingStatusRefresh.tsx'),
    [
      "import { useSuspenseQuery } from '@tanstack/react-query';",
      '',
      'export const PollingStatusRefresh = () => {',
      '  const { data } = useSuspenseQuery({',
      "    queryKey: ['bulk-action', pendingBulkActionId],",
      '    queryFn: () => fetchBulkAction(pendingBulkActionId),',
      "    refetchOnWindowFocus: 'always',",
      '    refetchInterval: pendingBulkActionId ? 2000 : undefined,',
      '  });',
      '',
      '  return data;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/SuspenseAlwaysFocusRefresh.tsx'),
    [
      "import { useSuspenseQuery } from '@tanstack/react-query';",
      '',
      'export const SuspenseAlwaysFocusRefresh = () => {',
      '  const { data } = useSuspenseQuery({',
      "    queryKey: ['workflow', workflowId],",
      '    queryFn: () => conditionallyFetchOrNull(() => fetchWorkflow(workflowId), !!workflowId),',
      "    refetchOnWindowFocus: 'always',",
      '  });',
      '',
      '  return data;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/OwnershipAlignedInvalidation.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const OwnershipAlignedInvalidation = () => {',
      '  const { mutate: saveEvent } = useMutation({',
      '    mutationFn: async values => values,',
      '    onSuccess: () => {',
      '      queryClient.invalidateQueries({ queryKey: eventQueryKeys.event(campaignId) });',
      '      queryClient.invalidateQueries({ queryKey: campaignQueryKeys.campaign(campaignId) });',
      '    },',
      '  });',
      '',
      '  return <button onClick={() => saveEvent({})}>Save</button>;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/FocusRefreshWithoutInvalidation.tsx'),
    [
      "import { useMutation, useQuery } from '@tanstack/react-query';",
      '',
      'export const FocusRefreshWithoutInvalidation = () => {',
      '  useQuery({',
      "    queryKey: ['account', accountId],",
      '    queryFn: () => fetchAccount(accountId),',
      "    refetchOnWindowFocus: 'always',",
      '  });',
      '',
      '  const { mutate: saveSettings } = useMutation({',
      '    mutationFn: async values => values,',
      '    onSuccess: () => {',
      "      toast.success('Saved');",
      '    },',
      '  });',
      '',
      '  return <button onClick={() => saveSettings({})}>Save</button>;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/CacheWritebackWithTargetedInvalidation.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const CacheWritebackWithTargetedInvalidation = () => {',
      '  const { mutate: saveTask } = useMutation({',
      '    mutationFn: async task => task,',
      '    onSuccess: task => {',
      '      queryClient.setQueryData(taskQueryKeys.detail(task.id), task);',
      '      queryClient.invalidateQueries({ queryKey: taskQueryKeys.list(accountId) });',
      '    },',
      '  });',
      '',
      '  return <button onClick={() => saveTask({ id: taskId })}>Save</button>;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/InvalidateOnlyMutationRefresh.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const InvalidateOnlyMutationRefresh = () => {',
      '  const { mutate: saveTask } = useMutation({',
      '    mutationFn: async task => task,',
      '    onSuccess: task => {',
      '      queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(task.id) });',
      '      queryClient.invalidateQueries({ queryKey: taskQueryKeys.list(accountId) });',
      '    },',
      '  });',
      '',
      '  return <button onClick={() => saveTask({ id: taskId })}>Save</button>;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/OptimisticRollbackAcrossProjections.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const OptimisticRollbackAcrossProjections = () => {',
      '  const { mutate: togglePinnedThing } = useMutation({',
      '    mutationFn: async thing => thing,',
      '    onMutate: thing => {',
      '      queryClient.setQueryData(accountQueryKeys.current(accountId), old => ({',
      '        ...old,',
      '        menu: {',
      '          ...old.menu,',
      "          pinned_things: old.menu.pinned_things.filter(item => item.id !== thing.id),",
      "          recent_things: old.menu.recent_things.map(item => item.id === thing.id ? { ...thing, is_pinned: !thing.is_pinned } : item),",
      '        },',
      '      }));',
      '      queryClient.setQueryData(thingQueryKeys.list(filters), old =>',
      "        orderBy(uniqBy(old.filter(item => item.id !== thing.id).concat([{ ...thing, is_pinned: !thing.is_pinned, position: 1 }]), 'id'), 'position', 'asc')",
      '      );',
      '      queryClient.setQueryData(thingQueryKeys.detail(thing.id), old => ({ ...old, is_pinned: !old.is_pinned }));',
      '      return { previousThing: thing };',
      '    },',
      '    onError: (error, thing) => {',
      '      queryClient.setQueryData(accountQueryKeys.current(accountId), old => ({',
      '        ...old,',
      '        menu: {',
      '          ...old.menu,',
      "          pinned_things: old.menu.pinned_things.map(item => item.id === thing.id ? thing : item),",
      "          recent_things: old.menu.recent_things.map(item => item.id === thing.id ? thing : item),",
      '        },',
      '      }));',
      '      queryClient.setQueryData(thingQueryKeys.list(filters), old =>',
      "        orderBy(uniqBy(old.map(item => item.id === thing.id ? thing : item), 'id'), 'position', 'asc')",
      '      );',
      '      queryClient.setQueryData(thingQueryKeys.detail(thing.id), thing);',
      '    },',
      '  });',
      '',
      '  return <button onClick={() => togglePinnedThing({ id: thingId })}>Toggle</button>;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/PartialRollbackDetailOnly.tsx'),
    [
      "import { useMutation } from '@tanstack/react-query';",
      '',
      'export const PartialRollbackDetailOnly = () => {',
      '  const { mutate: updateTaskStatus } = useMutation({',
      '    mutationFn: async task => task,',
      '    onMutate: task => {',
      '      queryClient.setQueryData(taskQueryKeys.detail(task.id), old => old);',
      '      queryClient.setQueryData(taskQueryKeys.list(filters), old =>',
      "        orderBy(uniqBy(old.filter(item => item.id !== task.id).concat([{ ...task, status: 'complete', position: 1 }]), 'id'), 'position', 'asc')",
      '      );',
      '      return { previousTask: task };',
      '    },',
      '    onError: (error, task) => {',
      '      queryClient.setQueryData(taskQueryKeys.detail(task.id), task);',
      '    },',
      '  });',
      '',
      '  return <button onClick={() => updateTaskStatus({ id: taskId })}>Update</button>;',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, '.agents/review/pattern-catalog.md'),
    [
      '## Submit flows',
      '',
      '### Generic mutation submit',
      'Template:',
      '`apps/dashboard/src/pages/GenericSubmit.tsx`',
      '',
      '### Advanced mutation submit',
      'Template:',
      '`apps/dashboard/src/pages/ComplexSubmit.tsx`',
      'Notes:',
      '- Use when primary mutation onSuccess triggers a second mutation with separate follow-up semantics.',
      '',
      '### Sequenced mutation submit',
      'Template:',
      '`apps/dashboard/src/pages/SequencedMutation.tsx`',
      'Notes:',
      '- Use when one mutationFn awaits create then update and both writes share a single success path.',
      '',
      '### Success behavior submit',
      'Template:',
      '`apps/dashboard/src/pages/SuccessBehavior.tsx`',
      'Notes:',
      '- Use when onSuccess closes the surface, shows a toast, navigates, and refreshes cache after save.',
      '',
      '### Optimistic table row success with undo',
      'Template:',
      '`apps/dashboard/src/pages/OptimisticTableRowSuccess.tsx`',
      'Notes:',
      '- Use when a table row stays pending during mutation, swaps into an inline success state, exposes undo, and defers canonical invalidation until the success state settles.',
      '',
      '### Pending-only table action',
      'Template:',
      '`apps/dashboard/src/pages/PendingOnlyTableAction.tsx`',
      'Notes:',
      '- Use for immediate table actions that only need temporary row pending plus direct invalidation; avoid when the query explicitly needs inline success state or undo before refetch.',
      '',
      '### Selection prefill flow',
      'Template:',
      '`apps/dashboard/src/pages/SelectionPrefill.tsx`',
      '',
      '### Selection async enrichment flow',
      'Template:',
      '`apps/dashboard/src/pages/SelectionAsyncEnrichment.tsx`',
      '',
      '### Selection effect sync flow',
      'Template:',
      '`apps/dashboard/src/pages/SelectionEffectSync.tsx`',
      '',
      '### Pending controlled dialog submit',
      'Template:',
      '`apps/dashboard/src/pages/PendingControlledDialog.tsx`',
      '',
      '### Pending uncontrolled alert dialog action',
      'Template:',
      '`apps/dashboard/src/pages/PendingUncontrolledAlertDialog.tsx`',
      '',
      '### Enabled-gated follow-up query',
      'Template:',
      '`apps/dashboard/src/pages/EnabledFollowUpQuery.tsx`',
      '',
      '### Interactive refetch without suspension',
      'Template:',
      '`apps/dashboard/src/pages/InteractiveRefetch.tsx`',
      '',
      '### Suspense boundary with optional non-suspense gate',
      'Template:',
      '`apps/dashboard/src/pages/SuspenseBoundarySurface.tsx`',
      '',
      '### Suspense optional gate only',
      'Template:',
      '`apps/dashboard/src/pages/SuspenseOptionalGateOnly.tsx`',
      '',
      '### Suspense interactive refetch',
      'Template:',
      '`apps/dashboard/src/pages/SuspenseInteractiveRefetch.tsx`',
      '',
      '### Focus refresh after external flow',
      'Template:',
      '`apps/dashboard/src/pages/FocusRefreshAfterExternalFlow.tsx`',
      '',
      '### Polling status refresh',
      'Template:',
      '`apps/dashboard/src/pages/PollingStatusRefresh.tsx`',
      '',
      '### Suspense always focus refresh',
      'Template:',
      '`apps/dashboard/src/pages/SuspenseAlwaysFocusRefresh.tsx`',
      '',
      '### Ownership-aligned invalidation after save',
      'Template:',
      '`apps/dashboard/src/pages/OwnershipAlignedInvalidation.tsx`',
      'Notes:',
      '- Use when save must invalidate both the parent summary and owned detail so route gating or tab visibility refreshes immediately.',
      '',
      '### Focus refresh without invalidation',
      'Template:',
      '`apps/dashboard/src/pages/FocusRefreshWithoutInvalidation.tsx`',
      '',
      '### Cache writeback with targeted invalidation',
      'Template:',
      '`apps/dashboard/src/pages/CacheWritebackWithTargetedInvalidation.tsx`',
      '',
      '### Invalidate-only mutation refresh',
      'Template:',
      '`apps/dashboard/src/pages/InvalidateOnlyMutationRefresh.tsx`',
      'Notes:',
      '- Avoid when the query explicitly contrasts invalidate-only broad invalidation against owned-detail writeback with setQueryData.',
      '',
      '### Optimistic rollback across projections',
      'Template:',
      '`apps/dashboard/src/pages/OptimisticRollbackAcrossProjections.tsx`',
      'Notes:',
      '- Use when onMutate reorders or removes items in filtered lists or derived projections and onError restores each optimistic projection explicitly.',
      '',
      '### Partial rollback detail only',
      'Template:',
      '`apps/dashboard/src/pages/PartialRollbackDetailOnly.tsx`',
      'Notes:',
      '- Avoid when onMutate rewrites filtered lists, ordering, or derived projections but onError restores only the detail cache.',
      '',
    ].join('\n'),
    'utf-8'
  );

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['branch', '-M', 'main']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
  const output = runAnalyze(repoPath, env);
  assert.match(output, /Repository indexed successfully|updated incrementally|Already up to date/i);

  return { repoPath, env };
};

test('precedents: ranks code-derived cards ahead of same-domain pattern catalog hits', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-precedents-ranking-'));
  const { repoPath, env } = await setupNotificationsRepo(tmpRoot);

  const result = runTool('precedents', { query: 'fetchAccountNotifications', limit: 3, examples: 3 }, env);
  assert.equal(result.status, 'ok');
  assert.ok(Array.isArray(result.precedents));
  assert.ok(result.precedents.length > 0);
  assert.notEqual(result.precedents[0]?.kind, 'pattern-catalog');

  const patternPrec = result.precedents.find(item => item?.kind === 'pattern-catalog');
  assert.ok(patternPrec);
  assert.equal(patternPrec.anchor?.filePath, 'apps/dashboard/src/api/messages.ts');
  assert.ok(![patternPrec.anchor?.filePath, ...(patternPrec.examples || []).map(example => example?.filePath)].includes('apps/dashboard/src/api/notifications.ts'));
  assert.ok((result.diagnostics?.precedent_filters?.same_domain_excluded || 0) >= 1);
});

test('precedents: excludes changed-file pattern-catalog examples', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-precedents-filtering-'));
  const { repoPath, env } = await setupNotificationsRepo(tmpRoot);

  await fs.appendFile(
    path.join(repoPath, 'apps/dashboard/src/api/messages.ts'),
    '\nexport const localWorkingTreeChange = true;\n',
    'utf-8'
  );

  const result = runTool('precedents', { query: 'CatalogOnlySentinel', limit: 3, examples: 3 }, env);
  assert.equal(result.status, 'ok');
  assert.ok(Array.isArray(result.precedents));
  const patternPrec = result.precedents.find(item => item?.kind === 'pattern-catalog');
  assert.ok(patternPrec);
  assert.ok(![patternPrec.anchor?.filePath, ...(patternPrec.examples || []).map(example => example?.filePath)].includes('apps/dashboard/src/api/messages.ts'));
  assert.ok((result.diagnostics?.precedent_filters?.changed_files_excluded || 0) >= 1);
});

test('precedents: matches pattern-catalog sections by note content', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-precedents-content-aware-'));
  const { env } = await setupNotificationsRepo(tmpRoot);

  const result = runTool('precedents', { query: 'ziggurat callback ladder', limit: 3, examples: 3 }, env);
  assert.equal(result.status, 'ok');
  assert.ok(Array.isArray(result.precedents));

  const patternPrec = result.precedents.find(item => item?.kind === 'pattern-catalog');
  assert.ok(patternPrec);
  assert.equal(patternPrec.anchor?.title, 'CatalogOnlySentinel flow');
});

test('precedents: boosts callback-handoff and mutation-fn sequencing over generic mutation submit matches', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-precedents-mutation-handoffs-'));
  const { env } = await setupMutationFlowRepo(tmpRoot);

  const callbackResult = runTool('precedents', { query: 'onSuccess second mutation', limit: 3, examples: 3 }, env);
  assert.equal(callbackResult.status, 'ok');
  assert.ok(Array.isArray(callbackResult.precedents));
  assert.ok(callbackResult.precedents.length > 0);
  assert.equal(callbackResult.precedents[0]?.kind, 'pattern-catalog');
  assert.equal(callbackResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/ComplexSubmit.tsx');
  assert.equal(callbackResult.precedents[0]?.ranking?.components?.mutation_handoff_matches, 1);

  const sequenceResult = runTool('precedents', { query: 'single mutation await create then update', limit: 3, examples: 3 }, env);
  assert.equal(sequenceResult.status, 'ok');
  assert.ok(Array.isArray(sequenceResult.precedents));
  assert.ok(sequenceResult.precedents.length > 0);
  assert.equal(sequenceResult.precedents[0]?.kind, 'pattern-catalog');
  assert.equal(sequenceResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/SequencedMutation.tsx');
  assert.equal(sequenceResult.precedents[0]?.ranking?.components?.ui_behavior_matches, 1);
  assert.equal(sequenceResult.precedents[0]?.ranking?.components?.mutation_handoff_matches, 1);
});

test('precedents: boosts broader ui behavior tags over generic submit shape', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-precedents-ui-behaviors-'));
  const { env } = await setupMutationFlowRepo(tmpRoot);

  const successResult = runTool('precedents', { query: 'success behavior invalidate setQueryData toast navigate close dialog', limit: 3, examples: 3 }, env);
  assert.equal(successResult.status, 'ok');
  assert.ok(Array.isArray(successResult.precedents));
  assert.ok(successResult.precedents.length > 0);
  assert.equal(successResult.precedents[0]?.kind, 'pattern-catalog');
  assert.equal(successResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/SuccessBehavior.tsx');
  assert.ok((successResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 3);

  const prefillResult = runTool('precedents', { query: 'selection prefill setValue onValueChange', limit: 3, examples: 3 }, env);
  assert.equal(prefillResult.status, 'ok');
  assert.ok(Array.isArray(prefillResult.precedents));
  assert.ok(prefillResult.precedents.length > 0);
  assert.equal(prefillResult.precedents[0]?.kind, 'pattern-catalog');
  assert.equal(prefillResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/SelectionPrefill.tsx');
  assert.equal(prefillResult.precedents[0]?.ranking?.components?.ui_behavior_matches, 1);

  const selectionAsyncResult = runTool('precedents', { query: 'selection async enrichment reset dependent fields after select', limit: 10, examples: 3 }, env);
  assert.equal(selectionAsyncResult.status, 'ok');
  assert.ok(Array.isArray(selectionAsyncResult.precedents));
  assert.ok(selectionAsyncResult.precedents.length > 0);
  assert.equal(selectionAsyncResult.precedents[0]?.kind, 'pattern-catalog');
  assert.equal(selectionAsyncResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/SelectionAsyncEnrichment.tsx');
  assert.ok((selectionAsyncResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 2);
  assert.equal(selectionAsyncResult.precedents[0]?.ranking?.components?.ui_behavior_penalty || 0, 0);

  const pendingResult = runTool('precedents', { query: 'stay open while pending onOpenChange disable close', limit: 3, examples: 3 }, env);
  assert.equal(pendingResult.status, 'ok');
  assert.ok(Array.isArray(pendingResult.precedents));
  assert.ok(pendingResult.precedents.length > 0);
  assert.equal(pendingResult.precedents[0]?.kind, 'pattern-catalog');
  assert.equal(pendingResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/PendingControlledDialog.tsx');
  assert.ok((pendingResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 2);

  const pendingDriftResult = runTool('precedents', { query: 'stay open while pending controlled dialog onOpenChange disable close avoid duplicate click alertdialog action', limit: 10, examples: 3 }, env);
  assert.equal(pendingDriftResult.status, 'ok');
  assert.ok(Array.isArray(pendingDriftResult.precedents));
  assert.ok(pendingDriftResult.precedents.length > 0);
  assert.equal(pendingDriftResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/PendingControlledDialog.tsx');
  assert.equal(pendingDriftResult.precedents[0]?.ranking?.components?.ui_behavior_penalty || 0, 0);
  const pendingUncontrolledPrec = pendingDriftResult.precedents.find(item => item?.anchor?.filePath === 'apps/dashboard/src/pages/PendingUncontrolledAlertDialog.tsx');
  assert.ok(pendingUncontrolledPrec);
  assert.ok((pendingUncontrolledPrec?.ranking?.components?.ui_behavior_penalty || 0) >= 0.45);
  assert.ok((pendingUncontrolledPrec?.ranking?.components?.ui_behavior_smells || 0) >= 2);
  assert.ok((pendingUncontrolledPrec?.ranking?.components?.pending_ux_penalty || 0) >= 0.45);
  assert.ok((pendingUncontrolledPrec?.ranking?.components?.pending_ux_smells || 0) >= 2);

  const tableInlineSuccessResult = runTool('precedents', { query: 'row pending row replacement inline success undo before refetch delayed invalidation paginated table', limit: 10, examples: 3 }, env);
  assert.equal(tableInlineSuccessResult.status, 'ok');
  assert.ok(Array.isArray(tableInlineSuccessResult.precedents));
  assert.ok(tableInlineSuccessResult.precedents.length > 0);
  assert.equal(tableInlineSuccessResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/OptimisticTableRowSuccess.tsx');
  assert.ok((tableInlineSuccessResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 3);

  const tablePendingOnlyPrec = tableInlineSuccessResult.precedents.find(item => item?.anchor?.filePath === 'apps/dashboard/src/pages/PendingOnlyTableAction.tsx');
  assert.ok(tablePendingOnlyPrec);
  assert.ok((tablePendingOnlyPrec?.ranking?.components?.table_inline_success_penalty || 0) >= 0.28);
  assert.ok((tablePendingOnlyPrec?.ranking?.components?.table_inline_success_flags || 0) >= 1);

  const enabledQueryResult = runTool('precedents', { query: 'enabled follow-up query optional gate avoid suspense', limit: 3, examples: 3 }, env);
  assert.equal(enabledQueryResult.status, 'ok');
  assert.ok(Array.isArray(enabledQueryResult.precedents));
  assert.ok(enabledQueryResult.precedents.length > 0);
  assert.equal(enabledQueryResult.precedents[0]?.kind, 'pattern-catalog');
  assert.equal(enabledQueryResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/EnabledFollowUpQuery.tsx');
  assert.ok((enabledQueryResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 2);

  const selectionQueryResult = runTool('precedents', { query: 'selected thing follow-up query fetch details after selection', limit: 3, examples: 3 }, env);
  assert.equal(selectionQueryResult.status, 'ok');
  assert.ok(Array.isArray(selectionQueryResult.precedents));
  assert.ok(selectionQueryResult.precedents.length > 0);
  assert.equal(selectionQueryResult.precedents[0]?.kind, 'pattern-catalog');
  assert.equal(selectionQueryResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/EnabledFollowUpQuery.tsx');
  assert.ok((selectionQueryResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 1);

  const avoidEffectResult = runTool('precedents', { query: 'avoid useEffect selection sync for selected campaign custom fields', limit: 3, examples: 3 }, env);
  assert.equal(avoidEffectResult.status, 'ok');
  assert.ok(Array.isArray(avoidEffectResult.precedents));
  assert.ok(avoidEffectResult.precedents.length > 0);
  const avoidEffectSyncPrec = avoidEffectResult.precedents.find(item => item?.anchor?.filePath === 'apps/dashboard/src/pages/SelectionEffectSync.tsx');
  assert.ok(avoidEffectSyncPrec);
  assert.ok((avoidEffectSyncPrec?.ranking?.components?.ui_behavior_penalty || 0) >= 0.45);

  const suspenseBoundaryResult = runTool('precedents', { query: 'useSuspenseQuery optional gate should not suspend drawer fallback', limit: 3, examples: 3 }, env);
  assert.equal(suspenseBoundaryResult.status, 'ok');
  assert.ok(Array.isArray(suspenseBoundaryResult.precedents));
  assert.ok(suspenseBoundaryResult.precedents.length > 0);
  assert.equal(suspenseBoundaryResult.precedents[0]?.kind, 'pattern-catalog');
  assert.equal(suspenseBoundaryResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/SuspenseBoundarySurface.tsx');
  assert.ok((suspenseBoundaryResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 2);
  const suspenseOptionalGatePrec = suspenseBoundaryResult.precedents.find(item => item?.anchor?.filePath === 'apps/dashboard/src/pages/SuspenseOptionalGateOnly.tsx');
  assert.ok(suspenseOptionalGatePrec);
  assert.ok((suspenseOptionalGatePrec?.ranking?.components?.suspense_drift_penalty || 0) >= 0.3);
  assert.ok((suspenseOptionalGatePrec?.ranking?.components?.suspense_drift_flags || 0) >= 1);

  const interactiveRefetchResult = runTool('precedents', { query: 'background refetch keep current surface avoid fallback flash keepPreviousData', limit: 10, examples: 3 }, env);
  assert.equal(interactiveRefetchResult.status, 'ok');
  assert.ok(Array.isArray(interactiveRefetchResult.precedents));
  assert.ok(interactiveRefetchResult.precedents.length > 0);
  assert.equal(interactiveRefetchResult.precedents[0]?.kind, 'pattern-catalog');
  assert.equal(interactiveRefetchResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/InteractiveRefetch.tsx');
  assert.ok((interactiveRefetchResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 2);

  const suspenseRefetchDriftResult = runTool('precedents', { query: 'suspense interactive refetch avoid fallback flash', limit: 10, examples: 3 }, env);
  assert.equal(suspenseRefetchDriftResult.status, 'ok');
  assert.ok(Array.isArray(suspenseRefetchDriftResult.precedents));
  assert.ok(suspenseRefetchDriftResult.precedents.length > 0);
  const suspenseInteractiveRefetchPrec = suspenseRefetchDriftResult.precedents.find(item => item?.anchor?.filePath === 'apps/dashboard/src/pages/SuspenseInteractiveRefetch.tsx');
  assert.ok(suspenseInteractiveRefetchPrec);
  assert.ok((suspenseInteractiveRefetchPrec?.ranking?.components?.suspense_drift_penalty || 0) >= 0.35);
  assert.ok((suspenseInteractiveRefetchPrec?.ranking?.components?.suspense_drift_flags || 0) >= 1);

  const focusRefreshResult = runTool('precedents', { query: 'external flow foreground refresh return from browser wallet setup', limit: 10, examples: 3 }, env);
  assert.equal(focusRefreshResult.status, 'ok');
  assert.ok(Array.isArray(focusRefreshResult.precedents));
  assert.ok(focusRefreshResult.precedents.length > 0);
  assert.equal(focusRefreshResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/FocusRefreshAfterExternalFlow.tsx');
  assert.ok((focusRefreshResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 1);

  const pollingFreshnessResult = runTool('precedents', { query: 'polling status refresh refetch interval long-running progress', limit: 10, examples: 3 }, env);
  assert.equal(pollingFreshnessResult.status, 'ok');
  assert.ok(Array.isArray(pollingFreshnessResult.precedents));
  assert.ok(pollingFreshnessResult.precedents.length > 0);
  assert.equal(pollingFreshnessResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/PollingStatusRefresh.tsx');
  assert.ok((pollingFreshnessResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 1);

  const freshnessDriftResult = runTool('precedents', { query: 'background freshness avoid fallback flash refetchOnWindowFocus always', limit: 10, examples: 3 }, env);
  assert.equal(freshnessDriftResult.status, 'ok');
  assert.ok(Array.isArray(freshnessDriftResult.precedents));
  assert.ok(freshnessDriftResult.precedents.length > 0);
  const suspenseAlwaysFocusPrec = freshnessDriftResult.precedents.find(item => item?.anchor?.filePath === 'apps/dashboard/src/pages/SuspenseAlwaysFocusRefresh.tsx');
  assert.ok(suspenseAlwaysFocusPrec);
  assert.ok((suspenseAlwaysFocusPrec?.ranking?.components?.query_freshness_penalty || 0) >= 0.32);
  assert.ok((suspenseAlwaysFocusPrec?.ranking?.components?.query_freshness_flags || 0) >= 1);

  const ownershipInvalidationResult = runTool('precedents', { query: 'invalidate both parent summary and detail after save route gating tab visibility', limit: 10, examples: 3 }, env);
  assert.equal(ownershipInvalidationResult.status, 'ok');
  assert.ok(Array.isArray(ownershipInvalidationResult.precedents));
  assert.ok(ownershipInvalidationResult.precedents.length > 0);
  assert.equal(ownershipInvalidationResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/OwnershipAlignedInvalidation.tsx');
  assert.ok((ownershipInvalidationResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 2);

  const focusRelianceResult = runTool('precedents', { query: 'parent summary detail invalidation do not rely on focus refetch stale until refresh', limit: 10, examples: 3 }, env);
  assert.equal(focusRelianceResult.status, 'ok');
  assert.ok(Array.isArray(focusRelianceResult.precedents));
  assert.ok(focusRelianceResult.precedents.length > 0);
  const focusRefreshWithoutInvalidationPrec = focusRelianceResult.precedents.find(item => item?.anchor?.filePath === 'apps/dashboard/src/pages/FocusRefreshWithoutInvalidation.tsx');
  assert.ok(focusRefreshWithoutInvalidationPrec);
  assert.ok((focusRefreshWithoutInvalidationPrec?.ranking?.components?.mutation_freshness_penalty || 0) >= 0.32);
  assert.ok((focusRefreshWithoutInvalidationPrec?.ranking?.components?.mutation_freshness_smells || 0) >= 1);

  const writebackOwnershipResult = runTool('precedents', { query: 'setQueryData owned detail and invalidate list targeted invalidation optimistic update', limit: 10, examples: 3 }, env);
  assert.equal(writebackOwnershipResult.status, 'ok');
  assert.ok(Array.isArray(writebackOwnershipResult.precedents));
  assert.ok(writebackOwnershipResult.precedents.length > 0);
  assert.equal(writebackOwnershipResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/CacheWritebackWithTargetedInvalidation.tsx');
  assert.ok((writebackOwnershipResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 2);

  const invalidateOnlyResult = runTool('precedents', { query: 'setQueryData writeback local cache patch detail do not use invalidate-only broad invalidation', limit: 10, examples: 3 }, env);
  assert.equal(invalidateOnlyResult.status, 'ok');
  assert.ok(Array.isArray(invalidateOnlyResult.precedents));
  assert.ok(invalidateOnlyResult.precedents.length > 0);
  const invalidateOnlyPrec = invalidateOnlyResult.precedents.find(item => item?.anchor?.filePath === 'apps/dashboard/src/pages/InvalidateOnlyMutationRefresh.tsx');
  assert.ok(invalidateOnlyPrec);
  assert.ok((invalidateOnlyPrec?.ranking?.components?.writeback_ownership_penalty || 0) >= 0.32);
  assert.ok((invalidateOnlyPrec?.ranking?.components?.writeback_ownership_flags || 0) >= 1);

  const rollbackOwnershipResult = runTool('precedents', { query: 'optimistic rollback onMutate onError restore filtered list projections and detail cache', limit: 10, examples: 3 }, env);
  assert.equal(rollbackOwnershipResult.status, 'ok');
  assert.ok(Array.isArray(rollbackOwnershipResult.precedents));
  assert.ok(rollbackOwnershipResult.precedents.length > 0);
  assert.equal(rollbackOwnershipResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/OptimisticRollbackAcrossProjections.tsx');
  assert.ok((rollbackOwnershipResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 2);

  const partialRollbackResult = runTool('precedents', { query: 'partial rollback onMutate filtered list projections onError only restores detail cache', limit: 10, examples: 3 }, env);
  assert.equal(partialRollbackResult.status, 'ok');
  assert.ok(Array.isArray(partialRollbackResult.precedents));
  assert.ok(partialRollbackResult.precedents.length > 0);
  const partialRollbackPrec = partialRollbackResult.precedents.find(item => item?.anchor?.filePath === 'apps/dashboard/src/pages/PartialRollbackDetailOnly.tsx');
  assert.ok(partialRollbackPrec);
  assert.ok((partialRollbackPrec?.ranking?.components?.rollback_ownership_penalty || 0) >= 0.32);
  assert.ok((partialRollbackPrec?.ranking?.components?.rollback_ownership_smells || 0) >= 1);

  const projectionReconcileResult = runTool('precedents', { query: 'optimistic reorder remove filtered list ordering reconcile onMutate onError', limit: 10, examples: 3 }, env);
  assert.equal(projectionReconcileResult.status, 'ok');
  assert.ok(Array.isArray(projectionReconcileResult.precedents));
  assert.ok(projectionReconcileResult.precedents.length > 0);
  assert.equal(projectionReconcileResult.precedents[0]?.anchor?.filePath, 'apps/dashboard/src/pages/OptimisticRollbackAcrossProjections.tsx');
  assert.ok((projectionReconcileResult.precedents[0]?.ranking?.components?.ui_behavior_matches || 0) >= 2);

  const projectionDriftResult = runTool('precedents', { query: 'reorder remove filtered list ordering rollback only restores detail projection drift', limit: 10, examples: 3 }, env);
  assert.equal(projectionDriftResult.status, 'ok');
  assert.ok(Array.isArray(projectionDriftResult.precedents));
  assert.ok(projectionDriftResult.precedents.length > 0);
  const projectionDriftPrec = projectionDriftResult.precedents.find(item => item?.anchor?.filePath === 'apps/dashboard/src/pages/PartialRollbackDetailOnly.tsx');
  assert.ok(projectionDriftPrec);
  assert.ok((projectionDriftPrec?.ranking?.components?.projection_reconcile_penalty || 0) >= 0.36);
  assert.ok((projectionDriftPrec?.ranking?.components?.projection_reconcile_smells || 0) >= 1);
});
