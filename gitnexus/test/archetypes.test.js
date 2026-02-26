import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../dist/core/ingestion/pipeline.js';
import {
  buildArchetypeReport,
  extractHttpEdgesFromGraph,
  extractProcessesFromGraph,
} from '../dist/core/derived/archetypes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixtureRepoPath = path.resolve(__dirname, '../../gitnexus-test-setup/fixture-laravel');

test('Archetypes: derives flow signatures from processes (incl HTTP wiring)', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const processes = extractProcessesFromGraph(graph);
  assert.ok(processes.length > 0);

  const httpEdges = extractHttpEdgesFromGraph(graph, 0.9);
  const report = buildArchetypeReport(processes, httpEdges, { limit: 50, examplesPerSignature: 2 });

  assert.ok(report.totalProcesses > 0);
  assert.ok(report.uniqueSignatures > 0);
  assert.ok(report.signatures.length > 0);

  const hasHttp = report.signatures.some(s => s.signature.includes('HTTP:'));
  assert.ok(hasHttp);

  const hasCrossStack = report.signatures.some(s => s.crossStack);
  assert.ok(hasCrossStack);
});

