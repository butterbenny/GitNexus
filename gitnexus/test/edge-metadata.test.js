import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichRelationshipMetadata, parseWitnessPathIds, serializeWitnessPathIds } from '../dist/core/graph/edge-metadata.js';
import { createKnowledgeGraph } from '../dist/core/graph/graph.js';

test('Edge metadata: enriches deterministic structural edges', () => {
  const relation = enrichRelationshipMetadata({
    id: 'edge:file:users->fn:index',
    type: 'DEFINES',
    sourceId: 'File:app/Http/Controllers/UsersController.php',
    targetId: 'Method:app/Http/Controllers/UsersController.php:index',
    confidence: 1.0,
    reason: '',
  });

  assert.equal(relation.provenanceFamily, 'structural');
  assert.equal(relation.certaintyTier, 'deterministic');
  assert.equal(relation.absenceSemantics, 'not_applicable');
  assert.ok(Array.isArray(relation.witnessPathIds));
  assert.ok(relation.witnessPathIds.length > 0);
});

test('Edge metadata: classifies slice closure + cochange semantics', () => {
  const sliceRelation = enrichRelationshipMetadata({
    id: 'edge:slice-member',
    type: 'MEMBER_OF',
    sourceId: 'Method:app/Policies/UsersPolicy.php:view',
    targetId: 'FeatureSlice:permission:users_view',
    confidence: 1.0,
    reason: 'feature-slice:authorization_consumer',
  });
  assert.equal(sliceRelation.provenanceFamily, 'slice_closure');
  assert.equal(sliceRelation.certaintyTier, 'typed');
  assert.equal(sliceRelation.absenceSemantics, 'closed_world');

  const historicalRelation = enrichRelationshipMetadata({
    id: 'edge:git-history',
    type: 'CO_CHANGES_WITH',
    sourceId: 'File:app/Http/Controllers/UsersController.php',
    targetId: 'File:app/Services/UsersService.php',
    confidence: 0.82,
    reason: 'git-history:cochange:support=4;ratio=0.667',
  });
  assert.equal(historicalRelation.provenanceFamily, 'historical_cochange');
  assert.equal(historicalRelation.certaintyTier, 'historical');
  assert.equal(historicalRelation.absenceSemantics, 'open_world');
});

test('Edge metadata: witness path serialization round-trips', () => {
  const serialized = serializeWitnessPathIds(['edge:a', 'family:structural', 'edge:a']);
  assert.equal(serialized, 'edge:a|family:structural');
  assert.deepEqual(parseWitnessPathIds(serialized), ['edge:a', 'family:structural']);
});

test('Edge metadata: graph relationship insertion auto-enriches metadata', () => {
  const graph = createKnowledgeGraph();
  graph.addRelationship({
    id: 'edge:auto',
    type: 'CALLS',
    sourceId: 'Function:apps/dashboard/src/users.tsx:loadUsers',
    targetId: 'Method:app/Http/Controllers/UsersController.php:index',
    confidence: 0.95,
    reason: 'http-get:/api/users',
  });

  const relation = graph.relationships.find(item => item.id === 'edge:auto');
  assert.ok(relation);
  assert.equal(relation.provenanceFamily, 'http_routing');
  assert.equal(relation.certaintyTier, 'typed');
  assert.ok(Array.isArray(relation.witnessPathIds));
});
