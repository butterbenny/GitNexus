import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generateHTMLViewer } from '../dist/core/wiki/html-viewer.js';

test('wiki html viewer: sanitizes markdown HTML and uses strict mermaid security', async () => {
  const wikiDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-viewer-'));

  await fs.writeFile(path.join(wikiDir, 'module_tree.json'), '[]', 'utf-8');
  await fs.writeFile(path.join(wikiDir, 'meta.json'), '{}', 'utf-8');
  await fs.writeFile(
    path.join(wikiDir, 'overview.md'),
    [
      '# Overview',
      '',
      '<script>alert("xss")</script>',
      '',
      '```mermaid',
      'graph TD; A-->B;',
      '```',
      '',
    ].join('\n'),
    'utf-8',
  );

  const outputPath = await generateHTMLViewer(wikiDir, 'Wiki Security');
  const html = await fs.readFile(outputPath, 'utf-8');

  assert.match(html, /dompurify/i);
  assert.match(html, /securityLevel:\s*'strict'/);
  assert.doesNotMatch(html, /securityLevel:\s*'loose'/);
  assert.match(html, /contentEl\.innerHTML = renderMarkdownSafe\(md\);/);
  assert.match(html, /DOMPurify\.sanitize\(rendered,\s*\{\s*USE_PROFILES:\s*\{\s*html:\s*true\s*\}\s*\}\)/);
});
