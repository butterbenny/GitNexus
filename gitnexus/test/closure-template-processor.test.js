import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeGraph } from '../dist/core/graph/graph.js';
import { processClosureTemplates } from '../dist/core/ingestion/closure-template-processor.js';

test('Closure templates: derives slice-family expectations from feature slices', async () => {
  const graph = createKnowledgeGraph();

  const endpointSlices = [
    {
      id: 'FeatureSlice:endpoint:users_index',
      closureSlots: ['anchor', 'entrypoint', 'handler', 'authorization'],
      closedSlots: ['anchor', 'entrypoint', 'handler', 'authorization'],
      closureScore: 1,
    },
    {
      id: 'FeatureSlice:endpoint:users_show',
      closureSlots: ['anchor', 'entrypoint', 'handler', 'authorization'],
      closedSlots: ['anchor', 'entrypoint', 'handler'],
      closureScore: 0.75,
    },
    {
      id: 'FeatureSlice:endpoint:users_export',
      closureSlots: ['anchor', 'entrypoint', 'handler', 'authorization'],
      closedSlots: ['anchor', 'handler', 'authorization'],
      closureScore: 0.75,
    },
  ];

  const permissionSlices = [
    {
      id: 'FeatureSlice:permission:users_view',
      closureSlots: ['anchor', 'authorization_consumer'],
      closedSlots: ['anchor', 'authorization_consumer'],
      closureScore: 1,
    },
    {
      id: 'FeatureSlice:permission:users_edit',
      closureSlots: ['anchor', 'authorization_consumer'],
      closedSlots: ['anchor'],
      closureScore: 0.5,
    },
  ];

  for (const slice of [...endpointSlices, ...permissionSlices]) {
    const sliceType = slice.id.includes(':endpoint:') ? 'endpoint' : 'permission';
    graph.addNode({
      id: slice.id,
      label: 'FeatureSlice',
      properties: {
        name: slice.id,
        heuristicLabel: slice.id,
        filePath: '',
        sliceType,
        anchorId: `anchor:${slice.id}`,
        anchorName: `anchor:${slice.id}`,
        closureSlots: slice.closureSlots,
        closedSlots: slice.closedSlots,
        closureScore: slice.closureScore,
      },
    });
  }

  const addMembership = (sliceId, nodeId, role) => {
    graph.addRelationship({
      id: `${nodeId}->${sliceId}:${role}`,
      type: 'MEMBER_OF',
      sourceId: nodeId,
      targetId: sliceId,
      confidence: 1.0,
      reason: `feature-slice:${role}`,
    });
  };

  addMembership(endpointSlices[0].id, 'Method:UsersController:index', 'handler');
  addMembership(endpointSlices[0].id, 'Function:usersApi:list', 'entrypoint');
  addMembership(endpointSlices[0].id, 'CodeElement:permission:users.view', 'authorization');

  addMembership(endpointSlices[1].id, 'Method:UsersController:show', 'handler');
  addMembership(endpointSlices[1].id, 'Function:usersApi:get', 'entrypoint');

  addMembership(endpointSlices[2].id, 'Method:UsersController:export', 'handler');
  addMembership(endpointSlices[2].id, 'CodeElement:permission:users.export', 'authorization');

  addMembership(permissionSlices[0].id, 'Method:UsersPolicy:view', 'authorization_consumer');
  addMembership(permissionSlices[1].id, 'Method:UsersPolicy:edit', 'authorization_consumer');

  const snapshot = await processClosureTemplates(graph);

  assert.equal(snapshot.stats.totalTemplates, 2);
  assert.equal(snapshot.stats.totalSlices, 5);

  const endpointTemplate = snapshot.templates.find(template => template.sliceType === 'endpoint');
  assert.ok(endpointTemplate);
  assert.ok(endpointTemplate.requiredSlots.includes('anchor'));
  assert.ok(endpointTemplate.requiredSlots.includes('handler'));
  assert.ok(endpointTemplate.requiredSlots.includes('entrypoint'));
  assert.ok(endpointTemplate.requiredSlots.includes('authorization'));
  assert.ok(endpointTemplate.roleCoverage.some(item => item.role === 'handler'));
  assert.ok(endpointTemplate.exemplarSliceIds.length > 0);

  const permissionTemplate = snapshot.templates.find(template => template.sliceType === 'permission');
  assert.ok(permissionTemplate);
  assert.ok(permissionTemplate.requiredSlots.includes('anchor'));
  assert.ok(permissionTemplate.requiredSlots.includes('authorization_consumer'));
});
