import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../dist/core/ingestion/pipeline.js';

const getNodes = (graph, label, filePath) => {
  return graph.nodes.filter(n => {
    if (label && n.label !== label) return false;
    if (filePath && n.properties?.filePath !== filePath) return false;
    return true;
  });
};

const traceHasSequence = (trace, seq) => {
  if (!Array.isArray(trace) || !Array.isArray(seq) || seq.length === 0) return false;
  let last = -1;
  for (const id of seq) {
    const idx = trace.indexOf(id, last + 1);
    if (idx === -1) return false;
    last = idx;
  }
  return true;
};

const getProcessTraces = (graph) => {
  const processIds = new Set(getNodes(graph, 'Process').map(p => p.id));
  const steps = graph.relationships
    .filter(r => r.type === 'STEP_IN_PROCESS' && processIds.has(r.targetId))
    .map(r => ({ processId: r.targetId, nodeId: r.sourceId, step: r.step || 0 }));

  const byProcess = new Map();
  for (const s of steps) {
    const list = byProcess.get(s.processId) || [];
    list.push(s);
    byProcess.set(s.processId, list);
  }

  const traces = [];
  for (const [processId, list] of byProcess.entries()) {
    list.sort((a, b) => a.step - b.step);
    traces.push({ processId, trace: list.map(x => x.nodeId) });
  }
  return traces;
};

test('Processes: Bus::chain yields a coherent job pipeline trace (job1→job2)', async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-proc-job-chain-'));

  try {
    await fs.mkdir(path.join(repoPath, 'app/Jobs'), { recursive: true });
    await fs.mkdir(path.join(repoPath, 'app/Services'), { recursive: true });

    await fs.writeFile(
      path.join(repoPath, 'app/Jobs/CleanupJob.php'),
      [
        '<?php',
        '',
        'namespace App\\Jobs;',
        '',
        'class CleanupJob {',
        '  public function handle(): void {}',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    await fs.writeFile(
      path.join(repoPath, 'app/Jobs/SendDigestJob.php'),
      [
        '<?php',
        '',
        'namespace App\\Jobs;',
        '',
        'class SendDigestJob {',
        '  public function handle(): void {}',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    await fs.writeFile(
      path.join(repoPath, 'app/Services/ExampleService.php'),
      [
        '<?php',
        '',
        'namespace App\\Services;',
        '',
        'use Illuminate\\Support\\Facades\\Bus;',
        'use App\\Jobs\\CleanupJob;',
        'use App\\Jobs\\SendDigestJob;',
        '',
        'class ExampleService {',
        '  public function run(): void {',
        '    Bus::chain([',
        '      new CleanupJob(),',
        '      new SendDigestJob(),',
        '    ])->dispatch();',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    const { graph } = await runPipelineFromRepo(repoPath, () => {});

    const runMethod = getNodes(graph, 'Method', 'app/Services/ExampleService.php')
      .find(n => n.properties?.name === 'run');
    assert.ok(runMethod);

    const cleanupHandle = getNodes(graph, 'Method', 'app/Jobs/CleanupJob.php')
      .find(n => n.properties?.name === 'handle');
    assert.ok(cleanupHandle);

    const sendDigestHandle = getNodes(graph, 'Method', 'app/Jobs/SendDigestJob.php')
      .find(n => n.properties?.name === 'handle');
    assert.ok(sendDigestHandle);

    const chainEdges = graph.relationships.filter(r => {
      return r.type === 'CALLS'
        && r.sourceId === cleanupHandle.id
        && r.targetId === sendDigestHandle.id
        && r.reason === 'laravel-job-chain:bus-chain';
    });
    assert.equal(chainEdges.length, 1);
    assert.ok(chainEdges[0].confidence >= 0.85);

    const traces = getProcessTraces(graph);
    assert.ok(traces.length > 0);
    assert.ok(traces.some(p => traceHasSequence(p.trace, [runMethod.id, cleanupHandle.id, sendDigestHandle.id])));
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
});

test('Processes: Tactician dispatch yields coherent middleware→handler pipeline trace', async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-proc-tactician-'));

  try {
    await fs.mkdir(path.join(repoPath, 'app/Commands'), { recursive: true });
    await fs.mkdir(path.join(repoPath, 'app/Handlers'), { recursive: true });
    await fs.mkdir(path.join(repoPath, 'app/Http/Middleware'), { recursive: true });
    await fs.mkdir(path.join(repoPath, 'app/Services'), { recursive: true });

    await fs.writeFile(
      path.join(repoPath, 'app/Commands/ExampleCommand.php'),
      [
        '<?php',
        '',
        'namespace App\\Commands;',
        '',
        'class ExampleCommand {',
        '  public static function make(): self { return new self(); }',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    await fs.writeFile(
      path.join(repoPath, 'app/Handlers/ExampleHandler.php'),
      [
        '<?php',
        '',
        'namespace App\\Handlers;',
        '',
        'use App\\Commands\\ExampleCommand;',
        '',
        'class ExampleHandler {',
        '  public function handle(ExampleCommand $command): void {}',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    await fs.writeFile(
      path.join(repoPath, 'app/Http/Middleware/ExampleMiddleware.php'),
      [
        '<?php',
        '',
        'namespace App\\Http\\Middleware;',
        '',
        'class ExampleMiddleware {',
        '  public function execute($command, callable $next) { return $next($command); }',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    await fs.writeFile(
      path.join(repoPath, 'app/Services/TacticianExampleService.php'),
      [
        '<?php',
        '',
        'namespace App\\Services;',
        '',
        'use App\\Commands\\ExampleCommand;',
        'use App\\Handlers\\ExampleHandler;',
        'use App\\Http\\Middleware\\ExampleMiddleware;',
        '',
        'class TacticianExampleService {',
        '  public function __construct(private $bus) {',
        '    $this->bus->addHandler(ExampleCommand::class, ExampleHandler::class);',
        '  }',
        '',
        '  public function run(): void {',
        '    $this->bus->dispatch(new ExampleCommand(), [], [ExampleMiddleware::class]);',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    const { graph } = await runPipelineFromRepo(repoPath, () => {});

    const runMethod = getNodes(graph, 'Method', 'app/Services/TacticianExampleService.php')
      .find(n => n.properties?.name === 'run');
    assert.ok(runMethod);

    const middlewareExecute = getNodes(graph, 'Method', 'app/Http/Middleware/ExampleMiddleware.php')
      .find(n => n.properties?.name === 'execute');
    assert.ok(middlewareExecute);

    const handlerHandle = getNodes(graph, 'Method', 'app/Handlers/ExampleHandler.php')
      .find(n => n.properties?.name === 'handle');
    assert.ok(handlerHandle);

    const pipelineEdges = graph.relationships.filter(r => {
      return r.type === 'CALLS'
        && r.sourceId === middlewareExecute.id
        && r.targetId === handlerHandle.id
        && r.reason === 'laravel-tactician-pipeline:ExampleCommand:middleware-to-handler';
    });
    assert.equal(pipelineEdges.length, 1);
    assert.ok(pipelineEdges[0].confidence >= 0.85);

    const traces = getProcessTraces(graph);
    assert.ok(traces.length > 0);
    assert.ok(traces.some(p => traceHasSequence(p.trace, [runMethod.id, middlewareExecute.id, handlerHandle.id])));
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
});

