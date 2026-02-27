import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import kuzu from 'kuzu';

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

const runAnalyzeWithArgs = (repoPath, extraArgs, env) => {
  try {
    return execFileSync(
      'node',
      [path.resolve('dist/cli/index.js'), 'analyze', repoPath, '--skip-embeddings', ...(extraArgs || [])],
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

const queryCount = async (repoPath, cypher) => {
  const dbPath = path.join(repoPath, '.gitnexus', 'kuzu');
  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);
  try {
    const queryResult = await conn.query(cypher);
    const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    const rows = await result.getAll();
    return Number(rows[0]?.cnt ?? rows[0]?.[0] ?? 0);
  } finally {
    try { await conn.close(); } catch {}
    try { await db.close(); } catch {}
  }
};

test('Incremental indexing: re-indexes dirty working tree changes', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-inc-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'src', 'a.ts'),
    [
      'export const fetchUsers = () => {',
      '  return 1;',
      '};',
      '',
      'export const callFetchUsers = () => {',
      '  return fetchUsers();',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  // Initialize a minimal git repo so analyze can compute commit + dirty changes.
  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };

  const first = runAnalyze(repoPath, env);
  assert.match(first, /Repository indexed successfully/i);

  // Dirty working tree change (no commit)
  await fs.writeFile(
    path.join(repoPath, 'src', 'a.ts'),
    [
      'export const fetchUsers = () => {',
      '  return 1;',
      '};',
      '',
      'export const callFetchUsers = () => {',
      '  return fetchUsers();',
      '};',
      '',
      'export const incrementalAdded = () => {',
      '  return fetchUsers();',
      '};',
      '',
    ].join('\n'),
    'utf-8'
  );

  const second = runAnalyze(repoPath, env);
  assert.match(second, /Repository updated incrementally/i);

  // Verify the new symbol exists in the on-disk Kuzu index
  const dbPath = path.join(repoPath, '.gitnexus', 'kuzu');
  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);
  const queryResult = await conn.query(
    "MATCH (f:Function) WHERE f.filePath = 'src/a.ts' AND f.name = 'incrementalAdded' RETURN count(f) AS cnt"
  );
  const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
  const rows = await result.getAll();
  const cnt = Number(rows[0]?.cnt ?? rows[0]?.[0] ?? 0);
  assert.equal(cnt, 1);

  try { await conn.close(); } catch {}
  try { await db.close(); } catch {}
});

test('Incremental indexing: config/permissions.php change stays incremental and adds slug nodes', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-inc-perms-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(path.join(repoPath, 'config'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'app', 'Enums'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'app', 'Enums', 'TicketPermission.php'),
    [
      '<?php',
      'namespace App\\Enums;',
      '',
      'enum TicketPermission: string {',
      "  case VIEW = 'ticket.view';",
      "  case EDIT = 'ticket.edit';",
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  const writePermissionsConfig = async (includeEdit) => {
    await fs.writeFile(
      path.join(repoPath, 'config', 'permissions.php'),
      [
        '<?php',
        'use App\\Enums\\TicketPermission;',
        '',
        'return [',
        "  'roles' => [",
        "    'finance' => [",
        "      'permissions' => [",
        "        TicketPermission::VIEW,",
        ...(includeEdit ? ["        TicketPermission::EDIT,"] : []),
        '      ],',
        '    ],',
        '  ],',
        '];',
        '',
      ].join('\n'),
      'utf-8'
    );
  };

  await writePermissionsConfig(false);

  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'init']);

  const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };

  const first = runAnalyze(repoPath, env);
  assert.match(first, /Repository indexed successfully/i);

  const initialSlugCount = await queryCount(
    repoPath,
    "MATCH (n:CodeElement) WHERE n.id = 'CodeElement:permission:ticket.edit' RETURN count(n) AS cnt"
  );
  assert.equal(initialSlugCount, 0);

  await writePermissionsConfig(true);
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'add ticket.edit']);

  const second = runAnalyze(repoPath, env);
  assert.match(second, /Repository updated incrementally/i);

  const updatedSlugCount = await queryCount(
    repoPath,
    "MATCH (n:CodeElement) WHERE n.id = 'CodeElement:permission:ticket.edit' RETURN count(n) AS cnt"
  );
  assert.equal(updatedSlugCount, 1);
});

test('Incremental indexing: --incremental-recompute-processes updates Process nodes', async () => {
  const mkRepo = async (tmpRoot, recomputeFlag) => {
    const repoPath = path.join(tmpRoot, 'repo');
    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });

    const writeCode = async (withCalls) => {
      await fs.writeFile(
        path.join(repoPath, 'src', 'a.ts'),
        [
          'export const foo = () => {',
          '  return 1;',
          '};',
          '',
          'export const baz = () => {',
          ...(withCalls ? ['  return foo();'] : ['  return 2;']),
          '};',
          '',
          'export const bar = () => {',
          ...(withCalls ? ['  return baz();'] : ['  return 3;']),
          '};',
          '',
        ].join('\\n'),
        'utf-8'
      );
    };

    await writeCode(false);

    runGit(repoPath, ['init']);
    runGit(repoPath, ['config', 'user.email', 'test@example.com']);
    runGit(repoPath, ['config', 'user.name', 'GitNexus Test']);
    runGit(repoPath, ['add', '.']);
    runGit(repoPath, ['commit', '-m', 'init']);

    const env = { GITNEXUS_HOME: path.join(tmpRoot, 'global'), GITNEXUS_DISABLE_CLAUDE_HOOK: '1' };
    const first = runAnalyze(repoPath, env);
    assert.match(first, /Repository indexed successfully/i);

    const initialProcessCount = await queryCount(repoPath, 'MATCH (p:Process) RETURN count(p) AS cnt');
    assert.equal(initialProcessCount, 0);

    await writeCode(true);
    runGit(repoPath, ['add', '.']);
    runGit(repoPath, ['commit', '-m', 'add call chain']);

    const args = recomputeFlag ? ['--incremental-recompute-processes'] : [];
    const second = runAnalyzeWithArgs(repoPath, args, env);
    assert.match(second, /Repository updated incrementally/i);

    const updatedProcessCount = await queryCount(repoPath, 'MATCH (p:Process) RETURN count(p) AS cnt');
    return { repoPath, updatedProcessCount };
  };

  const tmpNoRecompute = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-inc-proc-no-'));
  const noRecompute = await mkRepo(tmpNoRecompute, false);
  assert.equal(noRecompute.updatedProcessCount, 0);

  const tmpRecompute = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-inc-proc-yes-'));
  const recompute = await mkRepo(tmpRecompute, true);
  assert.ok(recompute.updatedProcessCount > 0);
});
