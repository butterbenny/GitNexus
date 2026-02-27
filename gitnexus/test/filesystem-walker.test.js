import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listRepositoryFiles } from '../dist/core/ingestion/filesystem-walker.js';

test('listRepositoryFiles: git fast path preserves dot:false semantics', async () => {
  const files = await listRepositoryFiles(process.cwd());

  assert.ok(files.includes('src/core/ingestion/filesystem-walker.ts'));
  assert.ok(!files.includes('.npmignore'));
  assert.ok(!files.includes('.gitignore'));
  assert.ok(files.every(fp => !fp.startsWith('../') && !fp.includes('/../')));
});

test('listRepositoryFiles: glob fallback skips ignored dirs', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-walk-'));
  await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, 'src', 'a.ts'), 'export const a = 1;', 'utf-8');

  await fs.mkdir(path.join(tmpRoot, 'node_modules', 'foo'), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, 'node_modules', 'foo', 'index.js'), 'module.exports = 1;', 'utf-8');

  await fs.mkdir(path.join(tmpRoot, 'vendor', 'bar'), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, 'vendor', 'bar', 'b.php'), '<?php echo 1;', 'utf-8');

  await fs.mkdir(path.join(tmpRoot, '.storybook'), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, '.storybook', 'main.ts'), 'export default {}', 'utf-8');

  const files = await listRepositoryFiles(tmpRoot);
  assert.deepEqual(files.sort(), ['src/a.ts']);
});

