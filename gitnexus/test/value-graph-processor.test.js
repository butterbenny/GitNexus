import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeGraph } from '../dist/core/graph/graph.js';
import { processValueGraph } from '../dist/core/ingestion/value-graph-processor.js';

test('Value graph: materializes literal nodes from role/query/table/route/cache signals', async () => {
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
    id: 'CodeElement:config/permissions.php:role:admin',
    label: 'CodeElement',
    properties: { name: 'role:admin', filePath: 'config/permissions.php' },
  });
  graph.addNode({
    id: 'CodeElement:config:app.timezone',
    label: 'CodeElement',
    properties: { name: 'config:app.timezone', filePath: 'config/app.php' },
  });
  graph.addNode({
    id: 'CodeElement:env:APP_ENV',
    label: 'CodeElement',
    properties: { name: 'env:APP_ENV', filePath: 'config/app.php' },
  });
  graph.addNode({
    id: 'CodeElement:feature:new_checkout',
    label: 'CodeElement',
    properties: { name: 'feature:new_checkout', filePath: 'app/Features/Checkout.php' },
  });
  graph.addNode({
    id: 'CodeElement:i18n:checkout.submit',
    label: 'CodeElement',
    properties: { name: 'i18n:checkout.submit', filePath: 'lang/en/checkout.php' },
  });
  graph.addNode({
    id: 'Class:app/Events/UserInvited.php:UserInvited',
    label: 'Class',
    properties: { name: 'UserInvited', filePath: 'app/Events/UserInvited.php' },
  });
  graph.addNode({
    id: 'Class:app/Console/Commands/SyncUsers.php:SyncUsers',
    label: 'Class',
    properties: { name: 'SyncUsers', filePath: 'app/Console/Commands/SyncUsers.php' },
  });
  graph.addNode({
    id: 'Class:app/Jobs/ProcessTickets.php:ProcessTickets',
    label: 'Class',
    properties: { name: 'ProcessTickets', filePath: 'app/Jobs/ProcessTickets.php' },
  });
  graph.addNode({
    id: 'Class:app/Broadcasting/CampaignChannel.php:CampaignChannel',
    label: 'Class',
    properties: { name: 'CampaignChannel', filePath: 'app/Broadcasting/CampaignChannel.php' },
  });
  graph.addNode({
    id: 'CacheKey:query:users:list',
    label: 'CacheKey',
    properties: { name: 'usersQueryKeys.list', filePath: '', keyName: 'usersQueryKeys.list' },
  });
  graph.addNode({
    id: 'DBTable:orders',
    label: 'DBTable',
    properties: { name: 'DB Table: orders', filePath: 'database/migrations/2026_01_01_create_orders_table.php', tableName: 'orders' },
  });
  graph.addNode({
    id: 'DBColumn:orders:email',
    label: 'DBColumn',
    properties: {
      name: 'DB Column: orders.email',
      filePath: 'database/migrations/2026_01_01_create_orders_table.php',
      tableName: 'orders',
      columnName: 'email',
      tableId: 'DBTable:orders',
    },
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

  assert.equal(result.stats.valueCount, 17);
  assert.equal(result.stats.permissionValues, 1);
  assert.equal(result.stats.endpointValues, 1);
  assert.equal(result.stats.roleValues, 1);
  assert.equal(result.stats.featureFlagValues, 1);
  assert.equal(result.stats.configKeyValues, 1);
  assert.equal(result.stats.envVarValues, 1);
  assert.equal(result.stats.queueNameValues, 1);
  assert.equal(result.stats.broadcastChannelValues, 1);
  assert.equal(result.stats.eventNameValues, 1);
  assert.equal(result.stats.commandNameValues, 1);
  assert.equal(result.stats.i18nKeyValues, 1);
  assert.equal(result.stats.cacheKeyValues, 1);
  assert.equal(result.stats.queryKeyFamilyValues, 1);
  assert.equal(result.stats.routeNameValues, 1);
  assert.equal(result.stats.routeSegmentValues, 1);
  assert.equal(result.stats.tableNameValues, 1);
  assert.equal(result.stats.tableColumnValues, 1);
  assert.ok(result.stats.edgeCount >= 17);
  assert.ok(result.stats.skippedDuplicates >= 1);

  const routeEdge = result.edges.find(edge => edge.reason === 'value-graph:route_name');
  const routeSegmentEdge = result.edges.find(edge => edge.reason === 'value-graph:route_segment');
  const roleEdge = result.edges.find(edge => edge.reason === 'value-graph:role_slug');
  const queryFamilyEdge = result.edges.find(edge => edge.reason === 'value-graph:query_key_family');
  const tableNameEdge = result.edges.find(edge => edge.reason === 'value-graph:table_name');
  const tableColumnEdge = result.edges.find(edge => edge.reason === 'value-graph:table_column');
  const featureFlagEdge = result.edges.find(edge => edge.reason === 'value-graph:feature_flag');
  const configKeyEdge = result.edges.find(edge => edge.reason === 'value-graph:config_key');
  const envVarEdge = result.edges.find(edge => edge.reason === 'value-graph:env_var');
  const queueNameEdge = result.edges.find(edge => edge.reason === 'value-graph:queue_name');
  const broadcastChannelEdge = result.edges.find(edge => edge.reason === 'value-graph:broadcast_channel');
  const eventNameEdge = result.edges.find(edge => edge.reason === 'value-graph:event_name');
  const commandNameEdge = result.edges.find(edge => edge.reason === 'value-graph:command_name');
  const i18nKeyEdge = result.edges.find(edge => edge.reason === 'value-graph:i18n_key');
  assert.ok(routeEdge);
  assert.ok(routeSegmentEdge);
  assert.ok(roleEdge);
  assert.ok(queryFamilyEdge);
  assert.ok(tableNameEdge);
  assert.ok(tableColumnEdge);
  assert.ok(featureFlagEdge);
  assert.ok(configKeyEdge);
  assert.ok(envVarEdge);
  assert.ok(queueNameEdge);
  assert.ok(broadcastChannelEdge);
  assert.ok(eventNameEdge);
  assert.ok(commandNameEdge);
  assert.ok(i18nKeyEdge);
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

  assert.equal(result.stats.valueCount, 2);
  assert.equal(result.stats.edgeCount, 0);
  assert.equal(result.stats.routeNameValues, 1);
  assert.equal(result.stats.routeSegmentValues, 1);
  assert.ok(result.stats.skippedMalformed >= 1);
});
