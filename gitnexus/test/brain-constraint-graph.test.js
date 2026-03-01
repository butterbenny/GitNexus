import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PlannerEngine } from '../dist/core/brain/planner.js';
import { compileConstraintGraph } from '../dist/core/brain/constraint-graph.js';

test('ConstraintGraph: compiles family rules and patch-gate outcomes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-constraint-graph-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  await fs.mkdir(storagePath, { recursive: true });

  const input = {
    reason: 'analyze',
    repoPath,
    storagePath,
    repoFingerprint: 'constraint123',
    graphVersion: '1',
    modeHint: 'implement',
    changedPaths: [
      'src/admin/routes.ts',
      'src/admin/controllers/intent-update-controller.ts',
      'package.json',
    ],
  };

  const planner = new PlannerEngine();
  const plan = planner.plan(input);
  const constraintGraph = await compileConstraintGraph(input, plan);

  assert.ok(constraintGraph.catalog.totalRules >= 7);
  assert.ok(constraintGraph.catalog.byFamily.auth >= 1);
  assert.ok(constraintGraph.patchGate.checked >= 7);
  assert.ok(constraintGraph.patchGate.blocked >= 1);
  assert.ok(constraintGraph.patchGate.requestedRuntimeProbe >= 1);
  assert.ok(constraintGraph.patchGate.requestedTargetedTests >= 1);
  assert.ok(constraintGraph.violations.length >= 2);
  assert.ok(constraintGraph.requestedTests.length >= 1);

  await fs.rm(tempRoot, { recursive: true, force: true });
});
