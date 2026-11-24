// Recreates the local test database from supabase/tests/stub.sql + every migration.
// Needs a local Postgres 15+ with user postgres / password postgres (override with PG* env vars).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const db = process.env.PGDATABASE_TEST || 'cwc_test';
const base = { host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || 'postgres' };

export async function resetLocal({ quiet = false } = {}) {
  const admin = new pg.Client({ ...base, database: 'postgres' });
  await admin.connect();
  await admin.query(`drop database if exists ${db} with (force)`);
  await admin.query(`create database ${db}`);
  for (const r of ['anon', 'authenticated', 'service_role', 'authenticator']) {
    const { rowCount } = await admin.query('select 1 from pg_roles where rolname = $1', [r]);
    if (rowCount) await admin.query(`drop owned by ${r} cascade`).catch(() => {});
  }
  await admin.end();

  const c = new pg.Client({ ...base, database: db });
  await c.connect();
  if (!quiet) c.on('notice', (n) => console.log('  notice:', n.message));
  let stub = readFileSync(join(here, 'stub.sql'), 'utf8');
  // roles are cluster-wide: create them only once
  const { rows } = await c.query(`select count(*)::int n from pg_roles where rolname in ('anon','authenticated','service_role','authenticator')`);
  if (rows[0].n === 4) stub = stub.split('\n').filter((l) => !/^(create role|grant anon)/.test(l)).join('\n');
  await c.query(stub);
  const migDir = join(here, '..', 'migrations');
  for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
    await c.query(readFileSync(join(migDir, f), 'utf8'));
    if (!quiet) console.log('applied', f);
  }
  await c.end();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  resetLocal().then(() => console.log('local database ready:', db)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
