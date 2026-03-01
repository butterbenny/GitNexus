import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PlannerEngine } from '../dist/core/brain/planner.js';
import { compileRuntimeTruthGraph } from '../dist/core/brain/runtime-truth-graph.js';

test('RuntimeTruthGraph: compiles probe plan, witnesses, and reconciliation summary', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-runtime-truth-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  await fs.mkdir(storagePath, { recursive: true });

  await fs.writeFile(
    path.join(storagePath, 'runtime-observations.json'),
    JSON.stringify({
      request_spans: [
        {
          method: 'GET',
          route: '/api/probe/matched',
          duration_ms: 320,
          status: 200,
          file_path_hints: ['src/app.ts'],
        },
        {
          method: 'GET',
          route: '/api/probe/error',
          duration_ms: 910,
          status: 503,
        },
      ],
      db_queries: [
        {
          sql: 'select * from jobs where id = ?',
          duration_ms: 440,
          lock_wait_ms: 1250,
        },
      ],
      payload_shapes: [
        {
          path: '/api/probe/matched',
          item_count: 2,
          bytes: 1400,
          file_path_hints: ['src/app.ts'],
        },
      ],
    }, null, 2),
    'utf-8',
  );

  const input = {
    reason: 'analyze',
    repoPath,
    storagePath,
    repoFingerprint: 'probe123',
    graphVersion: '1',
    changedPaths: ['src/app.ts'],
    modeHint: 'implement',
  };
  const planner = new PlannerEngine();
  const plan = planner.plan(input);
  const runtimeTruth = await compileRuntimeTruthGraph(input, plan);

  assert.ok(runtimeTruth.probePlan.length > 0);
  assert.ok(runtimeTruth.witnesses.length > 0);
  assert.ok(runtimeTruth.reconciliation.supportsStaticEdge >= 1);
  assert.ok(runtimeTruth.reconciliation.contradictsStaticExpectation >= 1);
  assert.equal(runtimeTruth.coverage.length, 1);
  assert.equal(runtimeTruth.snapshot.requestSpans, 2);

  await fs.rm(tempRoot, { recursive: true, force: true });
});
