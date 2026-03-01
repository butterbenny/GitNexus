import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compileConstraintGraph } from '../dist/core/brain/constraint-graph.js';
import { ContextCompiler } from '../dist/core/brain/context-compiler.js';
import { runGraphModelBridge } from '../dist/core/brain/graph-model-bridge.js';
import { PlannerEngine } from '../dist/core/brain/planner.js';
import { compileRuntimeTruthGraph } from '../dist/core/brain/runtime-truth-graph.js';

test('GraphModelBridge: writes bridge packets with proof hashes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-graph-bridge-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  await fs.mkdir(storagePath, { recursive: true });

  await fs.writeFile(
    path.join(storagePath, 'runtime-observations.json'),
    JSON.stringify({
      request_spans: [
        {
          method: 'PATCH',
          route: '/api/bridge',
          duration_ms: 210,
          status: 200,
          file_path_hints: ['src/bridge/index.ts'],
        },
      ],
      db_queries: [],
      payload_shapes: [],
    }, null, 2),
    'utf-8',
  );

  const input = {
    reason: 'analyze',
    repoPath,
    storagePath,
    repoFingerprint: 'bridge123',
    graphVersion: '1',
    task: 'phase i bridge',
    modeHint: 'implement',
    changedPaths: ['src/bridge/index.ts'],
  };

  const planner = new PlannerEngine();
  const plan = planner.plan(input);
  const runtimeTruth = await compileRuntimeTruthGraph(input, plan);
  const constraintGraph = await compileConstraintGraph(input, plan, runtimeTruth);
  const compiler = new ContextCompiler();
  const compiled = await compiler.compile(input, plan, runtimeTruth, undefined, constraintGraph);

  const first = await runGraphModelBridge(input, plan, compiled.packet, constraintGraph);
  assert.equal(first.runCount, 1);
  assert.ok(first.packetCount >= 1);
  assert.ok(first.latestPackets.length >= 1);
  assert.equal(first.promotion.symbolicEnabled, true);
  assert.equal(first.learned.mode, 'inactive');
  assert.ok(first.learned.modelPath.endsWith(path.join('manifests', 'bridge-learned-model.json')));
  assert.equal(first.learned.shadowPredictions.length, 0);
  assert.ok(first.latestPackets[0].proofHashes.length > 0);
  assert.ok(first.coverage.proofBacked >= 1);

  const storeRaw = await fs.readFile(first.storePath, 'utf-8');
  const store = JSON.parse(storeRaw);
  assert.equal(store.schemaVersion, 1);
  assert.equal(store.runCount, 1);
  assert.ok(Array.isArray(store.packets));
  assert.ok(store.packets.length >= 1);

  const second = await runGraphModelBridge(input, plan, compiled.packet, constraintGraph);
  assert.equal(second.runCount, 2);
  assert.equal(second.promotion.learnedCandidateReady, false);
  assert.equal(second.learned.mode, 'inactive');

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('GraphModelBridge: trains learned shadow model once bridge packet coverage is sufficient', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-graph-bridge-learned-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  await fs.mkdir(storagePath, { recursive: true });

  const input = {
    reason: 'analyze',
    repoPath,
    storagePath,
    repoFingerprint: 'bridge-learned',
    graphVersion: '1',
    task: 'phase i learned bridge',
    modeHint: 'implement',
    changedPaths: ['src/bridge/index.ts'],
  };

  const planner = new PlannerEngine();
  const plan = planner.plan(input);
  const runtimeTruth = await compileRuntimeTruthGraph(input, plan);
  const constraintGraph = await compileConstraintGraph(input, plan, runtimeTruth);
  const compiler = new ContextCompiler();
  const compiled = await compiler.compile(input, plan, runtimeTruth, undefined, constraintGraph);

  let finalResult = null;
  let lastPacket = null;
  for (let i = 0; i < 22; i += 1) {
    const packet = {
      ...compiled.packet,
      primarySlices: [
        {
          id: `slice:learned:${i}`,
          label: `Learned Slice ${i}`,
          confidence: 0.9,
        },
      ],
      proofPack: {
        ...compiled.packet.proofPack,
        objectives: (compiled.packet.proofPack.objectives || []).map((objective, index) => ({
          ...objective,
          id: `${objective.id}:learned:${i}:${index}`,
        })),
      },
    };
    lastPacket = packet;
    finalResult = await runGraphModelBridge(input, plan, packet, constraintGraph);
  }

  assert.ok(finalResult);
  assert.equal(finalResult.promotion.learnedCandidateReady, true);
  assert.equal(finalResult.learned.mode, 'shadow');
  assert.ok(finalResult.learned.trainingPacketCount >= 20);
  assert.ok(finalResult.learned.shadowPredictions.length >= 1);
  assert.ok(finalResult.learned.averageConfidence > 0);
  assert.ok(finalResult.learned.modelPath.endsWith(path.join('manifests', 'bridge-learned-model.json')));
  assert.equal(finalResult.latestPackets.length, 8);
  for (let i = 1; i < finalResult.latestPackets.length; i += 1) {
    assert.ok(finalResult.latestPackets[i - 1].createdAt >= finalResult.latestPackets[i].createdAt);
  }

  const modelRaw = await fs.readFile(finalResult.learned.modelPath, 'utf-8');
  const model = JSON.parse(modelRaw);
  assert.equal(model.schemaVersion, 1);
  assert.equal(model.modelVersion, 'shadow-v1');
  assert.ok(model.packetCount >= 20);
  assert.ok(Array.isArray(model.sliceProfiles));
  assert.ok(model.sliceProfiles.length >= 1);

  const stable = await runGraphModelBridge(input, plan, lastPacket, constraintGraph);
  assert.equal(stable.learned.mode, 'shadow');
  assert.equal(stable.learned.trainedAt, finalResult.learned.trainedAt);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('GraphModelBridge: emits fallback warning when BrainPacket is unavailable', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-graph-bridge-fallback-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  await fs.mkdir(storagePath, { recursive: true });

  const input = {
    reason: 'refresh',
    repoPath,
    storagePath,
    repoFingerprint: 'bridge-fallback',
    graphVersion: '1',
    changedPaths: [],
  };
  const plan = new PlannerEngine().plan(input);
  const result = await runGraphModelBridge(input, plan);

  assert.equal(result.runCount, 1);
  assert.ok(result.warnings.some(item => item.includes('without BrainPacket')));

  await fs.rm(tempRoot, { recursive: true, force: true });
});
