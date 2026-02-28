import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeGraph } from '../dist/core/graph/graph.js';
import { processProvenanceEdges } from '../dist/core/ingestion/provenance-processor.js';

test('Provenance: materializes derived artifact ancestry edges', async () => {
  const graph = createKnowledgeGraph();

  const routeFileId = 'File:routes/web.php';
  const endpointId = 'CodeElement:endpoint:get:/api/users/*';
  const handlerId = 'Method:app/Http/Controllers/UsersController.php:index';
  const permissionId = 'CodeElement:permission:users.view';
  const enumCaseId = 'Const:app/Domains/Permissions/UserPermission.php:VIEW';
  const roleNodeId = 'CodeElement:config/permissions.php:role:admin';
  const templateId = 'Template:resources/views/users/index.blade.php';

  graph.addNode({
    id: routeFileId,
    label: 'File',
    properties: { name: 'web.php', filePath: 'routes/web.php' },
  });
  graph.addNode({
    id: 'File:config/permissions.php',
    label: 'File',
    properties: { name: 'permissions.php', filePath: 'config/permissions.php' },
  });
  graph.addNode({
    id: endpointId,
    label: 'CodeElement',
    properties: { name: 'endpoint:get:/api/users/*', filePath: 'routes/web.php' },
  });
  graph.addNode({
    id: handlerId,
    label: 'Method',
    properties: { name: 'index', filePath: 'app/Http/Controllers/UsersController.php', startLine: 10, endLine: 35 },
  });
  graph.addNode({
    id: permissionId,
    label: 'CodeElement',
    properties: { name: 'permission:users.view', filePath: 'app/Domains/Permissions/UserPermission.php' },
  });
  graph.addNode({
    id: enumCaseId,
    label: 'Const',
    properties: { name: 'VIEW', filePath: 'app/Domains/Permissions/UserPermission.php' },
  });
  graph.addNode({
    id: roleNodeId,
    label: 'CodeElement',
    properties: { name: 'role:admin', filePath: 'config/permissions.php' },
  });
  graph.addNode({
    id: templateId,
    label: 'Template',
    properties: { name: 'users.index', filePath: 'resources/views/users/index.blade.php' },
  });
  graph.addNode({
    id: 'File:resources/views/users/index.blade.php',
    label: 'File',
    properties: { name: 'index.blade.php', filePath: 'resources/views/users/index.blade.php' },
  });

  graph.addRelationship({
    id: 'endpoint-handler',
    type: 'CALLS',
    sourceId: endpointId,
    targetId: handlerId,
    confidence: 0.95,
    reason: 'laravel-endpoint:get:/api/users/*:import-resolved',
  });
  graph.addRelationship({
    id: 'enum-slug',
    type: 'CALLS',
    sourceId: enumCaseId,
    targetId: permissionId,
    confidence: 1.0,
    reason: 'laravel-permission-slug:users.view',
  });
  graph.addRelationship({
    id: 'role-slug',
    type: 'CALLS',
    sourceId: roleNodeId,
    targetId: permissionId,
    confidence: 0.95,
    reason: 'laravel-role-permission-slug:users.view',
  });
  graph.addRelationship({
    id: 'middleware-auth',
    type: 'CALLS',
    sourceId: endpointId,
    targetId: permissionId,
    confidence: 0.94,
    reason: 'laravel-can:endpoint-middleware:can:users.view',
  });

  const result = await processProvenanceEdges(graph);

  assert.ok(result.stats.emittedEdges >= 6);
  assert.ok(result.stats.routeExpansionEdges >= 2);
  assert.ok(result.stats.enumToSlugEdges >= 1);
  assert.ok(result.stats.configDrivenEdges >= 1);
  assert.ok(result.stats.compiledArtifactEdges >= 1);
  assert.ok(result.stats.frameworkDerivedEdges >= 1);

  assert.ok(result.edges.some(edge => edge.type === 'DERIVES_FROM' && edge.sourceId === endpointId && edge.targetId === routeFileId && edge.reason.includes('route-expansion.file')));
  assert.ok(result.edges.some(edge => edge.type === 'DERIVES_FROM' && edge.sourceId === endpointId && edge.targetId === handlerId && edge.reason.includes('route-expansion.handler')));
  assert.ok(result.edges.some(edge => edge.type === 'DERIVES_FROM' && edge.sourceId === endpointId && edge.targetId === permissionId && edge.reason.includes('framework-middleware.permission')));
  assert.ok(result.edges.some(edge => edge.type === 'DERIVES_FROM' && edge.sourceId === permissionId && edge.targetId === enumCaseId && edge.reason.includes('enum-to-slug')));
  assert.ok(result.edges.some(edge => edge.type === 'DERIVES_FROM' && edge.sourceId === permissionId && edge.targetId === roleNodeId && edge.reason.includes('config-driven.role-slug')));
  assert.ok(result.edges.some(edge => edge.type === 'DERIVES_FROM' && edge.sourceId === roleNodeId && edge.targetId === 'File:config/permissions.php' && edge.reason.includes('config-driven.role')));
  assert.ok(result.edges.some(edge => edge.type === 'DERIVES_FROM' && edge.sourceId === templateId && edge.targetId === 'File:resources/views/users/index.blade.php' && edge.reason.includes('compiled-template.file')));
});
