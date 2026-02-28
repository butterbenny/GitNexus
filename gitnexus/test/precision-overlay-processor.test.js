import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeGraph } from '../dist/core/graph/graph.js';
import { processPrecisionOverlay } from '../dist/core/ingestion/precision-overlay-processor.js';

test('Precision overlay: resolves refs, emits supported edges, and records provenance', async () => {
  const graph = createKnowledgeGraph();

  const fooId = 'Function:src/foo.ts:foo';
  const barId = 'Function:src/bar.ts:bar';
  const bazId = 'Function:src/baz.ts:baz';
  const userId = 'Class:app/Models/User.php:User';
  const baseUserId = 'Class:app/Models/BaseUser.php:BaseUser';

  graph.addNode({
    id: fooId,
    label: 'Function',
    properties: { name: 'foo', filePath: 'src/foo.ts', startLine: 10, endLine: 30 },
  });
  graph.addNode({
    id: barId,
    label: 'Function',
    properties: { name: 'bar', filePath: 'src/bar.ts', startLine: 5, endLine: 25 },
  });
  graph.addNode({
    id: bazId,
    label: 'Function',
    properties: { name: 'baz', filePath: 'src/baz.ts', startLine: 1, endLine: 20 },
  });
  graph.addNode({
    id: userId,
    label: 'Class',
    properties: { name: 'User', filePath: 'app/Models/User.php', startLine: 12, endLine: 90 },
  });
  graph.addNode({
    id: baseUserId,
    label: 'Class',
    properties: { name: 'BaseUser', filePath: 'app/Models/BaseUser.php', startLine: 8, endLine: 70 },
  });

  graph.addRelationship({
    id: 'existing-call',
    type: 'CALLS',
    sourceId: fooId,
    targetId: barId,
    confidence: 0.91,
    reason: 'same-file',
  });

  const overlayJson = JSON.stringify({
    provider: 'scip',
    relations: [
      {
        type: 'CALLS',
        source: { filePath: 'src/foo.ts', name: 'foo', label: 'Function' },
        target: { id: bazId },
        reason: 'scip-moniker',
      },
      {
        type: 'CALLS',
        source: { id: fooId },
        target: { id: barId },
        reason: 'duplicate-existing-call',
      },
      {
        type: 'EXTENDS',
        source: { filePath: 'app/Models/User.php', name: 'User', label: 'Class' },
        target: { filePath: 'app/Models/BaseUser.php', name: 'BaseUser', label: 'Class' },
        confidence: 0.98,
      },
      {
        type: 'CALLS',
        source: { id: fooId },
        target: { filePath: 'src/missing.ts', name: 'missing', label: 'Function' },
      },
      {
        type: 'OVERRIDES',
        source: { id: fooId },
        target: { id: bazId },
      },
      {
        type: 'IMPORTS',
        source: { id: fooId },
        target: { id: bazId },
        confidence: 0.4,
      },
      {
        type: 'CALLS',
        target: { id: bazId },
      },
    ],
  });

  const result = await processPrecisionOverlay('/tmp/repo', graph, undefined, {
    overlayJson,
    minConfidence: 0.85,
  });

  assert.equal(result.stats.overlayFound, true);
  assert.equal(result.stats.provider, 'scip');
  assert.equal(result.stats.declaredRelations, 7);
  assert.equal(result.stats.emittedEdges, 2);
  assert.equal(result.stats.skippedDuplicates, 1);
  assert.equal(result.stats.skippedUnresolved, 2);
  assert.equal(result.stats.skippedUnsupported, 1);
  assert.equal(result.stats.skippedLowConfidence, 1);

  const callEdge = result.edges.find(edge => edge.type === 'CALLS' && edge.sourceId === fooId && edge.targetId === bazId);
  assert.ok(callEdge);
  assert.ok(callEdge.reason.startsWith('precision-overlay:scip:'));
  assert.ok(callEdge.confidence >= 0.95);

  const extendsEdge = result.edges.find(edge => edge.type === 'EXTENDS' && edge.sourceId === userId && edge.targetId === baseUserId);
  assert.ok(extendsEdge);
  assert.equal(extendsEdge.confidence, 0.98);
});

test('Precision overlay: missing overlay file is a no-op', async () => {
  const graph = createKnowledgeGraph();
  const result = await processPrecisionOverlay('/tmp/definitely-missing-repo', graph);
  assert.equal(result.edges.length, 0);
  assert.equal(result.stats.overlayFound, false);
});
