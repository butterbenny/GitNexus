import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractUiContractCard } from '../dist/core/derived/ui-contract.js';

test('ui-contract: cache coverage flags missing query refresh in same surface', async () => {
  const content = [
    "import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';",
    '',
    'export const CoveragePage = () => {',
    '  const queryClient = useQueryClient();',
    '',
    "  useQuery({ queryKey: ['a', 1], queryFn: async () => [] });",
    "  useQuery({ queryKey: ['b', 1], queryFn: async () => [] });",
    '',
    '  const { mutate: doThing } = useMutation({',
    '    mutationFn: async () => null,',
    '    onSuccess: () => {',
    "      queryClient.invalidateQueries({ queryKey: ['a'] });",
    '    },',
    '  });',
    '',
    '  return <button onClick={() => doThing()}>Go</button>;',
    '};',
    '',
  ].join('\n');

  const card = await extractUiContractCard('apps/dashboard/src/pages/CoveragePage.tsx', content);
  assert.ok(card);
  assert.ok(Array.isArray(card.interactions));
  assert.ok(Array.isArray(card.queries));

  assert.ok(Array.isArray(card.cacheCoverage));
  assert.ok(card.cacheCoverage.length > 0);

  const gap = card.cacheCoverage.find(c => (c?.missing_queries || []).some(q => String(q?.queryKey || '').includes("'b'")));
  assert.ok(gap);

  const click = card.interactions.find(i => i.event === 'onClick');
  assert.ok(click);

  const smellKinds = new Set((click.smells || []).map(s => s.kind));
  assert.ok(smellKinds.has('cache-coverage-gap'));
});
