import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compileConstraintGraph } from '../dist/core/brain/constraint-graph.js';
import { ContextCompiler } from '../dist/core/brain/context-compiler.js';
import { runEvalGraph } from '../dist/core/brain/eval-graph.js';
import { runToolsmith } from '../dist/core/brain/toolsmith.js';
import { PlannerEngine } from '../dist/core/brain/planner.js';
import { compileRuntimeTruthGraph } from '../dist/core/brain/runtime-truth-graph.js';

test('Toolsmith: mines operator sequences and applies promotion guardrails', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-toolsmith-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  await fs.mkdir(storagePath, { recursive: true });

  await fs.writeFile(
    path.join(storagePath, 'runtime-observations.json'),
    JSON.stringify({
      request_spans: [
        {
          method: 'PATCH',
          route: '/api/toolsmith',
          duration_ms: 190,
          status: 200,
          file_path_hints: ['src/toolsmith/engine.ts'],
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
    repoFingerprint: 'toolsmith123',
    graphVersion: '1',
    modeHint: 'implement',
    changedPaths: [
      'src/toolsmith/engine.ts',
      'src/toolsmith/operator.ts',
    ],
    task: 'phase h toolsmith',
  };

  const planner = new PlannerEngine();
  const plan = planner.plan(input);
  const runtimeTruth = await compileRuntimeTruthGraph(input, plan);
  const constraintGraph = await compileConstraintGraph(input, plan, runtimeTruth);
  const compiler = new ContextCompiler();
  const compiled = await compiler.compile(input, plan, runtimeTruth, undefined, constraintGraph);
  const evalGraph = await runEvalGraph(
    input,
    plan,
    runtimeTruth,
    undefined,
    constraintGraph,
    compiled.packet,
    compiled.telemetryEntry,
    compiled.telemetrySummary,
  );

  const first = await runToolsmith(
    input,
    plan,
    evalGraph,
    constraintGraph,
    compiled.packet,
  );
  assert.equal(first.runCount, 1);
  assert.ok(first.miner.sequenceCount >= 1);
  assert.ok(first.synthesis.candidatesGenerated >= 1);
  assert.ok(first.synthesis.typedOperators >= 1);
  assert.ok(first.latestOperators.length >= 1);
  assert.equal(first.latestOperators[0].rollbackReady, true);

  const second = await runToolsmith(
    input,
    plan,
    evalGraph,
    constraintGraph,
    compiled.packet,
  );
  assert.equal(second.runCount, 2);
  assert.ok(second.promotion.eligible >= 0);
  assert.ok(typeof second.promotion.guardrails.evalCanary === 'boolean');

  await fs.rm(tempRoot, { recursive: true, force: true });
});
