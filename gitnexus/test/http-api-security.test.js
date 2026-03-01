import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  isAllowedCorsOrigin,
  isReadOnlyCypherQuery,
  normalizeSearchLimit,
  resolveRepoFilePath,
} from '../dist/server/api.js';

test('HTTP API cypher safety: allows read-only and blocks write queries', () => {
  assert.equal(
    isReadOnlyCypherQuery('MATCH (f:File) RETURN count(f) AS c'),
    true,
  );
  assert.equal(
    isReadOnlyCypherQuery('MATCH (n) DETACH DELETE n'),
    false,
  );
  assert.equal(
    isReadOnlyCypherQuery('MATCH (n) RETURN "CREATE TABLE literal text" AS t'),
    true,
  );
  assert.equal(
    isReadOnlyCypherQuery('MATCH (n) CR/**/EATE (m:File {name: "x"}) RETURN m'),
    false,
  );
});

test('HTTP API file safety: path resolver keeps reads inside repo root', async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-http-api-file-safety-'));
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoPath, 'src', 'safe.ts'), 'export const safe = true;\n', 'utf-8');

  const safePath = resolveRepoFilePath(repoPath, 'src/safe.ts');
  assert.ok(safePath);
  assert.equal(safePath.relativePath, 'src/safe.ts');
  assert.equal(safePath.absolutePath, path.join(repoPath, 'src', 'safe.ts'));

  const traversal = resolveRepoFilePath(repoPath, '../../etc/passwd');
  assert.equal(traversal, null);

  const absoluteOutside = resolveRepoFilePath(repoPath, '/etc/passwd');
  assert.equal(absoluteOutside, null);
});

test('HTTP API route guard: query and file endpoints enforce safety helpers', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'src', 'server', 'api.ts'), 'utf-8');

  assert.match(
    source,
    /app\.post\('\/api\/query'[\s\S]*if \(!isReadOnlyCypherQuery\(query\)\)/,
  );
  assert.match(
    source,
    /app\.get\('\/api\/file'[\s\S]*resolveRepoFilePath\(repo\.repoPath,\s*filePath\)/,
  );
  assert.match(
    source,
    /app\.use\(cors\(\{[\s\S]*isAllowedCorsOrigin\(origin\)/,
  );
});

test('HTTP API CORS safety: allows loopback origins and blocks non-loopback origins', () => {
  assert.equal(isAllowedCorsOrigin(undefined), true);
  assert.equal(isAllowedCorsOrigin(''), true);
  assert.equal(isAllowedCorsOrigin('http://localhost:3000'), true);
  assert.equal(isAllowedCorsOrigin('https://127.0.0.1:5173'), true);
  assert.equal(isAllowedCorsOrigin('http://evil.example.com'), false);
});

test('HTTP API search safety: clamps limit to safe bounds', () => {
  assert.equal(normalizeSearchLimit(undefined), 10);
  assert.equal(normalizeSearchLimit('not-a-number'), 10);
  assert.equal(normalizeSearchLimit(-5), 1);
  assert.equal(normalizeSearchLimit(0), 1);
  assert.equal(normalizeSearchLimit(7), 7);
  assert.equal(normalizeSearchLimit(999999), 200);
});
