import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const runGit = (repoPath, args) => {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
};

const runGitNexus = (args, env) => {
  const result = spawnSync(
    'node',
    [path.resolve('dist/cli/index.js'), ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    }
  );

  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');

  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(
      [
        `gitnexus ${args[0] || 'command'} failed (status: ${result.status})`,
        stdout && `STDOUT:\n${stdout}`,
        stderr && `STDERR:\n${stderr}`,
      ]
        .filter(Boolean)
        .join('\n\n')
    );
  }

  return stdout + stderr;
};

const parseJson = (stdout) => {
  const trimmed = String(stdout || '').trim();
  return JSON.parse(trimmed);
};

const collectSymbols = (result) => {
  const syms = [];
  if (Array.isArray(result?.process_symbols)) syms.push(...result.process_symbols);
  if (Array.isArray(result?.definitions)) syms.push(...result.definitions);
  return syms;
};

test('Query: surfaces CodeElement roles + permission slugs', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-codeelement-'));
  const repoPath = path.join(tmpRoot, 'repo');
  await fs.mkdir(path.join(repoPath, 'config'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'app', 'Domains', 'AccessControl', 'Permissions'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'config', 'permissions.php'),
    [
      '<?php',
      '',
      'use App\\Domains\\AccessControl\\Permissions\\TicketPermission;',
      '',
      'return [',
      "    'roles' => [",
      "        'finance' => [",
      "            'permissions' => [",
      '                TicketPermission::VIEW,',
      '            ],',
      '        ],',
      '    ],',
      '];',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'app', 'Domains', 'AccessControl', 'Permissions', 'TicketPermission.php'),
    [
      '<?php',
      '',
      'namespace App\\Domains\\AccessControl\\Permissions;',
      '',
      'enum TicketPermission: string',
      '{',
      "    case VIEW = 'ticket.view';",
      '}',
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

  const analyzeOutput = runGitNexus(['analyze', repoPath, '--skip-embeddings'], env);
  assert.match(analyzeOutput, /Repository indexed successfully/i);

  const financeResult = parseJson(runGitNexus(['query', 'finance'], env));
  const financeSymbols = collectSymbols(financeResult);
  assert.ok(
    financeSymbols.some(s => s?.type === 'CodeElement' && s?.name === 'role:finance'),
    'expected query "finance" to surface CodeElement role:finance'
  );

  const permResult = parseJson(runGitNexus(['query', 'ticket.view'], env));
  const permSymbols = collectSymbols(permResult);
  assert.ok(
    permSymbols.some(s => s?.type === 'CodeElement' && s?.name === 'ticket.view'),
    'expected query "ticket.view" to surface CodeElement permission slug node'
  );
});
