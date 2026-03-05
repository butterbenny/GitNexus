import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('MCP stdio guard redirects non-JSON-RPC stdout to stderr', () => {
  const script = [
    "import { installMcpStdioGuard } from './dist/mcp/core/stdio-guard.js';",
    'installMcpStdioGuard();',
    "process.stdout.write('noise from dep\\n');",
    "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\\n');",
  ].join('\n');

  const res = spawnSync('node', ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0, `node exited with status ${res.status} (stderr: ${res.stderr || ''})`);
  assert.equal(
    res.stdout,
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\n',
  );
  assert.match(res.stderr, /redirecting to stderr/i);
  assert.match(res.stderr, /noise from dep/);
});

