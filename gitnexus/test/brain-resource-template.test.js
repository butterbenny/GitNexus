import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getResourceTemplates } from '../dist/mcp/resources.js';

test('MCP resources: brain manifest template is available', () => {
  const templates = getResourceTemplates();
  const brainTemplate = templates.find(item => item.uriTemplate === 'gitnexus://repo/{name}/brain');
  assert.ok(brainTemplate);
  assert.equal(brainTemplate?.mimeType, 'text/yaml');
});
