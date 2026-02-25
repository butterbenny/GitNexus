import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../dist/core/ingestion/pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixtureRepoPath = path.resolve(__dirname, '../../gitnexus-test-setup/fixture-laravel');

const getNodes = (graph, label, filePath) => {
  return graph.nodes.filter(n => {
    if (label && n.label !== label) return false;
    if (filePath && n.properties?.filePath !== filePath) return false;
    return true;
  });
};

test('Laravel Bus: chain and batch wire to job handlers', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const sendDigestHandle = getNodes(graph, 'Method', 'app/Jobs/SendDigestJob.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(sendDigestHandle);

  const cleanupHandle = getNodes(graph, 'Method', 'app/Jobs/CleanupJob.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(cleanupHandle);

  const busChainEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === cleanupHandle.id
      && r.reason === 'laravel-job-dispatch-bus-chain-import-resolved';
  });
  assert.equal(busChainEdges.length, 1);
  assert.ok(busChainEdges[0].confidence >= 0.9);

  const busChainEdges2 = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === sendDigestHandle.id
      && r.reason === 'laravel-job-dispatch-bus-chain-import-resolved';
  });
  assert.equal(busChainEdges2.length, 1);
  assert.ok(busChainEdges2[0].confidence >= 0.9);

  const busBatchEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === cleanupHandle.id
      && r.reason === 'laravel-job-dispatch-bus-batch-import-resolved';
  });
  assert.equal(busBatchEdges.length, 1);
  assert.ok(busBatchEdges[0].confidence >= 0.9);

  const busBatchEdges2 = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === sendDigestHandle.id
      && r.reason === 'laravel-job-dispatch-bus-batch-import-resolved';
  });
  assert.equal(busBatchEdges2.length, 1);
  assert.ok(busBatchEdges2[0].confidence >= 0.9);
});
