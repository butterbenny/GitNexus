import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NODE_TABLES, RELATION_SCHEMA, REL_TYPES } from '../dist/core/kuzu/schema.js';

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
  assert.match(RELATION_SCHEMA, /FROM CodeElement TO File/);
});

test('Kuzu schema: CodeRelation allows feature-slice memberships', () => {
  assert.match(RELATION_SCHEMA, /FROM Function TO FeatureSlice/);
  assert.match(RELATION_SCHEMA, /FROM Method TO FeatureSlice/);
  assert.match(RELATION_SCHEMA, /FROM CodeElement TO FeatureSlice/);
});

test('Kuzu schema: CodeRelation allows gap-to-slice links', () => {
  assert.match(RELATION_SCHEMA, /FROM Gap TO FeatureSlice/);
});

test('Kuzu schema: CodeRelation allows contract shape links', () => {
  assert.match(RELATION_SCHEMA, /FROM Class TO ContractShape/);
  assert.match(RELATION_SCHEMA, /FROM Class TO ContractField/);
  assert.match(RELATION_SCHEMA, /FROM CodeElement TO ContractField/);
  assert.match(RELATION_SCHEMA, /FROM ContractField TO ContractShape/);
});

test('Kuzu schema: CodeRelation allows cache key links', () => {
  assert.match(RELATION_SCHEMA, /FROM Function TO CacheKey/);
  assert.match(RELATION_SCHEMA, /FROM File TO CacheKey/);
});

test('Kuzu schema: CodeRelation allows value graph links', () => {
  assert.match(RELATION_SCHEMA, /FROM File TO ValueNode/);
  assert.match(RELATION_SCHEMA, /FROM Function TO ValueNode/);
  assert.match(RELATION_SCHEMA, /FROM Method TO ValueNode/);
  assert.match(RELATION_SCHEMA, /FROM CacheKey TO ValueNode/);
  assert.match(RELATION_SCHEMA, /FROM DBTable TO ValueNode/);
  assert.match(RELATION_SCHEMA, /FROM DBColumn TO ValueNode/);
});

test('Kuzu schema: CodeRelation allows static test closure links', () => {
  assert.match(RELATION_SCHEMA, /FROM File TO TestCase/);
  assert.match(RELATION_SCHEMA, /FROM TestCase TO ContractShape/);
});

test('Kuzu schema: relation type list includes git cochange edges', () => {
  assert.ok(REL_TYPES.includes('CO_CHANGES_WITH'));
});

test('Kuzu schema: relation type list includes provenance derives-from edges', () => {
  assert.ok(REL_TYPES.includes('DERIVES_FROM'));
});

test('Kuzu schema: CodeRelation persists edge metadata columns', () => {
  assert.match(RELATION_SCHEMA, /certaintyTier STRING/);
  assert.match(RELATION_SCHEMA, /provenanceFamily STRING/);
  assert.match(RELATION_SCHEMA, /absenceSemantics STRING/);
  assert.match(RELATION_SCHEMA, /witnessPathIds STRING/);
});

test('Kuzu schema: includes DBTable/DBColumn contract nodes', () => {
  assert.ok(NODE_TABLES.includes('DBTable'));
  assert.ok(NODE_TABLES.includes('DBColumn'));
});

test('Kuzu schema: CodeRelation allows ContractField -> DBColumn -> DBTable links', () => {
  assert.match(RELATION_SCHEMA, /FROM ContractField TO DBColumn/);
  assert.match(RELATION_SCHEMA, /FROM DBColumn TO DBTable/);
  assert.match(RELATION_SCHEMA, /FROM File TO DBTable/);
});
