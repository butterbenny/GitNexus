import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LocalBackend } from '../dist/mcp/local/local-backend.js';
import { GITNEXUS_TOOLS } from '../dist/mcp/tools.js';
import { HTTP_API_TOOL_NAMES, callHttpApiTool } from '../dist/server/api.js';

const runGit = (repoPath, args) => {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
};

const runAnalyze = (repoPath, env) => {
  try {
    return execFileSync(
      'node',
      [path.resolve('dist/cli/index.js'), 'analyze', repoPath, '--skip-embeddings'],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        encoding: 'utf-8',
      }
    );
  } catch (e) {
    const err = e;
    const stdout = (err?.stdout || '').toString();
    const stderr = (err?.stderr || '').toString();
    const status = err?.status ?? err?.code ?? 'unknown';
    throw new Error(
      [
        `analyze failed (status: ${status})`,
        stdout && `STDOUT:\n${stdout}`,
        stderr && `STDERR:\n${stderr}`,
      ]
        .filter(Boolean)
        .join('\n\n')
    );
  }
};

test('HTTP API tool dispatcher: exposes kernel-head list and mode_router call path', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-http-api-dispatch-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'src', 'users.ts'),
    [
      'export const fetchUsers = async () => {',
      '  return [];',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
  const output = runAnalyze(repoPath, env);
  assert.match(output, /Repository indexed successfully|Repository updated incrementally/i);

  const originalHome = process.env.GITNEXUS_HOME;
  process.env.GITNEXUS_HOME = env.GITNEXUS_HOME;
  const backend = new LocalBackend();
  await backend.init();

  try {
    const mcpToolNames = GITNEXUS_TOOLS.map(tool => tool.name).sort();
    const httpToolNames = [...HTTP_API_TOOL_NAMES].sort();
    assert.deepEqual(httpToolNames, mcpToolNames);

    assert.ok(HTTP_API_TOOL_NAMES.includes('mode_router'));
    assert.ok(HTTP_API_TOOL_NAMES.includes('query_mode'));
    assert.ok(HTTP_API_TOOL_NAMES.includes('implement_mode'));
    assert.ok(HTTP_API_TOOL_NAMES.includes('review_mode'));
    assert.ok(HTTP_API_TOOL_NAMES.includes('debug_mode'));

    const modeRouterResult = await callHttpApiTool(
      backend,
      'mode_router',
      { query: 'fetchUsers' },
      repoPath,
    );
    assert.equal(modeRouterResult.status, 'ok');
    assert.equal(modeRouterResult.mode_router?.selected_mode, 'query');
    assert.ok(modeRouterResult.mode_router?.unified);
    assert.ok(modeRouterResult.mode_router?.route_trace);

    await assert.rejects(
      () => callHttpApiTool(backend, 'not_a_tool', {}, repoPath),
      /Unknown tool/,
    );
  } finally {
    await backend.disconnect();
    process.env.GITNEXUS_HOME = originalHome;
  }
});
