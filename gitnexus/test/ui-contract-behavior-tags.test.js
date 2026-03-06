import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractUiContractCard } from '../dist/core/derived/ui-contract.js';

test('ui-contract: derives broader behavior tags from interaction effects', async () => {
  const content = [
    "import { keepPreviousData, useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query';",
    '',
    'export const UiBehaviorPage = () => {',
    '  useSuspenseQuery({',
    "    queryKey: ['thing', thingId],",
    '    queryFn: () => fetchThing(thingId),',
    '  });',
    '',
    '  useQuery({',
    "    queryKey: ['things', filters],",
    '    queryFn: () => fetchThings(filters),',
    '    enabled: hasValidFilters,',
    '    placeholderData: keepPreviousData,',
    '  });',
    '',
    '  useQuery({',
    "    queryKey: ['thing', selectedThingId],",
    '    queryFn: () => fetchThingDetails(selectedThingId),',
    '    enabled: !!selectedThingId,',
    "    refetchOnWindowFocus: 'always',",
    '  });',
    '',
    '  useQuery({',
    "    queryKey: ['bulkAction', pendingBulkActionId],",
    '    queryFn: () => fetchBulkAction(pendingBulkActionId),',
    "    refetchOnWindowFocus: 'always',",
    '    refetchInterval: pendingBulkActionId ? 2000 : undefined,',
    '  });',
    '',
    '  const { mutate: loadAssignee } = useMutation({',
    '    mutationFn: async assigneeId => fetchAssignee(assigneeId),',
    '    onSuccess: data => {',
    "      setValue('assignee_email', data.email);",
    '    },',
    '  });',
    '',
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
    '  const { mutate: saveCampaignEvent } = useMutation({',
    '    mutationFn: async values => values,',
    '    onSuccess: () => {',
    '      queryClient.invalidateQueries({ queryKey: eventQueryKeys.event(campaignId) });',
    '      queryClient.invalidateQueries({ queryKey: campaignQueryKeys.campaign(campaignId) });',
    '    },',
    '  });',
    '',
    '  const { mutate: togglePinnedThing } = useMutation({',
    '    mutationFn: async thing => thing,',
    '    onMutate: thing => {',
    '      queryClient.setQueryData(accountQueryKeys.current(accountId), old => old);',
    '      queryClient.setQueryData(thingQueryKeys.detail(thing.id), old => old);',
    '      return { previousThing: thing };',
    '    },',
    '    onError: (error, thing) => {',
    '      queryClient.setQueryData(accountQueryKeys.current(accountId), old => old);',
    '      queryClient.setQueryData(thingQueryKeys.detail(thing.id), thing);',
    '    },',
    '  });',
    '',
    '  const { mutate: reconcileVisibleThings } = useMutation({',
    '    mutationFn: async thing => thing,',
    '    onMutate: thing => {',
    '      queryClient.setQueryData(thingQueryKeys.list(filters), old =>',
    "        orderBy(uniqBy(old.filter(item => item.id !== thing.id).concat([{ ...thing, position: 1 }]), 'id'), 'position', 'asc')",
    '      );',
    '      return { previousThing: thing };',
    '    },',
    '    onError: (error, thing) => {',
    '      queryClient.setQueryData(thingQueryKeys.list(filters), old =>',
    "        orderBy(uniqBy(old.map(item => item.id === thing.id ? thing : item), 'id'), 'position', 'asc')",
    '      );',
    '    },',
    '  });',
    '',
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
    '  const { mutate: replaceRowSuccess } = useMutation({',
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
    '        content: (',
    '          <TableRowSuccessState',
    "            successMessage={'Saved row'}",
    '            undoMutationFn={() => undoRow(row.id)}',
    '            invalidationKeys={[thingQueryKeys.list(filters), metricsQueryKeys.current(accountId)]}',
    '          />',
    '        ),',
    '      });',
    '    },',
    '  });',
    '',
    '  const { mutate: saveWithFocusRefetch } = useMutation({',
    '    mutationFn: async values => values,',
    '    onSuccess: () => {',
    "      toast.success('Saved with focus refetch');",
    '    },',
    '  });',
    '',
    '  return (',
    '    <>',
    '      <Dialog.Root open={isOpen} onOpenChange={setIsOpen}>',
    '        <form onSubmit={handleSubmit(values => saveThing(values))}>',
    '          <Form.SubmitButton isSubmitting={isPending}>Save</Form.SubmitButton>',
    '        </form>',
    '      </Dialog.Root>',
    '      <Select.Root',
    '        onValueChange={value => {',
    "          setValue('assignee_id', value);",
    "          resetField('secondary_contact');",
    '          loadAssignee(value);',
    "          setValue('assignee_label', `Assignee ${value}`);",
    '        }}',
    '      />',
    '      <button onClick={() => saveCampaignEvent({})}>Save event</button>',
    '      <button onClick={() => saveWithFocusRefetch({})}>Save focus only</button>',
    '    </>',
    '  );',
    '};',
    '',
  ].join('\n');

  const card = await extractUiContractCard('apps/dashboard/src/pages/UiBehaviorPage.tsx', content);
  assert.ok(card);
  assert.ok(Array.isArray(card.behaviorTags));
  assert.ok(Array.isArray(card.pendingGates));

  assert.ok(card.behaviorTags.includes('mutation-closes-surface'));
  assert.ok(card.behaviorTags.includes('mutation-refreshes-cache'));
  assert.ok(card.behaviorTags.includes('mutation-cache-write'));
  assert.ok(card.behaviorTags.includes('mutation-cache-write-plus-refresh'));
  assert.ok(card.behaviorTags.includes('mutation-optimistic-cache-write'));
  assert.ok(card.behaviorTags.includes('mutation-optimistic-projection-reconcile'));
  assert.ok(card.behaviorTags.includes('mutation-rollback-restores-cache'));
  assert.ok(card.behaviorTags.includes('mutation-rollback-restores-multi-cache'));
  assert.ok(card.behaviorTags.includes('mutation-rollback-restores-projection-reconcile'));
  assert.ok(card.behaviorTags.includes('mutation-refreshes-multiple-cache-roots'));
  assert.ok(card.behaviorTags.includes('mutation-refreshes-cross-root-cache'));
  assert.ok(card.behaviorTags.includes('mutation-navigates'));
  assert.ok(card.behaviorTags.includes('mutation-shows-toast'));
  assert.ok(card.behaviorTags.includes('mutation-pending-ux'));
  assert.ok(card.behaviorTags.includes('mutation-pending-controlled-surface'));
  assert.ok(card.behaviorTags.includes('mutation-table-row-pending'));
  assert.ok(card.behaviorTags.includes('mutation-table-inline-success'));
  assert.ok(card.behaviorTags.includes('mutation-table-inline-success-undo'));
  assert.ok(card.behaviorTags.includes('mutation-table-inline-success-deferred-refresh'));
  assert.ok(card.behaviorTags.includes('selection-prefill'));
  assert.ok(card.behaviorTags.includes('selection-async-enrichment'));
  assert.ok(card.behaviorTags.includes('selection-resets-dependent-state'));
  assert.ok(card.behaviorTags.includes('selection-enabled-follow-up-query'));
  assert.ok(card.behaviorTags.includes('query-required-suspense'));
  assert.ok(card.behaviorTags.includes('query-optional-gate-non-suspense'));
  assert.ok(card.behaviorTags.includes('query-enabled-gate'));
  assert.ok(card.behaviorTags.includes('query-enabled-non-suspense'));
  assert.ok(card.behaviorTags.includes('query-focus-refresh-always'));
  assert.ok(card.behaviorTags.includes('query-polling-refresh'));
  assert.ok(card.behaviorTags.includes('query-keep-previous-data'));
  assert.ok(card.behaviorTags.includes('query-interactive-refetch'));
  assert.ok(card.pendingGates.some(surface => surface.element === 'Form.SubmitButton'));
  assert.ok(card.smells.some(smell => smell.kind === 'mutation-relies-on-freshness-policy'));
  assert.ok(card.smells.some(smell => smell.kind === 'mutation-rollback-misses-optimistic-cache-roots'));
  assert.ok(card.smells.some(smell => smell.kind === 'mutation-rollback-misses-optimistic-projection-reconcile'));
  assert.ok(card.queries.some(query => query.enabled === 'hasValidFilters' && query.placeholderData === 'keepPreviousData'));
  assert.ok(card.queries.some(query => query.refetchOnWindowFocus === "'always'" && query.refetchInterval === 'pendingBulkActionId ? 2000 : undefined'));
});

test('ui-contract: flags useEffect-driven selection sync as a smell', async () => {
  const content = [
    "import { useEffect } from 'react';",
    "import { useMutation } from '@tanstack/react-query';",
    '',
    'export const SelectionEffectSyncPage = () => {',
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
  ].join('\n');

  const card = await extractUiContractCard('apps/dashboard/src/pages/SelectionEffectSyncPage.tsx', content);
  assert.ok(card);
  assert.ok(Array.isArray(card.smells));
  assert.ok(card.smells.some(smell => smell.kind === 'selection-sync-useeffect'));
});
