import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import kuzu from 'kuzu';

test('Kuzu: supports UNWIND with list-of-struct params', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-kuzu-unwind-'));
  const dbPath = path.join(tmpRoot, 'db');

  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);

  await conn.init();
  await conn.query('CREATE NODE TABLE T(id STRING, val INT64, PRIMARY KEY(id))');

  const stmt = await conn.prepare('UNWIND $rows AS row CREATE (t:T {id: row.id, val: row.val})');
  assert.equal(stmt.isSuccess(), true);

  const execRes = await conn.execute(stmt, { rows: [{ id: 'a', val: 1 }, { id: 'b', val: 2 }] });
  if (Array.isArray(execRes)) execRes.forEach(r => r.close());
  else execRes.close();

  const result = await conn.query('MATCH (t:T) RETURN count(t) AS cnt');
  const rows = await result.getAll();
  result.close();

  assert.equal(rows[0]?.cnt, 2);

  await conn.close();
  await db.close();
});

