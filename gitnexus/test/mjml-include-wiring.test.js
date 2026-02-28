import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const runGit = (repoPath, args) => {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
};

const runAnalyze = (repoPath, args, env) => {
  try {
    return execFileSync(
      'node',
      [path.resolve('dist/cli/index.js'), 'analyze', repoPath, '--skip-embeddings', ...args],
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

const runCypher = (repoPath, query, env) => {
  const script = [
    "import { LocalBackend } from './dist/mcp/local/local-backend.js';",
    'const backend = new LocalBackend();',
    'await backend.init();',
    `const rows = await backend.callTool('cypher', { repo: ${JSON.stringify(repoPath)}, query: ${JSON.stringify(query)} });`,
    'process.stdout.write(JSON.stringify(rows));',
  ].join('\n');

  const raw = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });

  return JSON.parse(raw);
};

test('MJML includes: mj-include path=... emits IMPORTS edges', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-mjml-include-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'resources', 'mail', 'templates', 'pledge', 'partials'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'resources', 'mail', 'templates', 'pledge', 'partials', 'header.mjml'),
    ['<mj-section>', '  <mj-column>', '    <mj-text>Header</mj-text>', '  </mj-column>', '</mj-section>', ''].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'resources', 'mail', 'templates', 'pledge', 'pledge-reminder.mjml'),
    [
      '<mjml>',
      '  <mj-body>',
      '    <mj-include path="./partials/header.mjml" />',
      '    <mj-text>Body</mj-text>',
      '  </mj-body>',
      '</mjml>',
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
  const first = runAnalyze(repoPath, [], env);
  assert.match(first, /Repository indexed successfully/i);

  const imports = runCypher(
    repoPath,
    [
      "MATCH (a)-[r:CodeRelation {type: 'IMPORTS'}]->(b)",
      "WHERE a.id = 'File:resources/mail/templates/pledge/pledge-reminder.mjml'",
      "  AND b.id = 'File:resources/mail/templates/pledge/partials/header.mjml'",
      "RETURN r.confidence AS confidence, r.reason AS reason",
    ].join('\n'),
    env
  );

  assert.ok(Array.isArray(imports));
  assert.equal(imports.length, 1);
  assert.equal(imports[0]?.reason, 'mjml-include');
  assert.equal(imports[0]?.confidence, 1.0);
});

test('MJML templates: route(\"name\") wires to Laravel controller methods', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-mjml-route-name-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'app', 'Http', 'Controllers'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'routes'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'resources', 'mail', 'templates'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'app', 'Http', 'Controllers', 'UserController.php'),
    [
      '<?php',
      '',
      'namespace App\\Http\\Controllers;',
      '',
      'class UserController {',
      '  public function index() {',
      '    return null;',
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'routes', 'web.php'),
    [
      '<?php',
      '',
      'use App\\Http\\Controllers\\UserController;',
      'use Illuminate\\Support\\Facades\\Route;',
      '',
      "Route::get('/users', [UserController::class, 'index'])->name('users.index');",
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'resources', 'mail', 'templates', 'welcome.mjml'),
    [
      '<mjml>',
      '  <mj-body>',
      '    <mj-text href="{{ route(\'users.index\') }}">Users</mj-text>',
      '  </mj-body>',
      '</mjml>',
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
  const first = runAnalyze(repoPath, [], env);
  assert.match(first, /Repository indexed successfully/i);

  const calls = runCypher(
    repoPath,
    [
      "MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->(b)",
      "WHERE a.id = 'File:resources/mail/templates/welcome.mjml'",
      "  AND b.id = 'Method:app/Http/Controllers/UserController.php:index'",
      "RETURN r.confidence AS confidence, r.reason AS reason",
    ].join('\n'),
    env
  );

  assert.ok(Array.isArray(calls));
  assert.equal(calls.length, 1);
  assert.ok((calls[0]?.reason || '').startsWith('route-name:users.index'));
  assert.ok((calls[0]?.confidence || 0) >= 0.9);
});
