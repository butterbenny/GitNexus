import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../dist/core/ingestion/pipeline.js';
import { generateAllCSVs } from '../dist/core/kuzu/csv-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixtureRepoPath = path.resolve(__dirname, '../../gitnexus-test-setup/fixture-laravel');

const getNodes = (graph, label, filePath) => {
  return graph.nodes.filter(n => {
    if (label && n.label !== label) return false;
    if (filePath && n.properties?.filePath !== filePath) return false;
    return true;
  });
};

const getRelationships = (graph, type, sourceId) => {
  return graph.relationships.filter(r => {
    if (type && r.type !== type) return false;
    if (sourceId && r.sourceId !== sourceId) return false;
    return true;
  });
};

test('PHP: indexes classes and methods', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerClasses = getNodes(graph, 'Class', 'app/Http/Controllers/UserController.php')
    .filter(n => n.properties?.name === 'UserController');
  assert.equal(controllerClasses.length, 1);

  const controllerMethods = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .filter(n => n.properties?.name === 'index');
  assert.equal(controllerMethods.length, 1);

  const serviceClasses = getNodes(graph, 'Class', 'app/Services/TicketService.php')
    .filter(n => n.properties?.name === 'TicketService');
  assert.equal(serviceClasses.length, 1);

  const serviceMethods = getNodes(graph, 'Method', 'app/Services/TicketService.php');
  assert.ok(serviceMethods.some(n => n.properties?.name === 'handle'));
  assert.ok(serviceMethods.some(n => n.properties?.name === 'format'));

  const bladeSymbols = graph.nodes.filter(n => {
    if (String(n.properties?.filePath || '').endsWith('.blade.php') === false) return false;
    return n.label !== 'File' && n.label !== 'Template';
  });
  assert.equal(bladeSymbols.length, 0);
});

test('PHP: resolves imports from use statements', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const routeFileId = getNodes(graph, 'File', 'routes/web.php')[0]?.id;
  assert.ok(routeFileId);

  const routeImports = getRelationships(graph, 'IMPORTS', routeFileId);
  const importedPaths = new Set(
    routeImports
      .map(r => graph.nodes.find(n => n.id === r.targetId))
      .filter(Boolean)
      .map(n => n.properties.filePath)
  );

  assert.ok(importedPaths.has('app/Http/Controllers/UserController.php'));

  const controllerFileId = getNodes(graph, 'File', 'app/Http/Controllers/UserController.php')[0]?.id;
  assert.ok(controllerFileId);

  const controllerImports = getRelationships(graph, 'IMPORTS', controllerFileId);
  const controllerImportedPaths = new Set(
    controllerImports
      .map(r => graph.nodes.find(n => n.id === r.targetId))
      .filter(Boolean)
      .map(n => n.properties.filePath)
  );
  assert.ok(controllerImportedPaths.has('app/Services/TicketService.php'));
  assert.ok(controllerImportedPaths.has('app/Services/EmailService.php'));
  assert.ok(controllerImportedPaths.has('lib/Utils/Str.php'));

  const pkgConsumerFileId = getNodes(graph, 'File', 'packages/acme/src/Consumer.php')[0]?.id;
  assert.ok(pkgConsumerFileId);

  const pkgConsumerImports = getRelationships(graph, 'IMPORTS', pkgConsumerFileId);
  const pkgConsumerImportedPaths = new Set(
    pkgConsumerImports
      .map(r => graph.nodes.find(n => n.id === r.targetId))
      .filter(Boolean)
      .map(n => n.properties.filePath)
  );
  assert.ok(pkgConsumerImportedPaths.has('packages/acme/src/Utils/Helper.php'));
  assert.ok(!pkgConsumerImportedPaths.has('lib/Utils/Helper.php'));
});

test('PHP Laravel: routes wire to controller methods', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const routeFile = getNodes(graph, 'File', 'routes/web.php')[0];
  assert.ok(routeFile);

  const controllerMethod = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerMethod);

  const routeCalls = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === routeFile.id && r.targetId === controllerMethod.id;
  });
  assert.equal(routeCalls.length, 1);
  assert.equal(routeCalls[0].reason, 'laravel-route-import-resolved');
  assert.ok(routeCalls[0].confidence >= 0.9);
});

test('Laravel: route-name usage wires to controller methods', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const usersTemplate = getNodes(graph, 'Template', 'resources/views/users/index.blade.php')[0];
  assert.ok(usersTemplate);

  const templateRouteEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === usersTemplate.id
      && r.targetId === controllerIndex.id
      && String(r.reason || '').startsWith('route-name:users.index');
  });
  assert.equal(templateRouteEdges.length, 1);
  assert.ok(templateRouteEdges[0].confidence >= 0.9);

  const usersIndexUrl = getNodes(graph, 'Function', 'frontend/api.ts')
    .find(n => n.properties?.name === 'usersIndexUrl');
  assert.ok(usersIndexUrl);

  const tsRouteEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === usersIndexUrl.id
      && r.targetId === controllerIndex.id
      && String(r.reason || '').startsWith('route-name:users.index');
  });
  assert.equal(tsRouteEdges.length, 1);
  assert.ok(tsRouteEdges[0].confidence >= 0.9);

  const phpRouteHelper = getNodes(graph, 'Method', 'app/Services/EmailService.php')
    .find(n => n.properties?.name === 'usersIndexUrl');
  assert.ok(phpRouteHelper);

  const phpRouteEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === phpRouteHelper.id
      && r.targetId === controllerIndex.id
      && String(r.reason || '').startsWith('route-name:users.index');
  });
  assert.equal(phpRouteEdges.length, 1);
  assert.ok(phpRouteEdges[0].confidence >= 0.9);
});

test('PHP Laravel: events wire to listener and subscriber methods', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const eventProviderFile = getNodes(graph, 'File', 'app/Providers/EventServiceProvider.php')[0];
  assert.ok(eventProviderFile);

  const listenerHandle = getNodes(graph, 'Method', 'app/Listeners/SendWelcomeEmail.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(listenerHandle);

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const subscriberSubscribe = getNodes(graph, 'Method', 'app/Listeners/UserEventSubscriber.php')
    .find(n => n.properties?.name === 'subscribe');
  assert.ok(subscriberSubscribe);

  const listenEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === eventProviderFile.id && r.targetId === listenerHandle.id;
  });
  assert.equal(listenEdges.length, 0);

  const subscribeEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === eventProviderFile.id && r.targetId === subscriberSubscribe.id;
  });
  assert.equal(subscribeEdges.length, 1);
  assert.equal(subscribeEdges[0].reason, 'laravel-event-subscribe-import-resolved');
  assert.ok(subscribeEdges[0].confidence >= 0.9);

  const subscriberHandler = getNodes(graph, 'Method', 'app/Listeners/UserEventSubscriber.php')
    .find(n => n.properties?.name === 'onUserRegistered');
  assert.ok(subscriberHandler);

  const dispatchReasons = [
    'laravel-event-dispatch-helper-import-resolved',
    'laravel-event-dispatch-facade-import-resolved',
    'laravel-event-dispatch-static-import-resolved',
  ];

  for (const expectedReason of dispatchReasons) {
    const dispatchEdges = graph.relationships.filter(r => {
      return r.type === 'CALLS'
        && r.sourceId === controllerIndex.id
        && r.targetId === listenerHandle.id
        && r.reason === expectedReason;
    });
    assert.equal(dispatchEdges.length, 1);
    assert.ok(dispatchEdges[0].confidence >= 0.8);

    const subscriberEdges = graph.relationships.filter(r => {
      return r.type === 'CALLS'
        && r.sourceId === controllerIndex.id
        && r.targetId === subscriberHandler.id
        && r.reason === expectedReason;
    });
    assert.equal(subscriberEdges.length, 1);
    assert.ok(subscriberEdges[0].confidence >= 0.9);
  }
});

test('PHP Laravel: scheduler wires to job and command handlers', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const kernelFile = getNodes(graph, 'File', 'app/Console/Kernel.php')[0];
  assert.ok(kernelFile);

  const sendDigestHandle = getNodes(graph, 'Method', 'app/Jobs/SendDigestJob.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(sendDigestHandle);

  const cleanupHandle = getNodes(graph, 'Method', 'app/Jobs/CleanupJob.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(cleanupHandle);

  const commandHandle = getNodes(graph, 'Method', 'app/Console/Commands/SendDigestCommand.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(commandHandle);

  const sendDigestEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === kernelFile.id && r.targetId === sendDigestHandle.id;
  });
  assert.equal(sendDigestEdges.length, 1);
  assert.equal(sendDigestEdges[0].reason, 'laravel-schedule-job-import-resolved');
  assert.ok(sendDigestEdges[0].confidence >= 0.9);

  const cleanupEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === kernelFile.id && r.targetId === cleanupHandle.id;
  });
  assert.equal(cleanupEdges.length, 1);
  assert.equal(cleanupEdges[0].reason, 'laravel-schedule-job-import-resolved');
  assert.ok(cleanupEdges[0].confidence >= 0.9);

  const commandEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === kernelFile.id && r.targetId === commandHandle.id;
  });
  assert.equal(commandEdges.length, 1);
  assert.equal(commandEdges[0].reason, 'laravel-schedule-command-import-resolved');
  assert.ok(commandEdges[0].confidence >= 0.9);
});

test('PHP Laravel: job dispatch wires to job handlers', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const sendDigestHandle = getNodes(graph, 'Method', 'app/Jobs/SendDigestJob.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(sendDigestHandle);

  const cleanupHandle = getNodes(graph, 'Method', 'app/Jobs/CleanupJob.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(cleanupHandle);

  const staticDispatchEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === sendDigestHandle.id
      && r.reason === 'laravel-job-dispatch-static-import-resolved';
  });
  assert.equal(staticDispatchEdges.length, 1);
  assert.ok(staticDispatchEdges[0].confidence >= 0.9);

  const helperDispatchEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === cleanupHandle.id
      && r.reason === 'laravel-job-dispatch-helper-import-resolved';
  });
  assert.equal(helperDispatchEdges.length, 1);
  assert.ok(helperDispatchEdges[0].confidence >= 0.9);

  const helperSyncDispatchEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === cleanupHandle.id
      && r.reason === 'laravel-job-dispatch-helper-sync-import-resolved';
  });
  assert.equal(helperSyncDispatchEdges.length, 1);
  assert.ok(helperSyncDispatchEdges[0].confidence >= 0.9);
});

test('PHP: call edges resolve within-file and via imports', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const ticketHandle = getNodes(graph, 'Method', 'app/Services/TicketService.php')
    .find(n => n.properties?.name === 'handle');
  assert.ok(ticketHandle);

  const ticketFormat = getNodes(graph, 'Method', 'app/Services/TicketService.php')
    .find(n => n.properties?.name === 'format');
  assert.ok(ticketFormat);

  const strUpper = getNodes(graph, 'Method', 'lib/Utils/Str.php')
    .find(n => n.properties?.name === 'upper');
  assert.ok(strUpper);

  const indexCallsHandle = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === controllerIndex.id && r.targetId === ticketHandle.id;
  });
  assert.equal(indexCallsHandle.length, 1);
  assert.equal(indexCallsHandle[0].reason, 'import-resolved');
  assert.ok(indexCallsHandle[0].confidence >= 0.9);

  const indexCallsUpper = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === controllerIndex.id && r.targetId === strUpper.id;
  });
  assert.equal(indexCallsUpper.length, 1);
  assert.equal(indexCallsUpper[0].reason, 'import-resolved');
  assert.ok(indexCallsUpper[0].confidence >= 0.9);

  const handleCallsFormat = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === ticketHandle.id && r.targetId === ticketFormat.id;
  });
  assert.equal(handleCallsFormat.length, 1);
  assert.equal(handleCallsFormat[0].reason, 'same-file');
  assert.ok(handleCallsFormat[0].confidence >= 0.85);
});

test('Blade: indexes templates and template relationships', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const welcome = getNodes(graph, 'Template', 'resources/views/emails/welcome.blade.php')[0];
  assert.ok(welcome);
  assert.equal(welcome.properties?.name, 'emails.welcome');

  const layout = getNodes(graph, 'Template', 'resources/views/layouts/app.blade.php')[0];
  assert.ok(layout);
  assert.equal(layout.properties?.name, 'layouts.app');

  const footer = getNodes(graph, 'Template', 'resources/views/emails/partials/footer.blade.php')[0];
  assert.ok(footer);
  assert.equal(footer.properties?.name, 'emails.partials.footer');

  const button = getNodes(graph, 'Template', 'resources/views/components/button.blade.php')[0];
  assert.ok(button);
  assert.equal(button.properties?.name, 'components.button');

  const extendsRels = graph.relationships.filter(r => {
    return r.type === 'EXTENDS' && r.sourceId === welcome.id && r.targetId === layout.id;
  });
  assert.equal(extendsRels.length, 1);
  assert.equal(extendsRels[0].reason, 'blade-extends');
  assert.equal(extendsRels[0].confidence, 1.0);

  const importRels = graph.relationships.filter(r => {
    return r.type === 'IMPORTS' && r.sourceId === welcome.id;
  });
  const importedIds = new Set(importRels.map(r => r.targetId));
  assert.ok(importedIds.has(footer.id));
  assert.ok(importedIds.has(button.id));
});

test('Blade: @vite wires templates to asset files', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const layout = getNodes(graph, 'Template', 'resources/views/layouts/app.blade.php')[0];
  assert.ok(layout);

  const appAsset = getNodes(graph, 'File', 'resources/js/app.ts')[0];
  assert.ok(appAsset);

  const layoutViteEdges = graph.relationships.filter(r => {
    return r.type === 'IMPORTS'
      && r.sourceId === layout.id
      && r.targetId === appAsset.id
      && r.reason === 'blade-vite';
  });
  assert.equal(layoutViteEdges.length, 1);
  assert.equal(layoutViteEdges[0].confidence, 1.0);

  const nested = getNodes(graph, 'Template', 'apps/backend/resources/views/emails/nested.blade.php')[0];
  assert.ok(nested);

  const nestedAsset = getNodes(graph, 'File', 'apps/backend/resources/js/nested.ts')[0];
  assert.ok(nestedAsset);

  const nestedViteEdges = graph.relationships.filter(r => {
    return r.type === 'IMPORTS'
      && r.sourceId === nested.id
      && r.targetId === nestedAsset.id
      && r.reason === 'blade-vite';
  });
  assert.equal(nestedViteEdges.length, 1);
  assert.equal(nestedViteEdges[0].confidence, 1.0);
});

test('Laravel: view and mail wire to Blade templates', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const welcome = getNodes(graph, 'Template', 'resources/views/emails/welcome.blade.php')[0];
  assert.ok(welcome);

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const mailableBuild = getNodes(graph, 'Method', 'app/Mail/WelcomeMail.php')
    .find(n => n.properties?.name === 'build');
  assert.ok(mailableBuild);

  const controllerViewEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === controllerIndex.id && r.targetId === welcome.id && r.reason === 'laravel-view';
  });
  assert.equal(controllerViewEdges.length, 1);
  assert.equal(controllerViewEdges[0].confidence, 1.0);

  const mailableViewEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === mailableBuild.id && r.targetId === welcome.id && r.reason === 'laravel-mailable-view';
  });
  assert.equal(mailableViewEdges.length, 1);

  const mailSendEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === controllerIndex.id && r.targetId === welcome.id && String(r.reason || '').startsWith('laravel-mail-send-mailable:');
  });
  assert.equal(mailSendEdges.length, 1);
  assert.ok(mailSendEdges[0].confidence >= 0.8);
});

test('Laravel: view wiring resolves Blade templates under nested app roots', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const nested = getNodes(graph, 'Template', 'apps/backend/resources/views/emails/nested.blade.php')[0];
  assert.ok(nested);
  assert.equal(nested.properties?.name, 'emails.nested');

  const nestedIndex = getNodes(graph, 'Method', 'apps/backend/app/Http/Controllers/NestedController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(nestedIndex);

  const nestedViewEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === nestedIndex.id && r.targetId === nested.id && r.reason === 'laravel-view';
  });
  assert.equal(nestedViewEdges.length, 1);
  assert.equal(nestedViewEdges[0].confidence, 1.0);
});

test('Kuzu CSV: generates Template table rows', async () => {
  const { graph, fileContents } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const csvData = generateAllCSVs(graph, fileContents);
  const templateCSV = csvData.nodes.get('Template');
  assert.ok(templateCSV);
  assert.ok(templateCSV.startsWith('id,name,filePath,startLine,endLine,content'));
  assert.ok(templateCSV.includes('resources/views/emails/welcome.blade.php'));
});

test('Svelte: TypeScript imports resolve to .svelte files', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const mainFileId = getNodes(graph, 'File', 'frontend/main.ts')[0]?.id;
  assert.ok(mainFileId);

  const imports = getRelationships(graph, 'IMPORTS', mainFileId);
  const importedPaths = new Set(
    imports
      .map(r => graph.nodes.find(n => n.id === r.targetId))
      .filter(Boolean)
      .map(n => n.properties.filePath)
  );

  assert.ok(importedPaths.has('frontend/components/Button.svelte'));
});

test('Svelte: indexes <script> symbols and resolves calls via imports', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const svelteFile = getNodes(graph, 'File', 'frontend/components/Button.svelte')[0];
  assert.ok(svelteFile);

  const utilsFile = getNodes(graph, 'File', 'frontend/utils.ts')[0];
  assert.ok(utilsFile);

  const buttonLabelFn = getNodes(graph, 'Function', 'frontend/components/Button.svelte')
    .find(n => n.properties?.name === 'getButtonLabel');
  assert.ok(buttonLabelFn);

  const formatLabelFn = getNodes(graph, 'Function', 'frontend/utils.ts')
    .find(n => n.properties?.name === 'formatLabel');
  assert.ok(formatLabelFn);

  const svelteImports = graph.relationships.filter(r => {
    return r.type === 'IMPORTS' && r.sourceId === svelteFile.id && r.targetId === utilsFile.id;
  });
  assert.equal(svelteImports.length, 1);

  const calls = graph.relationships.filter(r => {
    return r.type === 'CALLS' && r.sourceId === buttonLabelFn.id && r.targetId === formatLabelFn.id;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'import-resolved');
  assert.ok(calls[0].confidence >= 0.9);
});

test('Full-stack: frontend HTTP calls wire to Laravel controller methods', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const fetchUsers = getNodes(graph, 'Function', 'frontend/api.ts')
    .find(n => n.properties?.name === 'fetchUsers');
  assert.ok(fetchUsers);

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const httpEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === fetchUsers.id
      && r.targetId === controllerIndex.id
      && r.reason === 'http-get:/api/users';
  });
  assert.equal(httpEdges.length, 1);
  assert.ok(httpEdges[0].confidence >= 0.9);
});
