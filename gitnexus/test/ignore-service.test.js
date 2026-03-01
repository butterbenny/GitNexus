import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldIgnorePath } from '../dist/config/ignore-service.js';

test('ignore-service: excludes local fixture corpus from indexing', () => {
  assert.equal(shouldIgnorePath('gitnexus-test-setup/fixture-laravel/routes/api.php'), true);
  assert.equal(shouldIgnorePath('nested/path/gitnexus-test-setup/fixture-laravel/apps/backend/routes/web.php'), true);
  assert.equal(shouldIgnorePath('src/mcp/local/local-backend.ts'), false);
});
