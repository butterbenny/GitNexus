import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeGraph } from '../dist/core/graph/graph.js';
import { processStructuredSummaryOverlay } from '../dist/core/ingestion/summary-overlay-processor.js';

test('Structured summaries: materializes hierarchical overlays', async () => {
  const graph = createKnowledgeGraph();

  const routeFileId = 'File:routes/api.php';
  const controllerFileId = 'File:app/Http/Controllers/UserController.php';
  const frontendFnId = 'Function:apps/dashboard/src/api/users.ts:fetchUsers';
  const endpointId = 'CodeElement:endpoint:get:/api/users';
  const handlerId = 'Method:app/Http/Controllers/UserController.php:index';
  const permissionId = 'CodeElement:permission:users.view';
  const cacheKeyId = 'CacheKey:apps/dashboard/src/queryKeys/users.ts:users';
  const contractFieldId = 'ContractField:request:users.email';
  const sliceId = 'FeatureSlice:users.read';
  const communityId = 'Community:auth';
  const processId = 'Process:UsersReadFlow';

  graph.addNode({
    id: routeFileId,
    label: 'File',
    properties: { name: 'api.php', filePath: 'routes/api.php' },
  });
  graph.addNode({
    id: controllerFileId,
    label: 'File',
    properties: { name: 'UserController.php', filePath: 'app/Http/Controllers/UserController.php' },
  });
  graph.addNode({
    id: frontendFnId,
    label: 'Function',
    properties: { name: 'fetchUsers', filePath: 'apps/dashboard/src/api/users.ts', startLine: 1, endLine: 10 },
  });
  graph.addNode({
    id: endpointId,
    label: 'CodeElement',
    properties: { name: 'endpoint:get:/api/users', filePath: 'routes/api.php', startLine: 8, endLine: 8 },
  });
  graph.addNode({
    id: handlerId,
    label: 'Method',
    properties: { name: 'index', filePath: 'app/Http/Controllers/UserController.php', startLine: 14, endLine: 42 },
  });
  graph.addNode({
    id: permissionId,
    label: 'CodeElement',
    properties: { name: 'permission:users.view', filePath: 'app/Domains/Permissions/UserPermission.php' },
  });
  graph.addNode({
    id: cacheKeyId,
    label: 'CacheKey',
    properties: { name: 'users', keyName: 'users', keyType: 'query' },
  });
  graph.addNode({
    id: contractFieldId,
    label: 'ContractField',
    properties: { name: 'email', fieldName: 'email' },
  });
  graph.addNode({
    id: sliceId,
    label: 'FeatureSlice',
    properties: { name: 'users.read', sliceType: 'endpoint', closureSlots: ['auth', 'shape'], closedSlots: ['auth'] },
  });
  graph.addNode({
    id: communityId,
    label: 'Community',
    properties: { name: 'Auth', heuristicLabel: 'Auth' },
  });
  graph.addNode({
    id: processId,
    label: 'Process',
    properties: { name: 'UsersReadFlow', heuristicLabel: 'UsersReadFlow', processType: 'http', stepCount: 2 },
  });

  graph.addRelationship({
    id: 'rel-file-route-defines-endpoint',
    type: 'DEFINES',
    sourceId: routeFileId,
    targetId: endpointId,
    confidence: 1.0,
    reason: '',
  });
  graph.addRelationship({
    id: 'rel-file-controller-defines-handler',
    type: 'DEFINES',
    sourceId: controllerFileId,
    targetId: handlerId,
    confidence: 1.0,
    reason: '',
  });
  graph.addRelationship({
    id: 'rel-fe-http-endpoint',
    type: 'CALLS',
    sourceId: frontendFnId,
    targetId: endpointId,
    confidence: 0.99,
    reason: 'http-get:/api/users',
  });
  graph.addRelationship({
    id: 'rel-endpoint-handler',
    type: 'CALLS',
    sourceId: endpointId,
    targetId: handlerId,
    confidence: 0.96,
    reason: 'laravel-endpoint:get:/api/users:import-resolved',
  });
  graph.addRelationship({
    id: 'rel-handler-permission',
    type: 'CALLS',
    sourceId: handlerId,
    targetId: permissionId,
    confidence: 0.94,
    reason: 'laravel-can:endpoint-middleware:can:users.view',
  });
  graph.addRelationship({
    id: 'rel-handler-cache',
    type: 'INVALIDATES_KEY',
    sourceId: handlerId,
    targetId: cacheKeyId,
    confidence: 0.9,
    reason: 'micro-dataflow:query-invalidation:users',
  });
  graph.addRelationship({
    id: 'rel-handler-shape',
    type: 'VALIDATES_FIELD',
    sourceId: handlerId,
    targetId: contractFieldId,
    confidence: 1.0,
    reason: 'shape:request:users',
  });
  graph.addRelationship({
    id: 'rel-endpoint-slice',
    type: 'MEMBER_OF',
    sourceId: endpointId,
    targetId: sliceId,
    confidence: 1.0,
    reason: 'feature-slice:anchor',
  });
  graph.addRelationship({
    id: 'rel-handler-slice',
    type: 'MEMBER_OF',
    sourceId: handlerId,
    targetId: sliceId,
    confidence: 1.0,
    reason: 'feature-slice:member',
  });
  graph.addRelationship({
    id: 'rel-endpoint-community',
    type: 'MEMBER_OF',
    sourceId: endpointId,
    targetId: communityId,
    confidence: 1.0,
    reason: '',
  });
  graph.addRelationship({
    id: 'rel-handler-community',
    type: 'MEMBER_OF',
    sourceId: handlerId,
    targetId: communityId,
    confidence: 1.0,
    reason: '',
  });
  graph.addRelationship({
    id: 'rel-endpoint-process',
    type: 'STEP_IN_PROCESS',
    sourceId: endpointId,
    targetId: processId,
    confidence: 1.0,
    reason: '',
    step: 1,
  });
  graph.addRelationship({
    id: 'rel-handler-process',
    type: 'STEP_IN_PROCESS',
    sourceId: handlerId,
    targetId: processId,
    confidence: 1.0,
    reason: '',
    step: 2,
  });

  const snapshot = await processStructuredSummaryOverlay(graph);

  assert.ok(snapshot.stats.symbolCount > 0);
  assert.ok(snapshot.stats.fileCount > 0);
  assert.ok(snapshot.stats.sliceCount > 0);
  assert.ok(snapshot.stats.communityCount > 0);
  assert.ok(snapshot.stats.processCount > 0);
  assert.ok(snapshot.stats.archetypeCount > 0);

  const endpointSummary = snapshot.symbols.find(summary => summary.entityId === endpointId);
  assert.ok(endpointSummary);
  assert.ok(endpointSummary.downstreamEffects.some(value => value.includes('index')));

  const handlerSummary = snapshot.symbols.find(summary => summary.entityId === handlerId);
  assert.ok(handlerSummary);
  assert.ok(handlerSummary.contracts.auth.some(value => value.includes('permission:users.view')));

  const routeFileSummary = snapshot.files.find(summary => summary.entityId === routeFileId);
  assert.ok(routeFileSummary);
  assert.ok(routeFileSummary.responsibilities.some(value => value.startsWith('defines:')));

  const archetypeSummary = snapshot.archetypes[0];
  assert.ok(archetypeSummary);
  assert.ok(archetypeSummary.responsibilities.some(value => value.startsWith('signature:')));
});
