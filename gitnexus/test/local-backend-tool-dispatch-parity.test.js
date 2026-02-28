import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LocalBackend } from '../dist/mcp/local/local-backend.js';
import { GITNEXUS_TOOLS } from '../dist/mcp/tools.js';

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

test('LocalBackend dispatch: every MCP tool has a recognized backend handler path', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-tool-dispatch-parity-'));
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

  const toolProbeArgs = {
    list_repos: () => ({}),
    query: () => ({ query: 'fetchUsers' }),
    query_mode: () => ({ query: 'fetchUsers' }),
    implement_mode: () => ({ query: 'fetchUsers' }),
    review_mode: () => ({ scope: 'all' }),
    debug_mode: () => ({ query: 'fetchUsers', symptom: 'auth issue' }),
    mode_router: () => ({ query: 'fetchUsers' }),
    action_plan: () => ({ query: 'fetchUsers' }),
    archetypes: () => ({}),
    precedents: () => ({ query: 'fetchUsers' }),
    context: () => ({ name: 'fetchUsers' }),
    impact: () => ({ name: 'fetchUsers', direction: 'upstream' }),
    detect_changes: () => ({ scope: 'all' }),
    episode_state: () => ({}),
    episode_update: () => ({ candidate_hypotheses: ['dispatch probe'] }),
    evidence_spans: () => ({ limit: 1 }),
    summary_overlay: () => ({ level: 'symbol', limit: 1 }),
    closure_templates: () => ({ limit: 1 }),
    ui_contract: () => ({ file_path: 'src/users.ts' }),
    rename: () => ({ symbol_name: 'fetchUsers', new_name: 'fetchUsersRenamed', dry_run: true }),
    cypher: () => ({ query: 'MATCH (n) RETURN n.id LIMIT 1' }),
  };

  try {
    for (const toolName of GITNEXUS_TOOLS.map(tool => tool.name)) {
      const probeFactory = toolProbeArgs[toolName] || (() => ({}));
      const args = probeFactory();
      if (toolName !== 'list_repos') {
        args.repo = repoPath;
      }

      try {
        await backend.callTool(toolName, args);
      } catch (err) {
        const message = String(err?.message || err || '');
        assert.doesNotMatch(
          message,
          /Unknown tool|not implemented/i,
          `${toolName} is declared in MCP tools but backend dispatch rejected it: ${message}`,
        );
      }
    }
  } finally {
    await backend.disconnect();
    process.env.GITNEXUS_HOME = originalHome;
  }
});
