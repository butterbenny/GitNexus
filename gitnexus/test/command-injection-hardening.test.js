import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getCommittedFileChanges } from '../dist/storage/git.js';
import { checkStaleness } from '../dist/mcp/staleness.js';
import { WikiGenerator } from '../dist/core/wiki/generator.js';

const markerPath = (name) => path.join(os.tmpdir(), `gitnexus-shell-hardening-${name}`);

const markerExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const removeMarker = async (filePath) => {
  try {
    await fs.unlink(filePath);
  } catch {
    // no-op
  }
};

test('storage/git: malicious commit range does not execute shell payload', async () => {
  if (process.platform === 'win32') return;

  const marker = markerPath('storage-git');
  await removeMarker(marker);

  getCommittedFileChanges(
    process.cwd(),
    `HEAD; touch ${marker} #`,
    'HEAD',
  );

  assert.equal(await markerExists(marker), false);
});

test('mcp/staleness: malicious indexed commit does not execute shell payload', async () => {
  if (process.platform === 'win32') return;

  const marker = markerPath('staleness');
  await removeMarker(marker);

  checkStaleness(
    process.cwd(),
    `HEAD; touch ${marker} #`,
  );

  assert.equal(await markerExists(marker), false);
});

test('wiki generator: malicious commit range does not execute shell payload', async () => {
  if (process.platform === 'win32') return;

  const marker = markerPath('wiki-generator');
  await removeMarker(marker);

  const generator = new WikiGenerator(
    process.cwd(),
    path.join(os.tmpdir(), 'gitnexus-wiki-hardening-storage'),
    path.join(os.tmpdir(), 'gitnexus-wiki-hardening-storage', 'kuzu'),
    {
      apiKey: '',
      baseUrl: 'https://example.com',
      model: 'test-model',
      maxTokens: 256,
      temperature: 0,
    },
    {},
  );

  // TypeScript "private" remains callable at runtime in emitted JS.
  generator.getChangedFiles(
    `HEAD; touch ${marker} #`,
    'HEAD',
  );

  assert.equal(await markerExists(marker), false);
});

test('source guard: no shell-template execSync in hardened modules', async () => {
  const sourceFiles = [
    'src/storage/git.ts',
    'src/mcp/staleness.ts',
    'src/core/wiki/generator.ts',
    'src/cli/wiki.ts',
    'src/core/ingestion/git-history-cochange-processor.ts',
  ];

  for (const relativePath of sourceFiles) {
    const source = await fs.readFile(path.join(process.cwd(), relativePath), 'utf-8');
    assert.doesNotMatch(source, /execSync\(\s*`/);
  }
});

test('source guard: git diff/status callsites use explicit maxBuffer for large repos', async () => {
  const localBackendSource = await fs.readFile(
    path.join(process.cwd(), 'src/mcp/local/local-backend.ts'),
    'utf-8',
  );
  const detectChangesSource = await fs.readFile(
    path.join(process.cwd(), 'src/mcp/local/detect-changes.ts'),
    'utf-8',
  );
  const reviewModeSource = await fs.readFile(
    path.join(process.cwd(), 'src/mcp/local/review-mode.ts'),
    'utf-8',
  );
  const storageGitSource = await fs.readFile(
    path.join(process.cwd(), 'src/storage/git.ts'),
    'utf-8',
  );

  assert.match(localBackendSource, /const GIT_NAME_LIST_MAX_BUFFER = 64 \* 1024 \* 1024/);
  assert.match(localBackendSource, /const GIT_PATCH_MAX_BUFFER = 128 \* 1024 \* 1024/);
  assert.match(detectChangesSource, /execFileSync\('git', buildDiffArgs\(\), \{[\s\S]*?maxBuffer: GIT_NAME_LIST_MAX_BUFFER/);
  assert.match(detectChangesSource, /execFileSync\('git', \['status', '--porcelain'\], \{[\s\S]*?maxBuffer: GIT_NAME_LIST_MAX_BUFFER/);
  assert.match(reviewModeSource, /execFileSync\('git', buildDiffArgs\(true, effectiveScope\), \{[\s\S]*?maxBuffer: GIT_PATCH_MAX_BUFFER/);

  assert.match(storageGitSource, /const GIT_NAME_LIST_MAX_BUFFER = 64 \* 1024 \* 1024/);
  assert.match(storageGitSource, /execFileSync\('git', \['diff', '--name-status', '-M', `\$\{fromCommit\}\.\.\$\{toCommit\}`\], \{[\s\S]*?maxBuffer: GIT_NAME_LIST_MAX_BUFFER/);
  assert.match(storageGitSource, /execFileSync\('git', \['status', '--porcelain', '-z'\], \{[\s\S]*?maxBuffer: GIT_NAME_LIST_MAX_BUFFER/);

  const wikiGeneratorSource = await fs.readFile(
    path.join(process.cwd(), 'src/core/wiki/generator.ts'),
    'utf-8',
  );
  assert.match(wikiGeneratorSource, /const GIT_NAME_LIST_MAX_BUFFER = 64 \* 1024 \* 1024/);
  assert.match(wikiGeneratorSource, /execFileSync\(\s*'git',\s*\['diff', `\$\{fromCommit\}\.\.\$\{toCommit\}`, '--name-only'\],[\s\S]*?maxBuffer: GIT_NAME_LIST_MAX_BUFFER/);
});
