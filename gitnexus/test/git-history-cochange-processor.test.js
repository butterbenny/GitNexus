import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processGitHistoryCochange } from '../dist/core/ingestion/git-history-cochange-processor.js';

const COMMIT_MARKER = '__GITNEXUS_COMMIT__';

test('Git-history cochange: emits directed file affinity edges from repeated cochange', async () => {
  const gitLogOutput = [
    COMMIT_MARKER,
    'src/a.ts',
    'src/b.ts',
    '',
    COMMIT_MARKER,
    'src/a.ts',
    'src/b.ts',
    'src/c.ts',
    '',
    COMMIT_MARKER,
    'src/a.ts',
    'src/c.ts',
    '',
    COMMIT_MARKER,
    'src/a.ts',
    'docs/readme.md',
    '',
  ].join('\n');

  const result = await processGitHistoryCochange(
    '/tmp',
    ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    undefined,
    {
      gitLogOutput,
      maxCommits: 50,
      minSupport: 2,
      maxFilesPerCommit: 20,
      maxNeighborsPerFile: 8,
    },
  );

  assert.equal(result.stats.qualifyingCommits, 3);
  assert.ok(result.edges.some(edge => edge.sourceId === 'File:src/a.ts' && edge.targetId === 'File:src/b.ts' && edge.type === 'CO_CHANGES_WITH'));
  assert.ok(result.edges.some(edge => edge.sourceId === 'File:src/b.ts' && edge.targetId === 'File:src/a.ts' && edge.type === 'CO_CHANGES_WITH'));
  assert.ok(result.edges.some(edge => edge.sourceId === 'File:src/a.ts' && edge.targetId === 'File:src/c.ts' && edge.type === 'CO_CHANGES_WITH'));
  assert.ok(result.edges.some(edge => edge.sourceId === 'File:src/c.ts' && edge.targetId === 'File:src/a.ts' && edge.type === 'CO_CHANGES_WITH'));
  assert.ok(!result.edges.some(edge => edge.sourceId === 'File:src/b.ts' && edge.targetId === 'File:src/c.ts'));
  assert.ok(result.edges.every(edge => edge.reason.includes('git-history:cochange:support=')));
});
