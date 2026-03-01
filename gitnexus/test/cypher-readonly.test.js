import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const runGit = (repoPath, args) => {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
};

const runAnalyze = (repoPath, env) => {
  return execFileSync(
    'node',
    [path.resolve('dist/cli/index.js'), 'analyze', repoPath, '--skip-embeddings'],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    },
  );
};

const runTool = (method, params, env) => {
  const script = [
    "import { LocalBackend } from './dist/mcp/local/local-backend.js';",
    'const backend = new LocalBackend();',
    'await backend.init();',
    `const result = await backend.callTool(${JSON.stringify(method)}, ${JSON.stringify(params)});`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');

  const raw = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
  return JSON.parse(raw);
};

test('cypher tool: allows read-only queries and blocks write operations', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-cypher-readonly-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoPath, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
  const output = runAnalyze(repoPath, env);
  assert.match(output, /Repository indexed successfully/i);

  const readResult = runTool('cypher', {
    repo: repoPath,
    query: 'MATCH (f:File) RETURN count(f) AS fileCount',
  }, env);
  assert.ok(Array.isArray(readResult), 'expected read-only cypher query to execute');
  assert.ok(Number(readResult[0]?.fileCount || 0) >= 1);

  const writeResult = runTool('cypher', {
    repo: repoPath,
    query: 'MATCH (n) DETACH DELETE n',
  }, env);
  assert.ok(typeof writeResult?.error === 'string');
  assert.match(writeResult.error, /write operations are disabled/i);

  const obfuscatedWriteResult = runTool('cypher', {
    repo: repoPath,
    query: 'MATCH (n) CR/**/EATE (m:File {name: "x"}) RETURN m',
  }, env);
  assert.ok(typeof obfuscatedWriteResult?.error === 'string');
  assert.match(obfuscatedWriteResult.error, /write operations are disabled/i);
});
