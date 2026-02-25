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

