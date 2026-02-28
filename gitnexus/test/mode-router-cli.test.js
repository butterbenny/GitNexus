import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

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

const parseJsonResult = (raw) => {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  if (start < 0) {
    throw new Error(`Expected JSON output, got:\n${text}`);
  }
  return JSON.parse(text.slice(start));
};

test('CLI mode-router command: routes to query kernel and emits unified envelope', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-mode-router-cli-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'src', 'notifications.ts'),
    [
      'export const fetchAccountNotifications = async () => {',
      '  return [];',
      '};',
      '',
    ].join('\n'),
    'utf-8',
  );

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
  const output = runAnalyze(repoPath, env);
  assert.match(output, /Repository indexed successfully/i);

  const cli = spawnSync(
    'node',
    [path.resolve('dist/cli/index.js'), 'mode-router', 'fetchAccountNotifications', '--repo', repoPath],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    }
  );

  assert.equal(cli.status, 0, `mode-router cli failed\nSTDOUT:\n${cli.stdout}\nSTDERR:\n${cli.stderr}`);
  const result = parseJsonResult(cli.stderr);
  assert.equal(result.status, 'ok');
  assert.equal(result.mode_router?.selected_mode, 'query');
  assert.ok(result.mode_router?.unified);
  assert.ok(Array.isArray(result.mode_router?.unified?.primary_symbols));
  assert.ok(result.mode_router?.route_trace);
});
