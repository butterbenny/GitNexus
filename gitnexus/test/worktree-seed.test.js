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

test('Analyze: seeds a new worktree index from an existing registered index', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-worktree-seed-'));
  const baseRepoPath = path.join(tmpRoot, 'repo');
  const wtRepoPath = path.join(tmpRoot, 'worktree');

  await fs.mkdir(baseRepoPath, { recursive: true });
  await fs.writeFile(path.join(baseRepoPath, 'src.ts'), 'export const x = 1;\n', 'utf-8');

  runGit(baseRepoPath, ['init']);
  runGit(baseRepoPath, ['config', 'user.email', 'test@example.com']);
  runGit(baseRepoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(baseRepoPath, ['add', '.']);
  runGit(baseRepoPath, ['commit', '-m', 'init']);

  const env = {
    GITNEXUS_HOME: path.join(tmpRoot, 'global'),
    GITNEXUS_DISABLE_CLAUDE_HOOK: '1',
  };

  const out1 = runAnalyze(baseRepoPath, env);
  assert.match(out1, /Repository (indexed successfully|updated incrementally)/i);

  runGit(baseRepoPath, ['worktree', 'add', wtRepoPath, '-b', 'wt-branch']);

  const out2 = runAnalyze(wtRepoPath, env);
  assert.match(out2, /Seeded index from /i);
  assert.match(out2, /Already up to date|updated incrementally|indexed successfully/i);

  const metaRaw = await fs.readFile(path.join(wtRepoPath, '.gitnexus', 'meta.json'), 'utf-8');
  const meta = JSON.parse(metaRaw);
  assert.equal(path.resolve(meta.repoPath), path.resolve(wtRepoPath));
  assert.ok(String(meta.lastCommit || '').length >= 7);
});

