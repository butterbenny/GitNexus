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

test('Laravel Tactician: dispatch wires to handler + middleware', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const runMethod = getNodes(graph, 'Method', 'app/Services/TacticianExampleService.php')
    .find(n => n.properties?.name === 'run');
  assert.ok(runMethod);

  const runFactoryMethod = getNodes(graph, 'Method', 'app/Services/TacticianExampleService.php')
    .find(n => n.properties?.name === 'runFactory');
  assert.ok(runFactoryMethod);

  const handlerHandle = getNodes(graph, 'Method', 'app/Handlers/ExampleHandler.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(handlerHandle);

  const middlewareExecute = getNodes(graph, 'Method', 'app/Http/Middleware/ExampleMiddleware.php')
    .find(n => n.properties?.name === 'execute');
  assert.ok(middlewareExecute);

  const handlerReason = 'laravel-tactician-dispatch:ExampleCommand:import-resolved';
  const middlewareReason = 'laravel-tactician-middleware:ExampleMiddleware:import-resolved';

  const runToHandler = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === runMethod.id
      && r.targetId === handlerHandle.id
      && r.reason === handlerReason;
  });
  assert.equal(runToHandler.length, 1);
  assert.ok(runToHandler[0].confidence >= 0.8);

  const factoryToHandler = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === runFactoryMethod.id
      && r.targetId === handlerHandle.id
      && r.reason === handlerReason;
  });
  assert.equal(factoryToHandler.length, 1);
  assert.ok(factoryToHandler[0].confidence >= 0.8);

  const runToMiddleware = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === runMethod.id
      && r.targetId === middlewareExecute.id
      && r.reason === middlewareReason;
  });
  assert.equal(runToMiddleware.length, 1);
  assert.ok(runToMiddleware[0].confidence >= 0.8);

  const factoryToMiddleware = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === runFactoryMethod.id
      && r.targetId === middlewareExecute.id
      && r.reason === middlewareReason;
  });
  assert.equal(factoryToMiddleware.length, 1);
  assert.ok(factoryToMiddleware[0].confidence >= 0.8);
});

