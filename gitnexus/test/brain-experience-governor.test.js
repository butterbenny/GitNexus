import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PlannerEngine } from '../dist/core/brain/planner.js';
import { compileRuntimeTruthGraph } from '../dist/core/brain/runtime-truth-graph.js';
import { runExperienceGovernor } from '../dist/core/brain/experience-governor.js';

test('ExperienceGovernor: generates, retains, and retrieves compact cards', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-experience-governor-'));
  const repoPath = path.join(tempRoot, 'repo');
  const storagePath = path.join(repoPath, '.gitnexus');
  await fs.mkdir(storagePath, { recursive: true });

  await fs.writeFile(
    path.join(storagePath, 'runtime-observations.json'),
    JSON.stringify({
      request_spans: [
        { method: 'GET', route: '/api/cards', duration_ms: 180, status: 200, file_path_hints: ['src/cards.ts'] },
      ],
      db_queries: [
        { sql: 'select * from cards where id = ?', duration_ms: 90, file_path_hints: ['src/cards.ts'] },
      ],
      payload_shapes: [],
    }, null, 2),
    'utf-8',
  );

  const input = {
    reason: 'analyze',
    repoPath,
    storagePath,
    repoFingerprint: 'exp123',
    graphVersion: '1',
    modeHint: 'implement',
    changedPaths: ['src/cards.ts'],
  };

  const planner = new PlannerEngine();
  const plan = planner.plan(input);
  const runtimeTruth = await compileRuntimeTruthGraph(input, plan);
  const first = await runExperienceGovernor(input, plan, runtimeTruth);

  assert.ok(first.totals.cards > 0);
  assert.ok(first.retrievedCards.length > 0);
  assert.ok(first.taxonomy.runtime >= 1);

  const second = await runExperienceGovernor(input, plan, runtimeTruth);
  assert.ok(second.totals.cards >= first.totals.cards);
  assert.ok(second.stages.probe >= 1);

  await fs.rm(tempRoot, { recursive: true, force: true });
});
