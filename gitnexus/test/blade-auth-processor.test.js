import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../dist/core/ingestion/pipeline.js';

test("Blade auth: @can('ticket.view') wires Template nodes to permission slug nodes", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-blade-auth-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'resources', 'views', 'tickets'), { recursive: true });
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
    path.join(repoPath, 'resources', 'views', 'tickets', 'show.blade.php'),
    [
      '@can(\'ticket.view\')',
      '  <div>Allowed</div>',
      '@endcan',
      '',
    ].join('\n'),
    'utf-8'
  );

  const { graph } = await runPipelineFromRepo(repoPath, () => {});

  const template = graph.nodes.find(n => n.label === 'Template' && n.id === 'Template:resources/views/tickets/show.blade.php');
  assert.ok(template);

  const slugNode = graph.nodes.find(n => n.label === 'CodeElement' && n.id === 'CodeElement:permission:ticket.view');
  assert.ok(slugNode);

  const edge = graph.relationships.find(r => {
    return r.type === 'CALLS'
      && r.sourceId === template.id
      && r.targetId === slugNode.id
      && r.reason === 'blade-auth:@can:ticket.view';
  });
  assert.ok(edge);
  assert.ok(edge.confidence >= 0.9);
});

