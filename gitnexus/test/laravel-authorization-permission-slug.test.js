import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../dist/core/ingestion/pipeline.js';

test("Laravel auth: $this->authorize('permission.slug') wires to CodeElement:permission:* nodes when present", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auth-permission-slug-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'app', 'Http', 'Controllers'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'app', 'Domains', 'AccessControl', 'Permissions'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'config'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'app', 'Domains', 'AccessControl', 'Permissions', 'TicketPermission.php'),
    [
      '<?php',
      '',
      'namespace App\\Domains\\AccessControl\\Permissions;',
      '',
      'enum TicketPermission: string {',
      "  case VIEW = 'ticket.view';",
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'config', 'permissions.php'),
    [
      '<?php',
      '',
      'use App\\Domains\\AccessControl\\Permissions\\TicketPermission;',
      '',
      'return [',
      "  'roles' => [",
      "    'finance' => [",
      "      'permissions' => [",
      '        TicketPermission::VIEW,',
      '      ],',
      '    ],',
      '  ],',
      '];',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'app', 'Http', 'Controllers', 'TicketController.php'),
    [
      '<?php',
      '',
      'namespace App\\Http\\Controllers;',
      '',
      'class TicketController {',
      '  public function download() {',
      "    $this->authorize('ticket.view');",
      '    return null;',
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  const { graph } = await runPipelineFromRepo(repoPath, () => {});

  const controllerMethod = graph.nodes.find(n => {
    return n.label === 'Method'
      && n.properties?.filePath === 'app/Http/Controllers/TicketController.php'
      && n.properties?.name === 'download';
  });
  assert.ok(controllerMethod);

  const slugNode = graph.nodes.find(n => {
    return n.label === 'CodeElement'
      && n.id === 'CodeElement:permission:ticket.view'
      && n.properties?.name === 'ticket.view';
  });
  assert.ok(slugNode);

  const edge = graph.relationships.find(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerMethod.id
      && r.targetId === slugNode.id;
  });

  assert.ok(edge);
  assert.equal(edge.reason, 'laravel-authorize:ticket.view');
  assert.ok(edge.confidence >= 0.9);
});

