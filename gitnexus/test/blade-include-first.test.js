import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../dist/core/ingestion/pipeline.js';

test('Blade: @includeFirst([...]) emits import edges to literal candidates', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-blade-include-first-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'resources', 'views', 'users', 'partials'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'resources', 'views', 'users', 'partials', 'a.blade.php'),
    ['<div>A</div>', ''].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'resources', 'views', 'users', 'partials', 'b.blade.php'),
    ['<div>B</div>', ''].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'resources', 'views', 'users', 'index.blade.php'),
    [
      '@includeFirst([',
      "  'users.partials.a',",
      "  'users.partials.b',",
      '])',
      '',
    ].join('\n'),
    'utf-8'
  );

  const { graph } = await runPipelineFromRepo(repoPath, () => {});

  const indexTemplate = graph.nodes.find(n => n.label === 'Template' && n.properties?.filePath === 'resources/views/users/index.blade.php');
  assert.ok(indexTemplate);

  const aTemplate = graph.nodes.find(n => n.label === 'Template' && n.properties?.filePath === 'resources/views/users/partials/a.blade.php');
  const bTemplate = graph.nodes.find(n => n.label === 'Template' && n.properties?.filePath === 'resources/views/users/partials/b.blade.php');
  assert.ok(aTemplate);
  assert.ok(bTemplate);

  const importTargets = new Set(
    graph.relationships
      .filter(r => r.type === 'IMPORTS' && r.sourceId === indexTemplate.id)
      .map(r => r.targetId)
  );

  assert.ok(importTargets.has(aTemplate.id));
  assert.ok(importTargets.has(bTemplate.id));
});

