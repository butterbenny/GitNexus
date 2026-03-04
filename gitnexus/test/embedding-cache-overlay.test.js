import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  appendEmbeddingCacheOverlay,
  loadEmbeddingCacheOverlay,
  resolveEmbeddingCacheOverlayPath,
} from '../dist/core/embeddings/embedding-cache.js';

test('Embedding cache overlay: appends and reloads hash entries', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-embedding-cache-overlay-'));
  const cachePath = path.join(tmpRoot, 'cache.json');
  const overlayPath = resolveEmbeddingCacheOverlayPath(cachePath);

  assert.ok(overlayPath.endsWith('cache.overlay.jsonl'));

  await appendEmbeddingCacheOverlay(overlayPath, [
    { hash: 'hash-1', embeddingBase64: 'base64-1' },
    { hash: 'hash-2', embeddingBase64: 'base64-2' },
  ]);
  await appendEmbeddingCacheOverlay(overlayPath, [
    { hash: 'hash-1', embeddingBase64: 'base64-1b' },
  ]);

  const loaded = await loadEmbeddingCacheOverlay(overlayPath);
  assert.equal(loaded.get('hash-1'), 'base64-1b');
  assert.equal(loaded.get('hash-2'), 'base64-2');
});

