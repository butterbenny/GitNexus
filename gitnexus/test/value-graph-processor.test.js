import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeGraph } from '../dist/core/graph/graph.js';
import { processValueGraph } from '../dist/core/ingestion/value-graph-processor.js';

test('Value graph: materializes literal nodes from permission/endpoint/cache/route signals', async () => {
  const graph = createKnowledgeGraph();

  const routeCallerId = 'Function:apps/dashboard/src/pages/users.tsx:UsersPage';

  graph.addNode({
    id: routeCallerId,
    label: 'Function',
    properties: { name: 'UsersPage', filePath: 'apps/dashboard/src/pages/users.tsx' },
  });
  graph.addNode({
    id: 'CodeElement:permission:users.view',
    label: 'CodeElement',
    properties: { name: 'permission:users.view', filePath: 'app/Domains/Permissions/UserPermission.php' },
  });
  graph.addNode({
    id: 'CodeElement:endpoint:get:/api/users',
    label: 'CodeElement',
    properties: { name: 'endpoint:get:/api/users', filePath: 'routes/api.php' },
  });
  graph.addNode({
    id: 'CacheKey:query:users:list',
    label: 'CacheKey',
    properties: { name: 'usersQueryKeys.list', filePath: '', keyName: 'usersQueryKeys.list' },
  });

  graph.addRelationship({
    id: 'route-name-1',
    type: 'CALLS',
    sourceId: routeCallerId,
    targetId: 'CodeElement:endpoint:get:/api/users',
    confidence: 0.95,
    reason: 'route-name:users.index:laravel-route-name-import-resolved',
  });
  graph.addRelationship({
    id: 'route-name-duplicate',
    type: 'CALLS',
    sourceId: routeCallerId,
    targetId: 'CodeElement:endpoint:get:/api/users',
    confidence: 0.9,
    reason: 'route-name:users.index:laravel-route-name-import-resolved',
  });

  const result = await processValueGraph(graph);

  assert.equal(result.stats.valueCount, 4);
  assert.equal(result.stats.permissionValues, 1);
  assert.equal(result.stats.endpointValues, 1);
  assert.equal(result.stats.cacheKeyValues, 1);
  assert.equal(result.stats.routeNameValues, 1);
  assert.ok(result.stats.edgeCount >= 4);
  assert.ok(result.stats.skippedDuplicates >= 1);

  const routeEdge = result.edges.find(edge => edge.reason === 'value-graph:route_name');
  assert.ok(routeEdge);
  assert.equal(routeEdge.sourceId, routeCallerId);
});

test('Value graph: guards malformed and unresolved signals', async () => {
  const graph = createKnowledgeGraph();

  graph.addNode({
    id: 'CodeElement:permission:',
    label: 'CodeElement',
    properties: { name: 'permission:', filePath: 'app/Domains/Permissions/BrokenPermission.php' },
  });

  graph.addRelationship({
    id: 'missing-source-route',
    type: 'CALLS',
    sourceId: 'Function:missing.ts:missing',
    targetId: 'Method:app/Http/Controllers/UsersController.php:index',
    confidence: 0.95,
    reason: 'route-name:users.show:laravel-route-name-import-resolved',
  });

  const result = await processValueGraph(graph);

  assert.equal(result.stats.valueCount, 1);
  assert.equal(result.stats.edgeCount, 0);
  assert.ok(result.stats.skippedMalformed >= 1);
});
