import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { BrainKernel } from '../dist/core/brain/kernel.js';
import { loadBrainManifest } from '../dist/core/brain/manifest-store.js';

test('BrainKernel: tick writes a manifest with producer metadata', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-brain-kernel-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  await fs.mkdir(storagePath, { recursive: true });
  await fs.writeFile(
    path.join(storagePath, 'runtime-observations.json'),
    JSON.stringify({
      request_spans: [
        {
          method: 'POST',
          route: '/api/runtime/probe',
          duration_ms: 640,
          status: 200,
          file_path_hints: ['src/index.ts'],
        },
      ],
      db_queries: [
        {
          sql: 'select * from traces where id = ?',
          duration_ms: 120,
          rows_examined: 20,
          file_path_hints: ['src/index.ts'],
        },
      ],
      payload_shapes: [
        {
          path: '/api/runtime/probe',
          item_count: 4,
          bytes: 2200,
          keys: ['ok', 'count'],
          file_path_hints: ['src/index.ts'],
        },
      ],
    }, null, 2),
    'utf-8',
  );
  await fs.mkdir(path.join(storagePath, 'manifests'), { recursive: true });
  await fs.writeFile(
    path.join(storagePath, 'manifests', 'review-runtime-probes.json'),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-03-01T00:00:00.000Z',
      repoPath,
      runtimeSource: 'none',
      requestCount: 2,
      highPriorityCount: 1,
      triggers: [
        'missing-runtime-observation-snapshot',
        'no-suggested-tests-for-changed-symbols',
      ],
    }, null, 2),
    'utf-8',
  );

  const kernel = new BrainKernel();
  const result = await kernel.tick({
    reason: 'analyze',
    repoPath,
    storagePath,
    repoFingerprint: 'abc123',
    graphVersion: '1',
    changedPaths: ['src/index.ts'],
  });

  assert.equal(result.manifest.schemaVersion, 1);
  assert.ok(result.manifestPath.endsWith(path.join('manifests', 'brain.json')));
  assert.equal(result.manifest.tick.reason, 'analyze');
  assert.ok(result.manifest.activeProducerVersions['core-state']);
  assert.ok(result.planEnvelope);
  assert.equal(result.planEnvelope?.mode, 'query');
  assert.ok(result.brainPacket);
  assert.equal(result.brainPacket?.mode, 'query');
  assert.ok(result.contextTelemetry);
  assert.equal(result.contextTelemetry?.totalRuns, 1);
  assert.ok(result.runtimeTruth);
  assert.ok((result.runtimeTruth?.compressed?.witnessCards || 0) > 0);
  assert.ok(result.reviewRuntimeProbes);
  assert.equal(result.reviewRuntimeProbes?.requestCount, 2);
  assert.ok(result.experienceGovernor);
  assert.ok((result.experienceGovernor?.retrievedCards.length || 0) > 0);
  assert.ok(result.constraintGraph);
  assert.ok((result.constraintGraph?.catalog?.totalRules || 0) > 0);
  assert.ok(result.evalGraph);
  assert.ok((result.evalGraph?.canaryHarness?.runCount || 0) > 0);
  assert.ok(result.distillationEngine);
  assert.ok((result.distillationEngine?.runCount || 0) > 0);
  assert.ok(result.toolsmith);
  assert.ok((result.toolsmith?.runCount || 0) > 0);
  assert.ok(result.graphModelBridge);
  assert.ok((result.graphModelBridge?.packetCount || 0) > 0);
  assert.ok(result.graphModelBridge?.learned);
  assert.equal(result.graphModelBridge?.learned.mode, 'inactive');
  assert.ok(result.manifest.v2Parity, 'expected v2 parity summary');
  assert.equal(result.manifest.v2Parity?.overall?.total, 19);
  assert.ok(Array.isArray(result.manifest.v2Parity?.checks));
  assert.ok(result.manifest.v2Parity?.checks.some(check => check.id === 'implement-post-review-mandatory' && check.status === 'met'));
  assert.ok(result.manifest.v2Parity?.checks.some(check => check.id === 'implement-auto-patch-guard-before-finalize' && check.status === 'met'));
  assert.ok(result.manifest.v2Parity?.checks.some(check => check.id === 'review-micro-runtime-probes-on-uncertainty' && check.status === 'met'));
  assert.equal(result.manifest.reviewRuntimeProbes?.requestCount, 2);
  assert.equal(result.manifest.reviewRuntimeProbes?.highPriorityCount, 1);

  const persisted = await loadBrainManifest(storagePath);
  assert.ok(persisted);
  assert.equal(persisted?.repoFingerprint, 'abc123');
  assert.equal(persisted?.tick?.reason, 'analyze');
  assert.equal(persisted?.planner?.mode, 'query');
  assert.equal(persisted?.contextCompiler?.packetMode, 'query');
  assert.ok((persisted?.experienceGovernor?.cardCount || 0) > 0);
  assert.ok((persisted?.constraintGraph?.ruleCount || 0) > 0);
  assert.ok((persisted?.evalGraph?.canaryHarness?.runCount || 0) > 0);
  assert.ok((persisted?.distillationEngine?.runCount || 0) > 0);
  assert.ok((persisted?.toolsmith?.runCount || 0) > 0);
  assert.ok((persisted?.graphModelBridge?.packetCount || 0) > 0);
  assert.equal(persisted?.graphModelBridge?.learned?.mode, 'inactive');
  assert.ok((persisted?.runtimeTruth?.probeCount || 0) > 0);
  assert.equal(persisted?.reviewRuntimeProbes?.requestCount, 2);
  assert.equal(persisted?.reviewRuntimeProbes?.highPriorityCount, 1);
  assert.ok(persisted?.v2Parity);
  assert.equal(persisted?.v2Parity?.overall?.total, 19);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('BrainKernel: promoted planner policy from prior manifest is applied', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-brain-kernel-policy-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  const manifestPath = path.join(storagePath, 'manifests', 'brain.json');
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      distillationEngine: {
        plannerBandit: {
          winningPolicy: 'policy:query:deep:src/core',
        },
        promotion: {
          promoted: true,
        },
      },
    }, null, 2),
    'utf-8',
  );

  const kernel = new BrainKernel();
  const result = await kernel.tick({
    reason: 'analyze',
    repoPath,
    storagePath,
    repoFingerprint: 'policy123',
    graphVersion: '1',
    changedPaths: ['src/index.ts'],
  });

  assert.equal(result.manifest.plannerPolicyVersion, 'policy:query:deep:src/core');
  assert.equal(result.planEnvelope?.contextShape, 'deep');
  assert.ok(result.planEnvelope?.operators.some(op => op.name === 'retrieve_memory_cards'));

  await fs.rm(tempRoot, { recursive: true, force: true });
});
