import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { producePrecisionOverlay } from '../dist/core/ingestion/precision-overlay-producer.js';
import { createKnowledgeGraph } from '../dist/core/graph/graph.js';
import { processPrecisionOverlay } from '../dist/core/ingestion/precision-overlay-processor.js';

const createTempRepo = async (name) => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), `gitnexus-${name}-`));
  await fs.mkdir(path.join(repoPath, '.git'), { recursive: true });
  await fs.writeFile(path.join(repoPath, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }, null, 2), 'utf-8');
  await fs.writeFile(path.join(repoPath, 'package.json'), JSON.stringify({ name: 'precision-test' }, null, 2), 'utf-8');
  return repoPath;
};

const SAMPLE_SCIP_INDEX = {
  metadata: {
    toolInfo: {
      name: 'scip-typescript',
      version: '0.1.0',
    },
  },
  documents: [
    {
      relativePath: 'src/foo.ts',
      language: 'typescript',
      occurrences: [
        { symbol: 'scip-typescript npm precision foo()', range: [0, 0, 0, 20], symbolRoles: 1 },
        { symbol: 'scip-typescript npm precision bar()', range: [1, 2, 1, 15], symbolRoles: 0 },
      ],
      symbols: [
        {
          symbol: 'scip-typescript npm precision foo()',
          displayName: 'foo',
          relationships: [{ symbol: 'scip-typescript npm precision bar()', isReference: true }],
        },
      ],
    },
    {
      relativePath: 'src/bar.ts',
      language: 'typescript',
      occurrences: [
        { symbol: 'scip-typescript npm precision bar()', range: [0, 0, 0, 18], symbolRoles: 1 },
      ],
      symbols: [
        { symbol: 'scip-typescript npm precision bar()', displayName: 'bar' },
      ],
    },
  ],
};

test('Precision producer: writes normalized run artifacts and canonical overlay', async () => {
  const repoPath = await createTempRepo('producer');
  try {
    const first = await producePrecisionOverlay(repoPath, {
      mode: 'auto',
      scipJson: JSON.stringify(SAMPLE_SCIP_INDEX),
    });

    assert.equal(first.producer, 'scip');
    assert.equal(first.skipped, false);
    assert.equal(first.cacheHit, false);
    assert.ok(first.declaredRelations > 0);
    assert.ok(first.snapshotPath);
    assert.ok(first.producerMetaPath);
    assert.ok(first.statsPath);

    assert.ok(await fs.stat(first.snapshotPath));
    assert.ok(await fs.stat(first.producerMetaPath));
    assert.ok(await fs.stat(first.statsPath));
    assert.ok(await fs.stat(first.overlayPath));

    const overlay = JSON.parse(await fs.readFile(first.overlayPath, 'utf-8'));
    assert.ok(Array.isArray(overlay.relations));
    assert.equal(overlay.provider, 'scip');
    assert.ok(overlay.relations.length > 0);

    const second = await producePrecisionOverlay(repoPath, { mode: 'auto' });
    assert.equal(second.cacheHit, true);
    assert.equal(second.declaredRelations, first.declaredRelations);
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
});

test('Precision producer: shadow mode writes run artifacts but leaves canonical overlay untouched', async () => {
  const repoPath = await createTempRepo('shadow');
  const canonicalOverlayPath = path.join(repoPath, '.gitnexus', 'precision-overlay.json');

  try {
    await fs.mkdir(path.dirname(canonicalOverlayPath), { recursive: true });
    await fs.writeFile(canonicalOverlayPath, JSON.stringify({ provider: 'manual', relations: [] }, null, 2), 'utf-8');

    const result = await producePrecisionOverlay(repoPath, {
      mode: 'shadow',
      scipJson: JSON.stringify(SAMPLE_SCIP_INDEX),
    });

    assert.equal(result.skipped, false);
    assert.equal(result.producer, 'scip');
    assert.ok(result.overlayPath.includes('/.gitnexus/precision/runs/'));

    const canonicalOverlay = JSON.parse(await fs.readFile(canonicalOverlayPath, 'utf-8'));
    assert.equal(canonicalOverlay.provider, 'manual');
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
});

test('Precision overlay processor: producer shadow mode does not import edges', async () => {
  const repoPath = await createTempRepo('processor-shadow');
  try {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:src/foo.ts:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/foo.ts', startLine: 1, endLine: 5 },
    });
    graph.addNode({
      id: 'Function:src/bar.ts:bar',
      label: 'Function',
      properties: { name: 'bar', filePath: 'src/bar.ts', startLine: 1, endLine: 5 },
    });

    const shadow = await processPrecisionOverlay(repoPath, graph, undefined, {
      producerMode: 'shadow',
      producerScipJson: JSON.stringify(SAMPLE_SCIP_INDEX),
    });

    assert.equal(shadow.edges.length, 0);
    assert.equal(shadow.stats.producer, 'scip');
    assert.equal(shadow.stats.producerSkipped, false);

    const applied = await processPrecisionOverlay(repoPath, graph, undefined, {
      producerMode: 'auto',
      producerScipJson: JSON.stringify(SAMPLE_SCIP_INDEX),
      producerForceRefresh: true,
    });

    assert.ok(applied.edges.length > 0);
    assert.ok(applied.stats.emittedEdges > 0);
  } finally {
    await fs.rm(repoPath, { recursive: true, force: true });
  }
});
