import fs from 'fs/promises';
import kuzu from 'kuzu';

const dbPath = '/tmp/gitnexus-kuzu-show-indexes';
await fs.rm(dbPath, { force: true }).catch(() => {});

const db = new kuzu.Database(dbPath);
const conn = new kuzu.Connection(db);

const close = async (qr) => {
  if (!qr) return;
  const arr = Array.isArray(qr) ? qr : [qr];
  for (const r of arr) {
    try { await r.close(); } catch {}
  }
};

const queryAll = async (q) => {
  const qr = await conn.query(q);
  const arr = Array.isArray(qr) ? qr : [qr];
  try {
    const rows = await arr[0].getAll();
    return rows;
  } finally {
    await close(arr);
  }
};

await close(await conn.query("CREATE NODE TABLE Foo(id STRING, content STRING, PRIMARY KEY(id))"));
await close(await conn.query('INSTALL fts'));
await close(await conn.query('LOAD EXTENSION fts'));
await close(await conn.query("CALL CREATE_FTS_INDEX('Foo', 'foo_fts_idx', ['content'], stemmer := 'porter')"));

const indexes = await queryAll('CALL SHOW_INDEXES() RETURN *');
console.log(indexes);

await conn.close();
await db.close();
