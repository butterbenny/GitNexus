import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compileConstraintGraph } from '../dist/core/brain/constraint-graph.js';
import { ContextCompiler } from '../dist/core/brain/context-compiler.js';
import { runEvalGraph } from '../dist/core/brain/eval-graph.js';
import { PlannerEngine } from '../dist/core/brain/planner.js';
import { compileRuntimeTruthGraph } from '../dist/core/brain/runtime-truth-graph.js';

test('EvalGraph: mines tasks, gold context, and canary metrics', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-eval-graph-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  await fs.mkdir(storagePath, { recursive: true });

  await fs.writeFile(
    path.join(storagePath, 'runtime-observations.json'),
    JSON.stringify({
      request_spans: [
        {
          method: 'GET',
          route: '/api/eval/context',
          duration_ms: 180,
          status: 200,
          file_path_hints: ['src/eval/context.ts'],
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
    repoFingerprint: 'eval123',
    graphVersion: '1',
    modeHint: 'implement',
    changedPaths: [
      'src/eval/context.ts',
      'src/cache/query-key-factory.ts',
      'package.json',
    ],
    task: 'phase f eval graph',
  };

  const planner = new PlannerEngine();
  const plan = planner.plan(input);
  const runtimeTruth = await compileRuntimeTruthGraph(input, plan);
  const constraintGraph = await compileConstraintGraph(input, plan, runtimeTruth);
  const compiler = new ContextCompiler();
  const compiled = await compiler.compile(input, plan, runtimeTruth, undefined, constraintGraph);
  assert.equal(compiled.packet.proofPack.unresolved.length, 0, 'expected required proof objectives to resolve with runtime+constraint evidence');
  assert.equal(compiled.telemetryEntry.proofSufficiency, 1, 'expected proof sufficiency to be full when required objectives are resolved');
  const first = await runEvalGraph(
    input,
    plan,
    runtimeTruth,
    undefined,
    constraintGraph,
    compiled.packet,
    compiled.telemetryEntry,
    compiled.telemetrySummary,
  );

  assert.equal(first.taskMiner.mined, 1);
  assert.ok(first.taskMiner.total >= 1);
  assert.equal(first.goldContextMiner.mined, 1);
  assert.ok(first.canaryHarness.runCount >= 1);
  assert.ok(first.canaryHarness.lastScore >= 0);
  assert.ok(first.dashboardMetrics.retrieval.proofSufficiency >= 0);
  if ((constraintGraph?.violations || []).length === 0) {
    assert.equal(
      Number(first.dashboardMetrics.review.gapSeverityCalibration || 0),
      1,
      'expected no-signal review severity calibration to resolve as fully calibrated when constraint coverage exists',
    );
  }
  assert.ok(first.latestTask);
  assert.ok(first.latestGoldContext);
  assert.ok(first.latestCanary);

  const second = await runEvalGraph(
    input,
    plan,
    runtimeTruth,
    undefined,
    constraintGraph,
    compiled.packet,
    compiled.telemetryEntry,
    compiled.telemetrySummary,
  );
  assert.ok(second.canaryHarness.runCount >= first.canaryHarness.runCount);
  assert.ok(second.taskMiner.total >= first.taskMiner.total);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('EvalGraph: promotion can recover via consecutive passing canaries', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-eval-graph-recovery-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  const manifestsPath = path.join(storagePath, 'manifests');
  await fs.mkdir(manifestsPath, { recursive: true });

  await fs.writeFile(
    path.join(storagePath, 'runtime-observations.json'),
    JSON.stringify({
      request_spans: [
        {
          method: 'GET',
          route: '/api/eval/recovery',
          duration_ms: 120,
          status: 200,
          file_path_hints: ['src/eval/recovery.ts'],
        },
      ],
      db_queries: [],
      payload_shapes: [],
    }, null, 2),
    'utf-8',
  );

  const oldCanaryRuns = [];
  for (let index = 0; index < 7; index += 1) {
    oldCanaryRuns.push({
      id: `old-fail-${index}`,
      taskId: `task-old-fail-${index}`,
      family: 'feature-addition',
      score: 60,
      passed: false,
      metrics: {
        goldContextRecall: 0.4,
        goldContextPrecision: 0.5,
        proofSufficiency: 0.4,
        filesOpenedPerSolvedTask: 9,
        tokensPerUsefulArtifact: 720,
      },
      regressionsDetected: 0,
      createdAt: `2026-02-28T00:0${index}:00.000Z`,
    });
  }
  oldCanaryRuns.push({
    id: 'old-pass-1',
    taskId: 'task-old-pass-1',
    family: 'feature-addition',
    score: 82,
    passed: true,
    metrics: {
      goldContextRecall: 0.7,
      goldContextPrecision: 0.85,
      proofSufficiency: 0.8,
      filesOpenedPerSolvedTask: 6,
      tokensPerUsefulArtifact: 240,
    },
    regressionsDetected: 0,
    createdAt: '2026-02-28T00:08:00.000Z',
  });
  oldCanaryRuns.push({
    id: 'old-pass-2',
    taskId: 'task-old-pass-2',
    family: 'feature-addition',
    score: 83,
    passed: true,
    metrics: {
      goldContextRecall: 0.72,
      goldContextPrecision: 0.86,
      proofSufficiency: 0.82,
      filesOpenedPerSolvedTask: 6,
      tokensPerUsefulArtifact: 220,
    },
    regressionsDetected: 0,
    createdAt: '2026-02-28T00:09:00.000Z',
  });

  await fs.writeFile(
    path.join(manifestsPath, 'eval-graph.json'),
    JSON.stringify({
      schemaVersion: 1,
      tasks: [],
      goldContexts: [],
      canaryRuns: oldCanaryRuns,
      regressions: [],
    }, null, 2),
    'utf-8',
  );

  const input = {
    reason: 'analyze',
    repoPath,
    storagePath,
    repoFingerprint: 'eval-recovery',
    graphVersion: '1',
    modeHint: 'implement',
    changedPaths: ['src/eval/recovery.ts'],
    task: 'phase f recovery canary',
  };

  const planner = new PlannerEngine();
  const plan = planner.plan(input);
  const runtimeTruth = await compileRuntimeTruthGraph(input, plan);
  const constraintGraph = await compileConstraintGraph(input, plan, runtimeTruth);
  const compiler = new ContextCompiler();
  const compiled = await compiler.compile(input, plan, runtimeTruth, undefined, constraintGraph);
  const result = await runEvalGraph(
    input,
    plan,
    runtimeTruth,
    undefined,
    constraintGraph,
    compiled.packet,
    compiled.telemetryEntry,
    compiled.telemetrySummary,
  );

  assert.ok(result.latestCanary?.passed, 'expected latest canary run to pass strict gates');
  assert.ok(Number(result.canaryHarness?.passRate || 0) < 0.8, 'expected recent pass rate to remain below strict threshold');
  assert.equal(result.canaryHarness?.promotionAllowed, true);

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('EvalGraph: dashboard metrics prioritize recent canary window', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-eval-graph-dashboard-window-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  const manifestsPath = path.join(storagePath, 'manifests');
  await fs.mkdir(manifestsPath, { recursive: true });

  await fs.writeFile(
    path.join(storagePath, 'runtime-observations.json'),
    JSON.stringify({
      request_spans: [
        {
          method: 'GET',
          route: '/api/eval/window',
          duration_ms: 90,
          status: 200,
          file_path_hints: ['src/eval/window.ts'],
        },
      ],
      db_queries: [],
      payload_shapes: [],
    }, null, 2),
    'utf-8',
  );

  const canaryRuns = [];
  for (let index = 0; index < 20; index += 1) {
    const recent = index >= 10;
    canaryRuns.push({
      id: `window-run-${index}`,
      taskId: `window-task-${index}`,
      family: 'feature-addition',
      score: recent ? 85 : 55,
      passed: recent,
      metrics: {
        goldContextRecall: recent ? 1 : 0,
        goldContextPrecision: 1,
        proofSufficiency: recent ? 1 : 0,
        filesOpenedPerSolvedTask: recent ? 4 : 10,
        tokensPerUsefulArtifact: recent ? 140 : 900,
      },
      regressionsDetected: 0,
      createdAt: `2026-02-28T01:${String(index).padStart(2, '0')}:00.000Z`,
    });
  }

  await fs.writeFile(
    path.join(manifestsPath, 'eval-graph.json'),
    JSON.stringify({
      schemaVersion: 1,
      tasks: [],
      goldContexts: [],
      canaryRuns,
      regressions: [],
    }, null, 2),
    'utf-8',
  );

  const input = {
    reason: 'analyze',
    repoPath,
    storagePath,
    repoFingerprint: 'eval-dashboard-window',
    graphVersion: '1',
    modeHint: 'implement',
    changedPaths: ['src/eval/window.ts'],
    task: 'phase f dashboard window',
  };

  const planner = new PlannerEngine();
  const plan = planner.plan(input);
  const runtimeTruth = await compileRuntimeTruthGraph(input, plan);
  const constraintGraph = await compileConstraintGraph(input, plan, runtimeTruth);
  const compiler = new ContextCompiler();
  const compiled = await compiler.compile(input, plan, runtimeTruth, undefined, constraintGraph);
  const result = await runEvalGraph(
    input,
    plan,
    runtimeTruth,
    undefined,
    constraintGraph,
    compiled.packet,
    compiled.telemetryEntry,
    compiled.telemetrySummary,
  );

  assert.ok(
    Number(result.dashboardMetrics?.retrieval?.goldContextRecall || 0) > 0.9,
    'expected retrieval recall to be driven by recent canary window, not full historical runs',
  );
  assert.ok(
    Number(result.dashboardMetrics?.implement?.companionEditRecall || 0) > 0.9,
    'expected implement companion recall to follow recent retrieval recall',
  );
  assert.equal(result.baselines?.source, 'historical-window');
  assert.ok(
    Number(result.baselines?.v1MedianTokensPerUsefulArtifact || 0) >= 800,
    'expected historical baseline median to be derived from early-window canaries',
  );
  assert.ok(Number(result.baselines?.sampleCount || 0) >= 12);

  await fs.rm(tempRoot, { recursive: true, force: true });
});
