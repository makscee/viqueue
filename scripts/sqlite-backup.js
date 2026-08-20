#!/usr/bin/env node
import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const [sourcePath, destinationPath] = process.argv.slice(2).map((value) => value && path.resolve(value));
if (!sourcePath || !destinationPath || sourcePath === destinationPath) throw new Error('usage: sqlite-backup.js SOURCE DESTINATION');
if (!existsSync(sourcePath)) throw new Error('source database does not exist');
if (existsSync(destinationPath) || existsSync(`${destinationPath}-wal`) || existsSync(`${destinationPath}-shm`)) throw new Error('destination database already exists');
const temporary = `${destinationPath}.tmp.${process.pid}`;
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const inspect = (db) => {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('database integrity check failed');
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const names = new Set(schema.filter((row) => row.type === 'table').map((row) => row.name));
  for (const required of ['projects', 'tickets', 'events']) if (!names.has(required)) throw new Error(`expected viqueue table is missing: ${required}`);
  const counts = Object.fromEntries([...names].filter((name) => !name.startsWith('sqlite_')).sort().map((name) => [name, Number(db.prepare(`SELECT COUNT(*) count FROM ${quote(name)}`).get().count)]));
  return { schema: JSON.stringify(schema), counts: JSON.stringify(counts), userVersion: Number(db.prepare('PRAGMA user_version').get().user_version) };
};
let source;
try {
  rmSync(temporary, { force: true }); rmSync(`${temporary}-wal`, { force: true }); rmSync(`${temporary}-shm`, { force: true });
  source = new DatabaseSync(sourcePath, { readOnly: true });
  const expected = inspect(source);
  await backup(source, temporary);
  source.close(); source = undefined;
  const copy = new DatabaseSync(temporary, { readOnly: true });
  const actual = inspect(copy); copy.close();
  if (actual.schema !== expected.schema || actual.counts !== expected.counts || actual.userVersion !== expected.userVersion) throw new Error('backup schema or row counts differ from source');
  renameSync(temporary, destinationPath);
} catch (error) {
  try { source?.close(); } catch {}
  rmSync(temporary, { force: true }); rmSync(`${temporary}-wal`, { force: true }); rmSync(`${temporary}-shm`, { force: true });
  throw error;
}
