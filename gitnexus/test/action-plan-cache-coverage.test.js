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

test('MCP action_plan: includes cache coverage gaps for mutation-driven surfaces', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-action-plan-cache-coverage-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'apps/dashboard/src/pages'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'apps/dashboard/src/pages/CoveragePage.tsx'),
    [
      "import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';",
      '',
      'export const CoveragePage = () => {',
      '  const queryClient = useQueryClient();',
      '',
      "  useQuery({ queryKey: ['a', 1], queryFn: async () => [] });",
      "  useQuery({ queryKey: ['b', 1], queryFn: async () => [] });",
      '',
      '  const { mutate: doThing } = useMutation({',
      '    mutationFn: async () => null,',
      '    onSuccess: () => {',
      "      queryClient.invalidateQueries({ queryKey: ['a'] });",
      '    },',
      '  });',
      '',
      '  return <button onClick={() => doThing()}>Go</button>;',
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
  assert.match(output, /Repository indexed successfully/i);

  const plan = runTool('action_plan', { query: 'CoveragePage', limit_files: 10, limit_checks: 10 }, env);
  assert.equal(plan.status, 'ok');
  assert.ok(Array.isArray(plan.cache_effects));

  const entry = plan.cache_effects.find(e => e?.filePath === 'apps/dashboard/src/pages/CoveragePage.tsx');
  assert.ok(entry);
  assert.ok(entry.summary);
  assert.ok(entry.summary.coverage_gaps >= 1);
  assert.ok(Array.isArray(entry.coverage_gaps));
  assert.ok(entry.coverage_gaps.some(g => (g?.missing_queries || []).some(q => String(q?.queryKey || '').includes("'b'"))));
});

