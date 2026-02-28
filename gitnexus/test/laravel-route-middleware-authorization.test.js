import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../dist/core/ingestion/pipeline.js';

test("Laravel route middleware: middleware('can:ticket.view') wires endpoint + controller to permission slug nodes", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-route-mw-auth-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'app', 'Http', 'Controllers'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'app', 'Domains', 'AccessControl', 'Permissions'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'routes'), { recursive: true });
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
      '    return null;',
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'routes', 'api.php'),
    [
      '<?php',
      '',
      'use App\\Http\\Controllers\\TicketController;',
      'use Illuminate\\Support\\Facades\\Route;',
      '',
      "Route::get('/tickets/download', [TicketController::class, 'download'])->middleware('can:ticket.view');",
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

  const slugNode = graph.nodes.find(n => n.label === 'CodeElement' && n.id === 'CodeElement:permission:ticket.view');
  assert.ok(slugNode);

  const controllerEdge = graph.relationships.find(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerMethod.id
      && r.targetId === slugNode.id
      && r.reason === 'laravel-can:route-middleware:can:ticket.view';
  });
  assert.ok(controllerEdge);
  assert.ok(controllerEdge.confidence >= 0.9);

  const endpointEdge = graph.relationships.find(r => {
    return r.type === 'CALLS'
      && r.sourceId === 'CodeElement:endpoint:get:/api/tickets/download'
      && r.targetId === slugNode.id
      && r.reason === 'laravel-can:endpoint-middleware:can:ticket.view';
  });
  assert.ok(endpointEdge);
  assert.ok(endpointEdge.confidence >= 0.9);
});

