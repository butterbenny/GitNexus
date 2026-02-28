import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createKnowledgeGraph } from '../dist/core/graph/graph.js';
import { processGaps } from '../dist/core/ingestion/gap-processor.js';

test('Gap processor: emits deterministic, pattern, and heuristic gap tiers', async () => {
  const graph = createKnowledgeGraph();

  const sliceA = 'FeatureSlice:slice_endpoint_a';
  const sliceB = 'FeatureSlice:slice_endpoint_b';
  const sliceC = 'FeatureSlice:slice_endpoint_c';
  const sliceD = 'FeatureSlice:slice_query_d';

  const addSlice = (id, sliceType, closedSlots, anchorId) => {
    graph.addNode({
      id,
      label: 'FeatureSlice',
      properties: {
        name: id,
        filePath: '',
        heuristicLabel: id,
        sliceType,
        anchorId,
        anchorName: anchorId,
        closureSlots: sliceType === 'endpoint'
          ? ['anchor', 'entrypoint', 'handler', 'authorization']
          : ['anchor', 'query_consumer'],
        closedSlots,
        closureScore: 0.5,
      },
    });
  };

  addSlice(sliceA, 'endpoint', ['anchor', 'entrypoint', 'handler'], 'CodeElement:endpoint:get:/api/a');
  addSlice(sliceB, 'endpoint', ['anchor', 'entrypoint', 'handler', 'authorization'], 'CodeElement:endpoint:get:/api/b');
  addSlice(sliceC, 'endpoint', ['anchor', 'entrypoint', 'handler', 'authorization'], 'CodeElement:endpoint:get:/api/c');
  addSlice(sliceD, 'query_key', ['anchor', 'query_consumer'], 'Function:queryKeys.d');

  graph.addNode({
    id: 'Function:src/a.ts:A',
    label: 'Function',
    properties: { name: 'A', filePath: 'src/a.ts' },
  });
  graph.addNode({
    id: 'Function:tests/b.test.ts:B',
    label: 'Function',
    properties: { name: 'B', filePath: 'tests/b.test.ts' },
  });
  graph.addNode({
    id: 'Function:tests/c.test.ts:C',
    label: 'Function',
    properties: { name: 'C', filePath: 'tests/c.test.ts' },
  });

  graph.addRelationship({
    id: 'mem-a',
    type: 'MEMBER_OF',
    sourceId: 'Function:src/a.ts:A',
    targetId: sliceA,
    confidence: 1.0,
    reason: 'feature-slice:entrypoint',
  });
  graph.addRelationship({
    id: 'mem-b',
    type: 'MEMBER_OF',
    sourceId: 'Function:tests/b.test.ts:B',
    targetId: sliceB,
    confidence: 1.0,
    reason: 'feature-slice:entrypoint',
  });
  graph.addRelationship({
    id: 'mem-c',
    type: 'MEMBER_OF',
    sourceId: 'Function:tests/c.test.ts:C',
    targetId: sliceC,
    confidence: 1.0,
    reason: 'feature-slice:entrypoint',
  });

  const result = await processGaps(graph);
  assert.ok(result.stats.totalGaps >= 3);
  assert.ok(result.stats.deterministic >= 1);
  assert.ok(result.stats.pattern >= 1);
  assert.ok(result.stats.heuristic >= 1);

  const deterministicGap = result.gaps.find(gap => gap.absenceTier === 'deterministic_missing' && gap.sliceId === sliceA);
  assert.ok(deterministicGap);
  assert.ok(deterministicGap.missingSlots.includes('authorization'));

  const patternGap = result.gaps.find(gap => gap.absenceTier === 'pattern_missing' && gap.sliceId === sliceA);
  assert.ok(patternGap);
  assert.ok(patternGap.missingSlots.includes('tests'));

  const heuristicGap = result.gaps.find(gap => gap.absenceTier === 'heuristic_suspicion' && gap.sliceId === sliceD);
  assert.ok(heuristicGap);

  assert.ok(result.links.some(link => link.sliceId === sliceA));
});

test('Gap processor: graph expectation DSL emits rule-driven gaps', async () => {
  const graph = createKnowledgeGraph();

  const sliceMissing = 'FeatureSlice:slice_admin_missing';
  const sliceHealthy = 'FeatureSlice:slice_admin_healthy';
  const anchorMissing = 'CodeElement:endpoint:get:/admin/users';
  const anchorHealthy = 'CodeElement:endpoint:get:/admin/reports';
  const permissionNode = 'CodeElement:permission:admin.view';

  const addSlice = (id, anchorId, anchorName) => {
    graph.addNode({
      id,
      label: 'FeatureSlice',
      properties: {
        name: id,
        filePath: '',
        heuristicLabel: id,
        sliceType: 'endpoint',
        anchorId,
        anchorName,
        closureSlots: ['anchor', 'entrypoint', 'handler', 'authorization'],
        closedSlots: ['anchor', 'entrypoint', 'handler', 'authorization'],
        closureScore: 1,
      },
    });
  };

  addSlice(sliceMissing, anchorMissing, 'endpoint:get:/admin/users');
  addSlice(sliceHealthy, anchorHealthy, 'endpoint:get:/admin/reports');

  graph.addNode({
    id: anchorMissing,
    label: 'CodeElement',
    properties: { name: 'endpoint:get:/admin/users', filePath: '' },
  });
  graph.addNode({
    id: anchorHealthy,
    label: 'CodeElement',
    properties: { name: 'endpoint:get:/admin/reports', filePath: '' },
  });
  graph.addNode({
    id: permissionNode,
    label: 'CodeElement',
    properties: { name: 'permission:admin.view', filePath: '' },
  });
  graph.addNode({
    id: 'Function:src/admin/users.ts:loadUsers',
    label: 'Function',
    properties: { name: 'loadUsers', filePath: 'src/admin/users.ts' },
  });
  graph.addNode({
    id: 'Function:src/admin/reports.ts:loadReports',
    label: 'Function',
    properties: { name: 'loadReports', filePath: 'src/admin/reports.ts' },
  });

  graph.addRelationship({
    id: 'member-anchor-missing',
    type: 'MEMBER_OF',
    sourceId: anchorMissing,
    targetId: sliceMissing,
    confidence: 1,
    reason: 'feature-slice:anchor',
  });
  graph.addRelationship({
    id: 'member-entry-missing',
    type: 'MEMBER_OF',
    sourceId: 'Function:src/admin/users.ts:loadUsers',
    targetId: sliceMissing,
    confidence: 1,
    reason: 'feature-slice:entrypoint',
  });
  graph.addRelationship({
    id: 'member-anchor-healthy',
    type: 'MEMBER_OF',
    sourceId: anchorHealthy,
    targetId: sliceHealthy,
    confidence: 1,
    reason: 'feature-slice:anchor',
  });
  graph.addRelationship({
    id: 'member-entry-healthy',
    type: 'MEMBER_OF',
    sourceId: 'Function:src/admin/reports.ts:loadReports',
    targetId: sliceHealthy,
    confidence: 1,
    reason: 'feature-slice:entrypoint',
  });

  graph.addRelationship({
    id: 'healthy-permission-closure',
    type: 'CALLS',
    sourceId: anchorHealthy,
    targetId: permissionNode,
    confidence: 0.9,
    reason: 'micro-dataflow:permission-closure',
  });

  const expectationJson = JSON.stringify({
    version: 1,
    rules: [
      {
        id: 'admin_endpoints_require_permission_closure',
        scope: {
          sliceType: 'endpoint',
          anchorNameIncludes: ['/admin/'],
        },
        expectAll: [
          {
            kind: 'anchor_edge',
            type: 'CALLS',
            reasonStartsWith: 'micro-dataflow:permission-closure',
            counterpartLabel: 'CodeElement',
            counterpartNameStartsWith: 'permission:',
            missingSlot: 'permission_closure',
          },
        ],
        gapType: 'expectation_admin_permission_closure_missing',
        absenceTier: 'deterministic_missing',
        severity: 'high',
        evidence: ['policy:admin-auth'],
      },
    ],
  });

  const result = await processGaps(graph, undefined, { expectationJson });
  assert.equal(result.stats.expectation, 1);
  assert.equal(result.stats.expectationRulesEvaluated, 1);
  assert.equal(result.stats.expectationRuleApplications, 2);

  const expectationGap = result.gaps.find(gap => gap.gapType === 'expectation_admin_permission_closure_missing');
  assert.ok(expectationGap);
  assert.equal(expectationGap.sliceId, sliceMissing);
  assert.ok(expectationGap.missingSlots.includes('permission_closure'));
  assert.ok(expectationGap.evidence.includes('expectation:admin_endpoints_require_permission_closure'));
});

test('Gap processor: loads expectation rules from default repo file', async () => {
  const graph = createKnowledgeGraph();
  const sliceId = 'FeatureSlice:slice_file_rule';
  const anchorId = 'CodeElement:endpoint:get:/admin/audits';

  graph.addNode({
    id: sliceId,
    label: 'FeatureSlice',
    properties: {
      name: sliceId,
      filePath: '',
      heuristicLabel: sliceId,
      sliceType: 'endpoint',
      anchorId,
      anchorName: 'endpoint:get:/admin/audits',
      closureSlots: ['anchor', 'entrypoint', 'handler', 'authorization'],
      closedSlots: ['anchor', 'entrypoint', 'handler', 'authorization'],
      closureScore: 1,
    },
  });
  graph.addNode({
    id: anchorId,
    label: 'CodeElement',
    properties: { name: 'endpoint:get:/admin/audits', filePath: '' },
  });
  graph.addNode({
    id: 'Function:src/admin/audits.ts:auditsIndex',
    label: 'Function',
    properties: { name: 'auditsIndex', filePath: 'src/admin/audits.ts' },
  });

  graph.addRelationship({
    id: 'member-anchor-file',
    type: 'MEMBER_OF',
    sourceId: anchorId,
    targetId: sliceId,
    confidence: 1,
    reason: 'feature-slice:anchor',
  });
  graph.addRelationship({
    id: 'member-entry-file',
    type: 'MEMBER_OF',
    sourceId: 'Function:src/admin/audits.ts:auditsIndex',
    targetId: sliceId,
    confidence: 1,
    reason: 'feature-slice:entrypoint',
  });

  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-gap-'));
  try {
    const expectationsDir = path.join(tempRepo, '.gitnexus');
    await fs.mkdir(expectationsDir, { recursive: true });
    await fs.writeFile(path.join(expectationsDir, 'graph-expectations.json'), JSON.stringify({
      rules: [
        {
          id: 'admin_endpoint_requires_permission_edge',
          scope: { anchorNameIncludes: ['/admin/'] },
          expectAll: [{ kind: 'anchor_edge', type: 'CALLS', reasonStartsWith: 'micro-dataflow:permission-closure' }],
          gapType: 'expectation_admin_missing_permission_edge',
        },
      ],
    }));

    const result = await processGaps(graph, undefined, { repoPath: tempRepo });
    const expectationGap = result.gaps.find(gap => gap.gapType === 'expectation_admin_missing_permission_edge');
    assert.ok(expectationGap);
    assert.equal(expectationGap.sliceId, sliceId);
  } finally {
    await fs.rm(tempRepo, { recursive: true, force: true });
  }
});
