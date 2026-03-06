import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractUiContractCard } from '../dist/core/derived/ui-contract.js';

test('ui-contract: extracts mutation handoff semantics from submit handlers and mutation callbacks', async () => {
  const content = [
    "import { useMutation } from '@tanstack/react-query';",
    '',
    'export const MutationFlowsPage = () => {',
    '  const { mutate: attachThing } = useMutation({',
    '    mutationFn: async () => null,',
    '  });',
    '',
    '  const { mutate: createThing } = useMutation({',
    '    mutationFn: async values => {',
    '      await createWorkflow(values);',
    '      await updateWorkflowSteps(values);',
    '      return null;',
    '    },',
    '    onSuccess: data => {',
    '      attachThing(data.id);',
    '    },',
    '  });',
    '',
    '  const { mutateAsync: savePrimary } = useMutation({',
    '    mutationFn: async () => null,',
    '  });',
    '',
    '  const { mutateAsync: saveSecondary } = useMutation({',
    '    mutationFn: async () => null,',
    '  });',
    '',
    '  const onStagedSubmit = async values => {',
    '    await savePrimary(values);',
    '    if (values.sync) {',
    '      await saveSecondary(values);',
    '    }',
    '  };',
    '',
    '  return (',
    '    <>',
    '      <form onSubmit={handleSubmit(values => createThing(values))}>',
    '        <button type="submit">Create</button>',
    '      </form>',
    '      <button onClick={handleSubmit(onStagedSubmit)}>Stage</button>',
    '    </>',
    '  );',
    '};',
    '',
  ].join('\n');

  const card = await extractUiContractCard('apps/dashboard/src/pages/MutationFlowsPage.tsx', content);
  assert.ok(card);
  assert.ok(Array.isArray(card.mutationHandoffs));

  assert.ok(card.mutationHandoffs.some(handoff => (
    handoff.kind === 'handle-submit-mutation'
    && handoff.target === 'createThing'
    && handoff.via === 'handleSubmit'
  )));

  assert.ok(card.mutationHandoffs.some(handoff => (
    handoff.kind === 'handle-submit-sequence'
    && Array.isArray(handoff.sequence)
    && handoff.sequence.join('>') === 'savePrimary>saveSecondary'
  )));

  assert.ok(card.mutationHandoffs.some(handoff => (
    handoff.kind === 'callback-handoff'
    && handoff.source === 'createThing'
    && handoff.target === 'attachThing'
    && handoff.via === 'onSuccess'
  )));

  assert.ok(card.mutationHandoffs.some(handoff => (
    handoff.kind === 'mutation-fn-sequence'
    && handoff.source === 'createThing'
    && Array.isArray(handoff.sequence)
    && handoff.sequence.join('>') === 'createWorkflow>updateWorkflowSteps'
  )));

  const submitInteraction = card.interactions.find(interaction => interaction.event === 'onSubmit');
  assert.ok(submitInteraction);
  assert.ok((submitInteraction.mutationHandoffs || []).some(handoff => handoff.kind === 'handle-submit-mutation'));
  assert.ok((submitInteraction.mutationHandoffs || []).some(handoff => handoff.kind === 'callback-handoff'));

  const clickInteraction = card.interactions.find(interaction => interaction.event === 'onClick');
  assert.ok(clickInteraction);
  assert.ok((clickInteraction.mutationHandoffs || []).some(handoff => handoff.kind === 'handle-submit-sequence'));
});
