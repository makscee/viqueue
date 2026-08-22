#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2); const args = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const key = argv[i].slice(2); args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
const file = args.storage;
const preserve = args['preserve-device'];
const actorId = args.actor;
const name = args.name;
const apply = args.confirm === 'RESET-ALPHA';
if (!file || !preserve || !actorId || !name) {
  console.error('usage: reset-dogfood-v2 --storage FILE --preserve-device ID --actor ID --name NAME [--dry-run | --confirm RESET-ALPHA]');
  process.exit(2);
}
if (!args['dry-run'] && !apply) { console.error('refusing apply: pass literal --confirm RESET-ALPHA (or --dry-run)'); process.exit(2); }
const db = new DatabaseSync(file, { readOnly: !apply });
db.exec('PRAGMA foreign_keys=ON');
const device = db.prepare('SELECT id,name,kind,status FROM devices WHERE id=?').get(preserve);
if (!device) { console.error(`preserved device ${preserve} not found`); process.exit(1); }
const counts = Object.fromEntries(['projects','tickets','roles','devices','actors'].map((table) => [table, Number(db.prepare(`SELECT count(*) n FROM ${table}`).get().n)]));
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', preserve_device: device.id, admin_actor: actorId, admin_name: name, remove: counts }));
if (!apply) { db.close(); process.exit(0); }
db.exec('BEGIN IMMEDIATE');
try {
  const now = Date.now();
  db.prepare("INSERT INTO actors(id,name,kind,active,created_at,updated_at,admin) VALUES(?,?,'human',1,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind='human',active=1,role_id=NULL,admin=1,updated_at=excluded.updated_at").run(actorId, name, now, now);
  db.prepare('UPDATE devices SET actor_id=?,status=\'active\',revoked_at=NULL WHERE id=?').run(actorId, preserve);
  db.exec(`DELETE FROM pairing_codes; DELETE FROM questions; DELETE FROM ticket_blocks; DELETE FROM claims; DELETE FROM events;
    DELETE FROM ticket_projects; DELETE FROM tickets; DELETE FROM projects; DELETE FROM device_roles; DELETE FROM actor_roles;
    DELETE FROM roles; DELETE FROM devices WHERE id <> '${preserve.replaceAll("'", "''")}'; DELETE FROM actors WHERE id <> '${actorId.replaceAll("'", "''")}';`);
  db.exec('COMMIT');
  console.log(JSON.stringify({ applied: true, preserved_device: preserve, admin_actor: actorId }));
} catch (error) { try { db.exec('ROLLBACK'); } catch {} console.error(`reset failed: ${error.message}`); process.exitCode = 1; }
db.close();
