import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import kuzu from 'kuzu';

test('Kuzu COPY: PARALLEL=true rejects multiline quoted fields (documented limitation)', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-kuzu-copy-'));
  const dbPath = path.join(tmpRoot, 'db');
  const csvPath = path.join(tmpRoot, 'data.csv');

  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);

  await conn.init();
  await conn.query('CREATE NODE TABLE Foo(id STRING, content STRING, PRIMARY KEY(id))');

  const expected = 'line1\nline2';
  const csv = [
    'id,content',
    `"a","${expected}"`,
    '',
  ].join('\n');
  await fs.writeFile(csvPath, csv, 'utf-8');

  const normalizedPath = csvPath.replace(/\\/g, '/');
  const copy = `COPY Foo(id, content) FROM "${normalizedPath}" (HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=true, auto_detect=false)`;
  await assert.rejects(
    async () => conn.query(copy),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /Quoted newlines are not supported in parallel CSV reader/i,
      );
      return true;
    },
  );

  await conn.close();
  await db.close();
});
