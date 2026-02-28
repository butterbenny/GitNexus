import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../dist/core/ingestion/pipeline.js';

test('Laravel auth: authorizeResource(Model::class) wires controller resource methods to policy methods', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-auth-resource-'));
  const repoPath = path.join(tmpRoot, 'repo');

  await fs.mkdir(path.join(repoPath, 'app', 'Models'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'app', 'Policies'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'app', 'Providers'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'app', 'Http', 'Controllers'), { recursive: true });

  await fs.writeFile(
    path.join(repoPath, 'app', 'Models', 'Post.php'),
    [
      '<?php',
      '',
      'namespace App\\Models;',
      '',
      'class Post {}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'app', 'Policies', 'PostPolicy.php'),
    [
      '<?php',
      '',
      'namespace App\\Policies;',
      '',
      'use App\\Models\\Post;',
      '',
      'class PostPolicy {',
      '  public function viewAny() {}',
      '  public function view(Post $post) {}',
      '  public function create() {}',
      '  public function update(Post $post) {}',
      '  public function delete(Post $post) {}',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'app', 'Providers', 'AuthServiceProvider.php'),
    [
      '<?php',
      '',
      'namespace App\\Providers;',
      '',
      'use App\\Models\\Post;',
      'use App\\Policies\\PostPolicy;',
      '',
      'class AuthServiceProvider {',
      '  protected $policies = [',
      '    Post::class => PostPolicy::class,',
      '  ];',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  await fs.writeFile(
    path.join(repoPath, 'app', 'Http', 'Controllers', 'PostController.php'),
    [
      '<?php',
      '',
      'namespace App\\Http\\Controllers;',
      '',
      'use App\\Models\\Post;',
      '',
      'class PostController {',
      '  public function __construct() {',
      "    $this->authorizeResource(Post::class, 'post');",
      '  }',
      '',
      '  public function index() {}',
      '  public function show(Post $post) {}',
      '  public function update(Post $post) {}',
      '  public function destroy(Post $post) {}',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );

  const { graph } = await runPipelineFromRepo(repoPath, () => {});

  const controllerIndex = graph.nodes.find(n => n.label === 'Method' && n.properties?.filePath === 'app/Http/Controllers/PostController.php' && n.properties?.name === 'index');
  const controllerShow = graph.nodes.find(n => n.label === 'Method' && n.properties?.filePath === 'app/Http/Controllers/PostController.php' && n.properties?.name === 'show');
  const controllerUpdate = graph.nodes.find(n => n.label === 'Method' && n.properties?.filePath === 'app/Http/Controllers/PostController.php' && n.properties?.name === 'update');
  const controllerDestroy = graph.nodes.find(n => n.label === 'Method' && n.properties?.filePath === 'app/Http/Controllers/PostController.php' && n.properties?.name === 'destroy');
  assert.ok(controllerIndex);
  assert.ok(controllerShow);
  assert.ok(controllerUpdate);
  assert.ok(controllerDestroy);

  const policyViewAny = graph.nodes.find(n => n.label === 'Method' && n.properties?.filePath === 'app/Policies/PostPolicy.php' && n.properties?.name === 'viewAny');
  const policyView = graph.nodes.find(n => n.label === 'Method' && n.properties?.filePath === 'app/Policies/PostPolicy.php' && n.properties?.name === 'view');
  const policyUpdate = graph.nodes.find(n => n.label === 'Method' && n.properties?.filePath === 'app/Policies/PostPolicy.php' && n.properties?.name === 'update');
  const policyDelete = graph.nodes.find(n => n.label === 'Method' && n.properties?.filePath === 'app/Policies/PostPolicy.php' && n.properties?.name === 'delete');
  assert.ok(policyViewAny);
  assert.ok(policyView);
  assert.ok(policyUpdate);
  assert.ok(policyDelete);

  const findEdge = (from, to) => graph.relationships.find(r => r.type === 'CALLS' && r.sourceId === from.id && r.targetId === to.id);

  const indexEdge = findEdge(controllerIndex, policyViewAny);
  assert.ok(indexEdge);
  assert.equal(indexEdge.reason, 'laravel-authorize:resource:Post:index->viewAny');
  assert.ok(indexEdge.confidence >= 0.9);

  const showEdge = findEdge(controllerShow, policyView);
  assert.ok(showEdge);
  assert.equal(showEdge.reason, 'laravel-authorize:resource:Post:show->view');
  assert.ok(showEdge.confidence >= 0.9);

  const updateEdge = findEdge(controllerUpdate, policyUpdate);
  assert.ok(updateEdge);
  assert.equal(updateEdge.reason, 'laravel-authorize:resource:Post:update->update');
  assert.ok(updateEdge.confidence >= 0.9);

  const destroyEdge = findEdge(controllerDestroy, policyDelete);
  assert.ok(destroyEdge);
  assert.equal(destroyEdge.reason, 'laravel-authorize:resource:Post:destroy->delete');
  assert.ok(destroyEdge.confidence >= 0.9);
});

