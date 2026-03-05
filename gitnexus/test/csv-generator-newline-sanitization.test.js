import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createKnowledgeGraph } from '../dist/core/graph/graph.js';
import { generateAllCSVs } from '../dist/core/kuzu/csv-generator.js';

test('CSV generator: replaces raw newlines with U+2028 so node COPY can run PARALLEL=true', () => {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'File:src/example.ts',
    label: 'File',
    properties: {
      name: 'example.ts',
      filePath: 'src/example.ts',
    },
  });

  const fileContents = new Map([
    ['src/example.ts', 'line1\nline2'],
  ]);

  const csvData = generateAllCSVs(graph, fileContents);
  const fileCsv = csvData.nodes.get('File');
  assert.ok(fileCsv);

  // Should be header + single row (no extra rows from embedded newlines).
  const lines = fileCsv.split('\n');
  assert.equal(lines.length, 2);
  assert.equal((fileCsv.match(/\n/g) || []).length, 1);

  assert.match(lines[1], /line1/);
  assert.match(lines[1], /line2/);
  assert.ok(lines[1].includes('\u2028'));
});

