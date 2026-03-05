import fs from 'fs/promises';
import kuzu from 'kuzu';

const dbPath = '/tmp/gitnexus-kuzu-fts-drop-test4';
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

const run = async (q) => {
  const qr = await conn.query(q);
  await close(qr);
};

await run("CREATE NODE TABLE Foo(id STRING, content STRING, PRIMARY KEY(id))");
await run('INSTALL fts');
await run('LOAD EXTENSION fts');
await run("CALL CREATE_FTS_INDEX('Foo', 'foo_fts_idx', ['content'], stemmer := 'porter')");

try {
  await run('DROP TABLE Foo');
  console.log('drop Foo ok');
} catch (e) {
  console.error('drop Foo failed', e?.message || e);
}

await conn.close();
await db.close();
