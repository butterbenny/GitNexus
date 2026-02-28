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

test('Template method calls: Blade/MJML → PHP method edges (and survive incremental PHP rebuilds)', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-template-method-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'app', 'Models'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'app', 'Traits'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'resources', 'views', 'paddle_raise'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'resources', 'mail', 'templates', 'pledge'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'app', 'Models', 'PaddleRaise.php'),
    [
      '<?php',
      '',
      'class PaddleRaise {',
      '  public function getPayUrl(): string {',
      "    return 'pay';",
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'app', 'Traits', 'IsPayable.php'),
    [
      '<?php',
      '',
      'trait IsPayable {',
      '  public function getPayUrl($expire = null): string {',
      "    return 'pay';",
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'resources', 'views', 'paddle_raise', 'success.blade.php'),
    [
      '<div>',
      '  {{ $campaign->paddleRaise->getPayUrl() }}',
      '</div>',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'resources', 'mail', 'templates', 'pledge', 'pledge-reminder.mjml'),
    [
      '<mjml>',
      '  <mj-body>',
      '    <mj-text href="{{$pledge->getPayUrl(false)}}">Pay</mj-text>',
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

  const paddleRaiseEdge = runCypher(
    repoPath,
    [
      "MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->(b)",
      "WHERE a.id = 'File:resources/views/paddle_raise/success.blade.php'",
      "  AND b.id = 'Method:app/Models/PaddleRaise.php:getPayUrl'",
      "RETURN r.confidence AS confidence, r.reason AS reason",
    ].join('\n'),
    env
  );
  assert.ok(Array.isArray(paddleRaiseEdge));
  assert.equal(paddleRaiseEdge.length, 1);
  assert.ok((paddleRaiseEdge[0]?.reason || '').startsWith('template-method:receiver:PaddleRaise:getPayUrl'));
  assert.ok((paddleRaiseEdge[0]?.confidence || 0) >= 0.9);

  const payableEdge = runCypher(
    repoPath,
    [
      "MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->(b)",
      "WHERE a.id = 'File:resources/mail/templates/pledge/pledge-reminder.mjml'",
      "  AND b.id = 'Method:app/Traits/IsPayable.php:getPayUrl'",
      "RETURN r.confidence AS confidence, r.reason AS reason",
    ].join('\n'),
    env
  );
  assert.ok(Array.isArray(payableEdge));
  assert.equal(payableEdge.length, 1);
  assert.ok((payableEdge[0]?.reason || '').startsWith('template-method:trait-default:Pledge:getPayUrl'));
  assert.ok((payableEdge[0]?.confidence || 0) >= 0.8);

  // Change the PHP defining file; incremental mode previously would drop template→method edges
  // because the method node is DETACH DELETE'd and recreated.
  await fs.writeFile(
    path.join(repoPath, 'app', 'Models', 'PaddleRaise.php'),
    [
      '<?php',
      '',
      'class PaddleRaise {',
      '  public function getPayUrl(): string {',
      "    return 'pay2';",
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );
  runGit(repoPath, ['add', '.']);
  runGit(repoPath, ['commit', '-m', 'change']);

  const second = runAnalyze(repoPath, [], env);
  assert.match(second, /Repository updated incrementally/i);

  const afterEdge = runCypher(
    repoPath,
    [
      "MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->(b)",
      "WHERE a.id = 'File:resources/views/paddle_raise/success.blade.php'",
      "  AND b.id = 'Method:app/Models/PaddleRaise.php:getPayUrl'",
      "RETURN r.confidence AS confidence, r.reason AS reason",
    ].join('\n'),
    env
  );
  assert.ok(Array.isArray(afterEdge));
  assert.equal(afterEdge.length, 1);
});

