import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeGraph } from '../dist/core/graph/graph.js';
import { processFeatureSlices } from '../dist/core/ingestion/feature-slice-processor.js';

test('Feature slices: materializes endpoint/query_key/permission slices with closure slots', async () => {
  const graph = createKnowledgeGraph();

  const endpointNodeId = 'CodeElement:endpoint:get:/api/orders';
  const permissionNodeId = 'CodeElement:permission:orders.view';
  const handlerNodeId = 'Method:app/Http/Controllers/OrdersController.php:index';
  const uiCallerNodeId = 'Function:apps/dashboard/src/pages/orders.tsx:OrdersPage';
  const queryKeyNodeId = 'Function:apps/dashboard/src/query-keys.ts:ordersQueryKeys.list';
  const queryConsumerNodeId = 'Function:apps/dashboard/src/hooks/use-orders.ts:useOrders';

  graph.addNode({
    id: endpointNodeId,
    label: 'CodeElement',
    properties: { name: 'endpoint:get:/api/orders', filePath: 'routes/api.php' },
  });
  graph.addNode({
    id: permissionNodeId,
    label: 'CodeElement',
    properties: { name: 'orders.view', filePath: 'app/Domains/AccessControl/Permissions/OrderPermission.php' },
  });
  graph.addNode({
    id: handlerNodeId,
    label: 'Method',
    properties: { name: 'index', filePath: 'app/Http/Controllers/OrdersController.php' },
  });
  graph.addNode({
    id: uiCallerNodeId,
    label: 'Function',
    properties: { name: 'OrdersPage', filePath: 'apps/dashboard/src/pages/orders.tsx' },
  });
  graph.addNode({
    id: queryKeyNodeId,
    label: 'Function',
    properties: { name: 'ordersQueryKeys.list', filePath: 'apps/dashboard/src/query-keys.ts' },
  });
  graph.addNode({
    id: queryConsumerNodeId,
    label: 'Function',
    properties: { name: 'useOrders', filePath: 'apps/dashboard/src/hooks/use-orders.ts' },
  });

  graph.addRelationship({
    id: 'rel-ui-endpoint',
    type: 'CALLS',
    sourceId: uiCallerNodeId,
    targetId: endpointNodeId,
    confidence: 0.95,
    reason: 'http-request:get:/api/orders',
  });
  graph.addRelationship({
    id: 'rel-endpoint-handler',
    type: 'CALLS',
    sourceId: endpointNodeId,
    targetId: handlerNodeId,
    confidence: 0.95,
    reason: 'laravel-endpoint:get:/api/orders:controller-action',
  });
  graph.addRelationship({
    id: 'rel-handler-permission',
    type: 'CALLS',
    sourceId: handlerNodeId,
    targetId: permissionNodeId,
    confidence: 0.95,
    reason: 'laravel-authorize:can:orders.view',
  });
  graph.addRelationship({
    id: 'rel-query-consumer',
    type: 'CALLS',
    sourceId: queryConsumerNodeId,
    targetId: queryKeyNodeId,
    confidence: 0.95,
    reason: 'react-query-key:query-key-usage',
  });
  graph.addRelationship({
    id: 'rel-query-endpoint',
    type: 'CALLS',
    sourceId: queryKeyNodeId,
    targetId: endpointNodeId,
    confidence: 0.95,
    reason: 'react-query-key:http-endpoint',
  });

  const result = await processFeatureSlices(graph);

  assert.ok(result.stats.totalSlices >= 3);

  const endpointSlice = result.slices.find(slice => slice.sliceType === 'endpoint' && slice.anchorId === endpointNodeId);
  assert.ok(endpointSlice);
  assert.ok(endpointSlice.closedSlots.includes('entrypoint'));
  assert.ok(endpointSlice.closedSlots.includes('handler'));
  assert.ok(endpointSlice.closedSlots.includes('authorization'));

  const querySlice = result.slices.find(slice => slice.sliceType === 'query_key' && slice.anchorId === queryKeyNodeId);
  assert.ok(querySlice);
  assert.ok(querySlice.closedSlots.includes('query_consumer'));

  const permissionSlice = result.slices.find(slice => slice.sliceType === 'permission' && slice.anchorId === permissionNodeId);
  assert.ok(permissionSlice);
  assert.ok(permissionSlice.closedSlots.includes('authorization_consumer'));

  const hasEndpointMembership = result.memberships.some(m => m.nodeId === uiCallerNodeId && m.sliceId === endpointSlice.id);
  assert.ok(hasEndpointMembership);
});

test('Feature slices: query_key closes query_consumer from react-query key-to-query-fn edges', async () => {
  const graph = createKnowledgeGraph();

  const queryKeyNodeId = 'Function:apps/dashboard/src/queries/account-query-keys.ts:accountQueryKeys.users';
  const queryFnNodeId = 'Function:apps/dashboard/src/api/users.ts:fetchUsers';

  graph.addNode({
    id: queryKeyNodeId,
    label: 'Function',
    properties: { name: 'accountQueryKeys.users', filePath: 'apps/dashboard/src/queries/account-query-keys.ts' },
  });
  graph.addNode({
    id: queryFnNodeId,
    label: 'Function',
    properties: { name: 'fetchUsers', filePath: 'apps/dashboard/src/api/users.ts' },
  });

  graph.addRelationship({
    id: 'rel-query-key-to-query-fn',
    type: 'CALLS',
    sourceId: queryKeyNodeId,
    targetId: queryFnNodeId,
    confidence: 0.95,
    reason: 'react-query:key-to-query-fn',
  });

  const result = await processFeatureSlices(graph);
  const querySlice = result.slices.find(slice => slice.sliceType === 'query_key' && slice.anchorId === queryKeyNodeId);
  assert.ok(querySlice);
  assert.ok(querySlice.closedSlots.includes('query_consumer'));

  const consumerMembership = result.memberships.find(
    membership => membership.nodeId === queryFnNodeId && membership.sliceId === querySlice.id,
  );
  assert.ok(consumerMembership);
  assert.equal(consumerMembership.role, 'query_consumer');
});
