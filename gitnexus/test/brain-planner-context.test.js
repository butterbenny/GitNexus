import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { ContextCompiler } from '../dist/core/brain/context-compiler.js';
import { PlannerEngine } from '../dist/core/brain/planner.js';

test('Brain planner/context compiler: builds plan envelope and telemetry summary', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-brain-plan-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  await fs.mkdir(storagePath, { recursive: true });

  const input = {
    reason: 'analyze',
    repoPath,
    storagePath,
    repoFingerprint: 'head123',
    graphVersion: '1',
    changedPaths: ['gitnexus/src/cli/analyze.ts', 'gitnexus/src/mcp/resources.ts'],
    task: 'phase b planning',
  };

  const planner = new PlannerEngine();
  const plan = planner.plan(input);
  assert.equal(plan.mode, 'query');
  assert.equal(plan.contextShape, 'standard');
  assert.ok(plan.operators.length > 0);
  assert.ok(plan.requestedProbes.length > 0);

  const compiler = new ContextCompiler();
  const first = await compiler.compile(input, plan);
  assert.equal(first.telemetrySummary.totalRuns, 1);
  assert.ok(first.packet.anchors.length > 0);
  assert.ok(Array.isArray(first.packet.precedents) && first.packet.precedents.length > 0);
  assert.ok(first.packet.editBudget.preferredOrder.length > 0);
  assert.equal(first.packet.runtimeWitnesses.length, 0);
  assert.ok(
    !first.packet.proofPack.unresolved.includes('proof:runtime-witness'),
    'expected runtime witness proof to remain optional for query runs without runtime snapshot signals',
  );
  assert.equal(first.packet.riskProfile.level, 'medium');

  const second = await compiler.compile(input, plan);
  assert.equal(second.telemetrySummary.totalRuns, 2);
  assert.ok(second.telemetrySummary.averageUsefulRatio > 0);

  await fs.rm(tempRoot, { recursive: true, force: true });
});
