import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeGraph } from '../dist/core/graph/graph.js';
import { processEvidenceSpans } from '../dist/core/ingestion/evidence-span-processor.js';

test('Evidence spans: materializes primary, witness, and proof spans for nodes and edges', async () => {
  const graph = createKnowledgeGraph();

  const callerId = 'Function:apps/dashboard/src/pages/users.tsx:UsersPage';
  const targetId = 'Method:app/Http/Controllers/UsersController.php:index';
  const fileId = 'File:routes/web.php';

  graph.addNode({
    id: callerId,
    label: 'Function',
    properties: {
      name: 'UsersPage',
      filePath: 'apps/dashboard/src/pages/users.tsx',
      startLine: 20,
      endLine: 60,
    },
  });
  graph.addNode({
    id: targetId,
    label: 'Method',
    properties: {
      name: 'index',
      filePath: 'app/Http/Controllers/UsersController.php',
      startLine: 42,
      endLine: 90,
    },
  });
  graph.addNode({
    id: fileId,
    label: 'File',
    properties: {
      name: 'web.php',
      filePath: 'routes/web.php',
    },
  });

  graph.addRelationship({
    id: 'rel-calls',
    type: 'CALLS',
    sourceId: callerId,
    targetId: targetId,
    confidence: 0.95,
    reason: 'route-name:users.index:laravel-route-name-import-resolved',
  });

  const result = await processEvidenceSpans(graph);

  assert.equal(result.version, 1);
  assert.equal(result.stats.nodeEvidenceCount, 3);
  assert.equal(result.stats.edgeEvidenceCount, 1);
  assert.ok(result.stats.witnessSpanCount >= 5);
  assert.ok(result.stats.proofSpanCount >= 5);

  const fileEvidence = result.nodes.find(node => node.nodeId === fileId);
  assert.ok(fileEvidence);
  assert.equal(fileEvidence.primarySpan.startLine, 1);
  assert.equal(fileEvidence.primarySpan.endLine, 1);

  const relEvidence = result.edges.find(edge => edge.edgeId === 'rel-calls');
  assert.ok(relEvidence);
  assert.equal(relEvidence.witnessSpans.length, 2);
  assert.equal(relEvidence.proofSpans.length, 2);
});

test('Evidence spans: keeps edge evidence when one side has no span', async () => {
  const graph = createKnowledgeGraph();

  const sourceId = 'CodeElement:endpoint:get:/api/users';
  const targetId = 'Method:app/Http/Controllers/UsersController.php:index';

  graph.addNode({
    id: sourceId,
    label: 'CodeElement',
    properties: {
      name: 'endpoint:get:/api/users',
      filePath: '',
    },
  });
  graph.addNode({
    id: targetId,
    label: 'Method',
    properties: {
      name: 'index',
      filePath: 'app/Http/Controllers/UsersController.php',
      startLine: 12,
      endLine: 35,
    },
  });

  graph.addRelationship({
    id: 'rel-endpoint-handler',
    type: 'CALLS',
    sourceId,
    targetId,
    confidence: 0.95,
    reason: 'laravel-endpoint:get:/api/users:controller-action',
  });

  const result = await processEvidenceSpans(graph);

  assert.equal(result.stats.nodeEvidenceCount, 1);
  assert.equal(result.stats.edgeEvidenceCount, 1);
  assert.equal(result.edges[0].witnessSpans.length, 1);
  assert.equal(result.edges[0].proofSpans.length, 1);
});
