import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledgeGraph } from '../dist/core/graph/graph.js';
import { processContractShapes } from '../dist/core/ingestion/contract-shape-processor.js';

test('Contract shapes: extracts request/resource fields and cache-key invalidations', async () => {
  const graph = createKnowledgeGraph();

  const requestFile = 'app/Http/Requests/UpdateOrderRequest.php';
  const resourceFile = 'app/Http/Resources/OrderResource.php';
  const queryKeyFile = 'apps/dashboard/src/query-keys.ts';
  const invalidateFile = 'apps/dashboard/src/pages/orders.tsx';
  const requestTestFile = 'tests/Feature/Http/Requests/UpdateOrderRequestTest.php';
  const migrationFile = 'database/migrations/2026_01_01_000000_create_orders_table.php';

  graph.addNode({
    id: `File:${requestFile}`,
    label: 'File',
    properties: { name: 'UpdateOrderRequest.php', filePath: requestFile },
  });
  graph.addNode({
    id: `File:${resourceFile}`,
    label: 'File',
    properties: { name: 'OrderResource.php', filePath: resourceFile },
  });
  graph.addNode({
    id: `File:${queryKeyFile}`,
    label: 'File',
    properties: { name: 'query-keys.ts', filePath: queryKeyFile },
  });
  graph.addNode({
    id: `File:${invalidateFile}`,
    label: 'File',
    properties: { name: 'orders.tsx', filePath: invalidateFile },
  });
  graph.addNode({
    id: `File:${requestTestFile}`,
    label: 'File',
    properties: { name: 'UpdateOrderRequestTest.php', filePath: requestTestFile },
  });
  graph.addNode({
    id: `File:${migrationFile}`,
    label: 'File',
    properties: { name: '2026_01_01_000000_create_orders_table.php', filePath: migrationFile },
  });

  graph.addNode({
    id: 'Class:app/Http/Requests/UpdateOrderRequest.php:UpdateOrderRequest',
    label: 'Class',
    properties: { name: 'UpdateOrderRequest', filePath: requestFile },
  });
  graph.addNode({
    id: 'Class:app/Http/Resources/OrderResource.php:OrderResource',
    label: 'Class',
    properties: { name: 'OrderResource', filePath: resourceFile },
  });
  graph.addNode({
    id: 'Function:apps/dashboard/src/query-keys.ts:campaignQueryKeys.intents',
    label: 'Function',
    properties: { name: 'campaignQueryKeys.intents', filePath: queryKeyFile },
  });

  const files = [
    {
      path: requestFile,
      content: `
        <?php
        class UpdateOrderRequest extends FormRequest {
          public function rules(): array {
            return [
              'email' => ['required', 'email'],
              'name' => ['required', 'string'],
            ];
          }
        }
      `,
    },
    {
      path: resourceFile,
      content: `
        <?php
        class OrderResource extends JsonResource {
          public function toArray($request): array {
            return [
              'id' => $this->id,
              'status' => $this->status,
            ];
          }
        }
      `,
    },
    {
      path: invalidateFile,
      content: `
        queryClient.invalidateQueries({ queryKey: campaignQueryKeys.intents(eventId) });
        queryClient.invalidateQueries({ queryKey: ['supporters', eventId], exact: false });
      `,
    },
    {
      path: migrationFile,
      content: `
        <?php
        Schema::create('orders', function (Blueprint $table) {
          $table->id();
          $table->string('email');
          $table->string('name');
          $table->string('status');
          $table->timestamps();
        });
      `,
    },
    {
      path: requestTestFile,
      content: `
        <?php
        class UpdateOrderRequestTest extends TestCase {
          public function test_validates_the_expected_shape_fields(): void {
            $request = new UpdateOrderRequest();
            $resource = new OrderResource((object) ['id' => 1, 'status' => 'paid']);
            $this->assertNotNull($request);
            $this->assertNotNull($resource);
          }
        }
      `,
    },
  ];

  const result = await processContractShapes(graph, files);

  assert.ok(result.stats.shapeCount >= 2);
  assert.ok(result.stats.fieldCount >= 4);
  assert.ok(result.stats.cacheKeyCount >= 2);
  assert.ok(result.stats.dbTableCount >= 1);
  assert.ok(result.stats.dbColumnCount >= 4);
  assert.ok(result.stats.testCaseCount >= 1);
  assert.ok(result.stats.validatedFieldEdges >= 2);
  assert.ok(result.stats.serializedFieldEdges >= 2);
  assert.ok(result.stats.invalidationEdges >= 2);
  assert.ok(result.stats.derivesFromColumnEdges >= 2);
  assert.ok(result.stats.testsShapeEdges >= 1);

  const requestShape = result.shapes.find(shape => shape.shapeType === 'form_request');
  assert.ok(requestShape);
  const resourceShape = result.shapes.find(shape => shape.shapeType === 'resource');
  assert.ok(resourceShape);

  assert.ok(result.fields.some(field => field.fieldName === 'email'));
  assert.ok(result.fields.some(field => field.fieldName === 'status'));

  assert.ok(result.cacheKeys.some(key => key.keyType === 'query_key_factory' && key.keyName === 'campaignQueryKeys.intents'));
  assert.ok(result.cacheKeys.some(key => key.keyType === 'literal' && key.keyName === 'supporters'));
  assert.ok(result.dbTables.some(table => table.tableName === 'orders'));
  assert.ok(result.dbColumns.some(column => column.columnName === 'email'));
  assert.ok(result.testCases.some(testCase => testCase.filePath === requestTestFile));

  assert.ok(result.edges.some(edge => edge.type === 'VALIDATES_FIELD'));
  assert.ok(result.edges.some(edge => edge.type === 'SERIALIZES_FIELD'));
  assert.ok(result.edges.some(edge => edge.type === 'INVALIDATES_KEY'));
  assert.ok(result.edges.some(edge => edge.type === 'DERIVES_FROM_COLUMN'));
  assert.ok(result.edges.some(edge => edge.type === 'TESTS_SHAPE'));
});
