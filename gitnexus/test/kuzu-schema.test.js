import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RELATION_SCHEMA } from '../dist/core/kuzu/schema.js';

test('Kuzu schema: CodeRelation allows Function/Method -> Trait/Typedef/Union', () => {
  assert.match(RELATION_SCHEMA, /FROM Function TO `Trait`/);
  assert.match(RELATION_SCHEMA, /FROM Function TO `Typedef`/);
  assert.match(RELATION_SCHEMA, /FROM Function TO `Union`/);

  assert.match(RELATION_SCHEMA, /FROM Method TO `Trait`/);
  assert.match(RELATION_SCHEMA, /FROM Method TO `Typedef`/);
  assert.match(RELATION_SCHEMA, /FROM Method TO `Union`/);
});

test('Kuzu schema: CodeRelation allows edges -> Const', () => {
  assert.match(RELATION_SCHEMA, /FROM Function TO `Const`/);
  assert.match(RELATION_SCHEMA, /FROM Method TO `Const`/);
  assert.match(RELATION_SCHEMA, /FROM CodeElement TO `Const`/);
});

test('Kuzu schema: CodeRelation allows permission slug wiring', () => {
  // laravel-permissions-config-processor emits:
  // - Role (CodeElement) -> permission slug (CodeElement)
  // - Enum case (Const) -> permission slug (CodeElement)
  assert.match(RELATION_SCHEMA, /FROM CodeElement TO CodeElement/);
  assert.match(RELATION_SCHEMA, /FROM `Const` TO CodeElement/);
});

test('Kuzu schema: CodeRelation allows endpoint wiring', () => {
  // Endpoint nodes are CodeElement, wired from frontend callables and to backend handlers.
  assert.match(RELATION_SCHEMA, /FROM Function TO CodeElement/);
  assert.match(RELATION_SCHEMA, /FROM Method TO CodeElement/);
  assert.match(RELATION_SCHEMA, /FROM CodeElement TO Method/);
});
