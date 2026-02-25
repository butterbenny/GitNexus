import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../dist/core/ingestion/pipeline.js';

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

test('Laravel notifications: notify, route->notify, and Notification::send wire to via + channels', async () => {
  const { graph } = await runPipelineFromRepo(fixtureRepoPath, () => {});

  const controllerIndex = getNodes(graph, 'Method', 'app/Http/Controllers/UserController.php')
    .find(n => n.properties?.name === 'index');
  assert.ok(controllerIndex);

  const notificationVia = getNodes(graph, 'Method', 'app/Notifications/WelcomeNotification.php')
    .find(n => n.properties?.name === 'via');
  assert.ok(notificationVia);

  const notificationToMail = getNodes(graph, 'Method', 'app/Notifications/WelcomeNotification.php')
    .find(n => n.properties?.name === 'toMail');
  assert.ok(notificationToMail);

  const notificationToSlack = getNodes(graph, 'Method', 'app/Notifications/WelcomeNotification.php')
    .find(n => n.properties?.name === 'toSlack');
  assert.ok(notificationToSlack);

  const smsNotificationVia = getNodes(graph, 'Method', 'app/Notifications/SmsNotification.php')
    .find(n => n.properties?.name === 'via');
  assert.ok(smsNotificationVia);

  const smsNotificationToTwilio = getNodes(graph, 'Method', 'app/Notifications/SmsNotification.php')
    .find(n => n.properties?.name === 'toTwilio');
  assert.ok(smsNotificationToTwilio);

  const welcomeBlade = getNodes(graph, 'Template', 'resources/views/emails/welcome.blade.php')[0];
  assert.ok(welcomeBlade);

  const expectedReasons = [
    'laravel-notify-notify',
    'laravel-notify-notify-route',
    'laravel-notify-send',
  ];

  for (const prefix of expectedReasons) {
    const viaEdges = graph.relationships.filter(r => {
      return r.type === 'CALLS'
        && r.sourceId === controllerIndex.id
        && r.targetId === notificationVia.id
        && r.reason === `${prefix}-via-import-resolved`;
    });
    assert.equal(viaEdges.length, 1);

    const toMailEdges = graph.relationships.filter(r => {
      return r.type === 'CALLS'
        && r.sourceId === controllerIndex.id
        && r.targetId === notificationToMail.id
        && r.reason === `${prefix}-to-mail-import-resolved`;
    });
    assert.equal(toMailEdges.length, 1);

    const toSlackEdges = graph.relationships.filter(r => {
      return r.type === 'CALLS'
        && r.sourceId === controllerIndex.id
        && r.targetId === notificationToSlack.id
        && r.reason === `${prefix}-to-slack-import-resolved`;
    });
    assert.equal(toSlackEdges.length, 1);
  }

  const smsViaEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === smsNotificationVia.id
      && r.reason === 'laravel-notify-notify-via-import-resolved';
  });
  assert.equal(smsViaEdges.length, 1);

  const smsTwilioEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === controllerIndex.id
      && r.targetId === smsNotificationToTwilio.id
      && r.reason === 'laravel-notify-notify-to-twilio-import-resolved';
  });
  assert.equal(smsTwilioEdges.length, 1);

  const bladeEdges = graph.relationships.filter(r => {
    return r.type === 'CALLS'
      && r.sourceId === notificationToMail.id
      && r.targetId === welcomeBlade.id
      && r.reason === 'laravel-mailable-view';
  });
  assert.equal(bladeEdges.length, 1);
});
