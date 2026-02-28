import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../dist/core/ingestion/pipeline.js';

test('Laravel auth: $this->authorize($model->permissionHelper()) derives permission enum case edges via match-return', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auth-derived-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'app', 'Http', 'Controllers'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'app', 'Domains', 'CustomFields', 'Models'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'app', 'Domains', 'AccessControl', 'Permissions'), { recursive: true });

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
    path.join(repoPath, 'app', 'Domains', 'AccessControl', 'Permissions', 'TransactionPermission.php'),
    [
      '<?php',
      '',
      'namespace App\\Domains\\AccessControl\\Permissions;',
      '',
      'enum TransactionPermission: string {',
      "  case VIEW = 'transaction.view';",
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'app', 'Domains', 'AccessControl', 'Permissions', 'ContactPermission.php'),
    [
      '<?php',
      '',
      'namespace App\\Domains\\AccessControl\\Permissions;',
      '',
      'enum ContactPermission: string {',
      "  case VIEW = 'contact.view';",
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'app', 'Domains', 'CustomFields', 'Models', 'CustomFieldResponse.php'),
    [
      '<?php',
      '',
      'namespace App\\Domains\\CustomFields\\Models;',
      '',
      'use App\\Domains\\AccessControl\\Permissions\\ContactPermission;',
      'use App\\Domains\\AccessControl\\Permissions\\TicketPermission;',
      'use App\\Domains\\AccessControl\\Permissions\\TransactionPermission;',
      '',
      'class CustomFieldResponse {',
      '  public string $model_type = \"\";',
      '',
      '  public function getViewPermission() {',
      '    return match ($this->model_type) {',
      "      'contact' => ContactPermission::VIEW,",
      "      'transaction' => TransactionPermission::VIEW,",
      "      'ticket' => TicketPermission::VIEW,",
      '    };',
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'app', 'Http', 'Controllers', 'CustomFieldResponseController.php'),
    [
      '<?php',
      '',
      'namespace App\\Http\\Controllers;',
      '',
      'use App\\Domains\\CustomFields\\Models\\CustomFieldResponse;',
      '',
      'class CustomFieldResponseController {',
      '  public function accessFile(CustomFieldResponse $customFieldResponse) {',
      '    $this->authorize($customFieldResponse->getViewPermission(), []);',
      '  }',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  const { graph } = await runPipelineFromRepo(repoPath, () => {});

  const controllerMethod = graph.nodes.find(n => {
    return n.label === 'Method'
      && n.properties?.filePath === 'app/Http/Controllers/CustomFieldResponseController.php'
      && n.properties?.name === 'accessFile';
  });
  assert.ok(controllerMethod);

  const ticketView = graph.nodes.find(n => {
    return n.label === 'Const'
      && n.properties?.filePath === 'app/Domains/AccessControl/Permissions/TicketPermission.php'
      && n.properties?.name === 'VIEW';
  });
  assert.ok(ticketView);

  const transactionView = graph.nodes.find(n => {
    return n.label === 'Const'
      && n.properties?.filePath === 'app/Domains/AccessControl/Permissions/TransactionPermission.php'
      && n.properties?.name === 'VIEW';
  });
  assert.ok(transactionView);

  const contactView = graph.nodes.find(n => {
    return n.label === 'Const'
      && n.properties?.filePath === 'app/Domains/AccessControl/Permissions/ContactPermission.php'
      && n.properties?.name === 'VIEW';
  });
  assert.ok(contactView);

  const derivedEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerMethod.id
      && String(r.reason || '').startsWith('laravel-authorize:derived:CustomFieldResponse::getViewPermission:php-match-return:');
  });

  const derivedTargets = new Set(derivedEdges.map(e => e.targetId));
  assert.ok(derivedTargets.has(ticketView.id));
  assert.ok(derivedTargets.has(transactionView.id));
  assert.ok(derivedTargets.has(contactView.id));

  for (const edge of derivedEdges) {
    assert.ok(edge.confidence >= 0.9);
  }
});

