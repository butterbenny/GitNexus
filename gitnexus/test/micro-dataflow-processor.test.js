import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeGraph } from '../dist/core/graph/graph.js';
import { processMicroDataflow } from '../dist/core/ingestion/micro-dataflow-processor.js';

test('Micro-dataflow: materializes targeted closures across request/response, query invalidation, events, and permissions', async () => {
  const graph = createKnowledgeGraph();

  const endpointId = 'CodeElement:endpoint:post:/api/users';
  const handlerId = 'Method:app/Http/Controllers/UserController.php:update';
  const requestClassId = 'Class:app/Http/Requests/UpdateUserRequest.php:UpdateUserRequest';
  const resourceClassId = 'Class:app/Http/Resources/UserResource.php:UserResource';
  const requestFieldId = 'ContractField:request:user.name';
  const responseFieldId = 'ContractField:response:user.id';
  const listenerId = 'Method:app/Listeners/UserUpdatedListener.php:handle';
  const permissionId = 'CodeElement:permission:users.update';
  const cacheKeyId = 'CacheKey:query:users.list';
  const keyFactoryId = 'Function:apps/dashboard/src/query-keys.ts:usersQueryKeys.list';
  const consumerId = 'Function:apps/dashboard/src/hooks/use-users.ts:useUsers';
  const invalidatorId = 'File:apps/dashboard/src/hooks/use-update-user.ts';

  graph.addNode({ id: endpointId, label: 'CodeElement', properties: { name: 'endpoint:post:/api/users', filePath: 'routes/api.php' } });
  graph.addNode({ id: handlerId, label: 'Method', properties: { name: 'update', filePath: 'app/Http/Controllers/UserController.php' } });
  graph.addNode({ id: requestClassId, label: 'Class', properties: { name: 'UpdateUserRequest', filePath: 'app/Http/Requests/UpdateUserRequest.php' } });
  graph.addNode({ id: resourceClassId, label: 'Class', properties: { name: 'UserResource', filePath: 'app/Http/Resources/UserResource.php' } });
  graph.addNode({ id: requestFieldId, label: 'ContractField', properties: { name: 'user.name', filePath: '', fieldName: 'user.name', shapeId: 'shape-request' } });
  graph.addNode({ id: responseFieldId, label: 'ContractField', properties: { name: 'user.id', filePath: '', fieldName: 'user.id', shapeId: 'shape-response' } });
  graph.addNode({ id: listenerId, label: 'Method', properties: { name: 'handle', filePath: 'app/Listeners/UserUpdatedListener.php' } });
  graph.addNode({ id: permissionId, label: 'CodeElement', properties: { name: 'permission:users.update', filePath: 'app/Domains/Permissions/UserPermission.php' } });
  graph.addNode({ id: cacheKeyId, label: 'CacheKey', properties: { name: 'usersQueryKeys.list', filePath: '', keyName: 'usersQueryKeys.list' } });
  graph.addNode({ id: keyFactoryId, label: 'Function', properties: { name: 'usersQueryKeys.list', filePath: 'apps/dashboard/src/query-keys.ts' } });
  graph.addNode({ id: consumerId, label: 'Function', properties: { name: 'useUsers', filePath: 'apps/dashboard/src/hooks/use-users.ts' } });
  graph.addNode({ id: invalidatorId, label: 'File', properties: { name: 'use-update-user.ts', filePath: 'apps/dashboard/src/hooks/use-update-user.ts' } });

  graph.addRelationship({
    id: 'endpoint-handler',
    type: 'CALLS',
    sourceId: endpointId,
    targetId: handlerId,
    confidence: 0.95,
    reason: 'laravel-endpoint:post:/api/users:laravel-route-import-resolved',
  });
  graph.addRelationship({
    id: 'handler-request',
    type: 'CALLS',
    sourceId: handlerId,
    targetId: requestClassId,
    confidence: 0.95,
    reason: 'laravel-form-request:param',
  });
  graph.addRelationship({
    id: 'request-field',
    type: 'VALIDATES_FIELD',
    sourceId: requestClassId,
    targetId: requestFieldId,
    confidence: 0.95,
    reason: 'laravel-form-request:rules',
  });
  graph.addRelationship({
    id: 'handler-resource',
    type: 'CALLS',
    sourceId: handlerId,
    targetId: resourceClassId,
    confidence: 0.95,
    reason: 'laravel-resource:return',
  });
  graph.addRelationship({
    id: 'resource-field',
    type: 'SERIALIZES_FIELD',
    sourceId: resourceClassId,
    targetId: responseFieldId,
    confidence: 0.95,
    reason: 'laravel-resource:to-array',
  });
  graph.addRelationship({
    id: 'handler-event',
    type: 'CALLS',
    sourceId: handlerId,
    targetId: listenerId,
    confidence: 0.9,
    reason: 'laravel-event-dispatch-helper-import-resolved',
  });
  graph.addRelationship({
    id: 'handler-permission',
    type: 'CALLS',
    sourceId: handlerId,
    targetId: permissionId,
    confidence: 0.9,
    reason: 'laravel-authorize:can:users.update',
  });
  graph.addRelationship({
    id: 'key-def',
    type: 'DEFINES',
    sourceId: keyFactoryId,
    targetId: cacheKeyId,
    confidence: 0.95,
    reason: 'react-query:key-factory',
  });
  graph.addRelationship({
    id: 'consumer-key',
    type: 'CALLS',
    sourceId: consumerId,
    targetId: keyFactoryId,
    confidence: 0.95,
    reason: 'react-query-key:query-key-usage',
  });
  graph.addRelationship({
    id: 'invalidate-key',
    type: 'INVALIDATES_KEY',
    sourceId: invalidatorId,
    targetId: cacheKeyId,
    confidence: 0.9,
    reason: 'react-query:invalidateQueries',
  });

  const result = await processMicroDataflow(graph);

  assert.ok(result.edges.some(edge => edge.type === 'READS_FIELD' && edge.sourceId === handlerId && edge.targetId === requestFieldId));
  assert.ok(result.edges.some(edge => edge.type === 'WRITES_FIELD' && edge.sourceId === handlerId && edge.targetId === responseFieldId));
  assert.ok(result.edges.some(edge => edge.type === 'WRITES_FIELD' && edge.sourceId === endpointId && edge.targetId === requestFieldId && edge.reason.includes('request-field-closure')));
  assert.ok(result.edges.some(edge => edge.type === 'WRITES_FIELD' && edge.sourceId === endpointId && edge.targetId === responseFieldId && edge.reason.includes('response-field-closure')));
  assert.ok(result.edges.some(edge => edge.type === 'CALLS' && edge.sourceId === invalidatorId && edge.targetId === consumerId && edge.reason.includes('query-key-invalidation')));
  assert.ok(result.edges.some(edge => edge.type === 'CALLS' && edge.sourceId === endpointId && edge.targetId === listenerId && edge.reason.includes('event-chain')));
  assert.ok(result.edges.some(edge => edge.type === 'CALLS' && edge.sourceId === endpointId && edge.targetId === permissionId && edge.reason.includes('permission-closure')));

  assert.ok(result.stats.requestFieldReads >= 1);
  assert.ok(result.stats.responseFieldWrites >= 1);
  assert.ok(result.stats.queryInvalidationClosures >= 1);
});
