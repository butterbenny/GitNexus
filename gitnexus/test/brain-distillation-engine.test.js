import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compileConstraintGraph } from '../dist/core/brain/constraint-graph.js';
import { ContextCompiler } from '../dist/core/brain/context-compiler.js';
import { runDistillationEngine } from '../dist/core/brain/distillation-engine.js';
import { runEvalGraph } from '../dist/core/brain/eval-graph.js';
import { runExperienceGovernor } from '../dist/core/brain/experience-governor.js';
import { PlannerEngine } from '../dist/core/brain/planner.js';
import { compileRuntimeTruthGraph } from '../dist/core/brain/runtime-truth-graph.js';

test('DistillationEngine: updates planner bandit and emits selector summaries', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-distillation-engine-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  await fs.mkdir(storagePath, { recursive: true });

  await fs.writeFile(
    path.join(storagePath, 'runtime-observations.json'),
    JSON.stringify({
      request_spans: [
        {
          method: 'POST',
          route: '/api/distill',
          duration_ms: 210,
          status: 200,
          file_path_hints: ['src/distill/engine.ts'],
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
    repoFingerprint: 'distill123',
    graphVersion: '1',
    modeHint: 'implement',
    changedPaths: [
      'src/distill/engine.ts',
      'src/rankers/precedent.ts',
    ],
    task: 'phase g distillation engine',
  };

  const planner = new PlannerEngine();
  const plan = planner.plan(input);
  const runtimeTruth = await compileRuntimeTruthGraph(input, plan);
  const constraintGraph = await compileConstraintGraph(input, plan, runtimeTruth);
  const experienceGovernor = await runExperienceGovernor(input, plan, runtimeTruth);
  const compiler = new ContextCompiler();
  const compiled = await compiler.compile(input, plan, runtimeTruth, experienceGovernor, constraintGraph);
  const evalGraph = await runEvalGraph(
    input,
    plan,
    runtimeTruth,
    experienceGovernor,
    constraintGraph,
    compiled.packet,
    compiled.telemetryEntry,
    compiled.telemetrySummary,
  );

  const first = await runDistillationEngine(
    input,
    plan,
    runtimeTruth,
    experienceGovernor,
    constraintGraph,
    evalGraph,
    compiled.packet,
    compiled.telemetrySummary,
  );

  assert.equal(first.runCount, 1);
  assert.ok(first.plannerBandit.winningPolicy.length > 0);
  assert.ok(first.artifacts.rankers >= 2);
  assert.ok(first.promotion.rollbackReady);
  assert.ok(first.testSelector.candidateCount >= 0);
  assert.ok(first.precedentRanker.candidateCount >= 0);

  const second = await runDistillationEngine(
    input,
    plan,
    runtimeTruth,
    experienceGovernor,
    constraintGraph,
    evalGraph,
    compiled.packet,
    compiled.telemetrySummary,
  );
  assert.equal(second.runCount, 2);
  assert.ok(second.plannerBandit.policyArms.length >= 1);
  assert.ok(second.plannerBandit.expectedReward >= 0);
  assert.ok(second.plannerBandit.expectedReward <= 1);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('DistillationEngine: parity canary blockers prevent promotion eligibility', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-distillation-engine-parity-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  const manifestsPath = path.join(storagePath, 'manifests');
  await fs.mkdir(manifestsPath, { recursive: true });

  await fs.writeFile(
    path.join(storagePath, 'runtime-observations.json'),
    JSON.stringify({
      request_spans: [],
      db_queries: [],
      payload_shapes: [],
    }, null, 2),
    'utf-8',
  );

  await fs.writeFile(
    path.join(manifestsPath, 'brain.json'),
    JSON.stringify({
      schemaVersion: 1,
      v2Parity: {
        checks: [
          { id: 'implement-post-review-mandatory', status: 'missing' },
          { id: 'implement-auto-patch-guard-before-finalize', status: 'partial' },
        ],
      },
    }, null, 2),
    'utf-8',
  );

  const input = {
    reason: 'analyze',
    repoPath,
    storagePath,
    repoFingerprint: 'distill-parity',
    graphVersion: '1',
    modeHint: 'implement',
    changedPaths: ['src/parity.ts'],
    task: 'parity canary gate',
  };

  const planner = new PlannerEngine();
  const plan = planner.plan(input);
  const runtimeTruth = await compileRuntimeTruthGraph(input, plan);
  const constraintGraph = await compileConstraintGraph(input, plan, runtimeTruth);
  const experienceGovernor = await runExperienceGovernor(input, plan, runtimeTruth);
  const compiler = new ContextCompiler();
  const compiled = await compiler.compile(input, plan, runtimeTruth, experienceGovernor, constraintGraph);
  const evalGraph = await runEvalGraph(
    input,
    plan,
    runtimeTruth,
    experienceGovernor,
    constraintGraph,
    compiled.packet,
    compiled.telemetryEntry,
    compiled.telemetrySummary,
  );
  evalGraph.canaryHarness.promotionAllowed = true;

  const result = await runDistillationEngine(
    input,
    plan,
    runtimeTruth,
    experienceGovernor,
    constraintGraph,
    evalGraph,
    compiled.packet,
    compiled.telemetrySummary,
  );

  assert.equal(result.promotion.canaryEligible, false);
  assert.ok(
    result.warnings.some(item => String(item).includes('parity canary blocked')),
    'expected parity canary warning to block promotion eligibility',
  );

  await fs.rm(tempRoot, { recursive: true, force: true });
});
