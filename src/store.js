import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export class DomainError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const hash = (token) => createHash('sha256').update(token).digest();
const cleanOptional = (value, field) => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new DomainError(400, `invalid_${field}`, `${field} must be text or null`);
  return value.trim() || null;
};
const stableId = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const parseMetadata = (value) => value ? JSON.parse(value) : null;
const serializeMetadata = (value) => {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new DomainError(400, 'invalid_metadata', 'metadata must be a JSON object');
  return JSON.stringify(value);
};
const fileSha256 = (file) => new Promise((resolve, reject) => {
  const digest = createHash('sha256'), stream = createReadStream(file);
  stream.on('error', reject); stream.on('data', (chunk) => digest.update(chunk)); stream.on('end', () => resolve(digest.digest('hex')));
});
const exists = async (file) => stat(file).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
const syncPath = async (target) => {
  const handle = await open(target, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
};
const v11Binding = (db) => {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='_viqueue_migration_family'").get()) return null;
  try {
    const rows = db.prepare('SELECT migration,family_token FROM _viqueue_migration_family').all();
    if (rows.length !== 1 || rows[0].migration !== 'VIQ-11' || !/^[a-f0-9]{64}$/.test(rows[0].family_token)) throw new Error('contradictory binding');
    return rows[0].family_token;
  } catch { throw new DomainError(409, 'invalid_migration_snapshot', 'VIQ-11 database family binding is invalid'); }
};
const bindV11Family = (db, familyToken) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE _viqueue_migration_family (migration TEXT PRIMARY KEY,family_token TEXT NOT NULL) STRICT');
    db.prepare("INSERT INTO _viqueue_migration_family(migration,family_token) VALUES('VIQ-11',?)").run(familyToken);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
};
const validateV11Snapshot = async (source, snapshot, manifestFile) => {
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); } catch { throw new DomainError(409, 'invalid_migration_snapshot', 'VIQ-11 snapshot manifest is missing or invalid'); }
  if (manifest?.format !== 2 || manifest?.migration !== 'VIQ-11' || manifest?.source !== source || !/^[a-f0-9]{64}$/.test(manifest?.sha256) || !/^[a-f0-9]{64}$/.test(manifest?.familyToken)) throw new DomainError(409, 'invalid_migration_snapshot', 'VIQ-11 snapshot manifest is not trusted for this database');
  if ((await fileSha256(snapshot)) !== manifest.sha256) throw new DomainError(409, 'invalid_migration_snapshot', 'VIQ-11 snapshot authentication failed');
  const check = new DatabaseSync(snapshot, { readOnly: true });
  try {
    if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || Number(check.prepare('PRAGMA user_version').get().user_version) >= 11) throw new DomainError(409, 'invalid_migration_snapshot', 'VIQ-11 rollback snapshot is not a valid pre-migration database');
  } finally { check.close(); }
  return manifest;
};
const unstampedV11Recovery = () => new DomainError(409, 'migration_snapshot_recovery_required', 'VIQ-11 snapshot exists but the live database has no durable family token; operator recovery is required');

export class Store {
  #file; #now; #db; #v11Plan = null; #cleanSlateFailure;
  constructor(file, { now = Date.now, cleanSlateFailure = null } = {}) { this.#file = file; this.#now = now; this.#cleanSlateFailure = cleanSlateFailure; }

  static async rollbackV11(file) {
    const source = path.resolve(file), snapshot = `${source}.pre-viq11.sqlite`, manifestFile = `${snapshot}.manifest.json`, temporary = `${source}.rollback.${process.pid}`;
    const manifest = await validateV11Snapshot(source, snapshot, manifestFile);
    const live = new DatabaseSync(source, { readOnly: true });
    try {
      const binding = v11Binding(live);
      if (!binding) throw unstampedV11Recovery();
      if (binding !== manifest.familyToken) throw new DomainError(409, 'invalid_migration_snapshot', 'VIQ-11 snapshot belongs to a different database family');
    } finally { live.close(); }
    await rm(temporary, { force: true });
    await copyFile(snapshot, temporary);
    await validateV11Snapshot(source, temporary, manifestFile);
    const preserved = `${source}.post-viq11.${Date.now()}`;
    await rename(source, preserved);
    for (const suffix of ['-wal','-shm']) { try { await rename(`${source}${suffix}`, `${preserved}${suffix}`); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    await rename(temporary, source);
    return { restored: source, preserved };
  }

  async init() {
    await mkdir(path.dirname(path.resolve(this.#file)), { recursive: true });
    this.#db = new DatabaseSync(this.#file);
    this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    await this.#prepareV11Migration();
    this.#db.exec('PRAGMA journal_mode=WAL;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (key TEXT PRIMARY KEY,next_number INTEGER NOT NULL,created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(key),number INTEGER NOT NULL,title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',state TEXT NOT NULL CHECK(state IN ('open','review','done')),assigned_to TEXT,
        assignment TEXT NOT NULL DEFAULT 'Unassigned' CHECK(assignment IN ('Unassigned','Human','Agent')),
        created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(project,number)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS claims (
        claim_id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),actor TEXT NOT NULL,generation INTEGER NOT NULL,
        token_hash BLOB NOT NULL,claimed_at INTEGER NOT NULL,released_at INTEGER,UNIQUE(ticket_id,generation)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS claims_one_current ON claims(ticket_id) WHERE released_at IS NULL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,ticket_id TEXT REFERENCES tickets(id),project TEXT REFERENCES projects(key),
        type TEXT NOT NULL,actor TEXT,message TEXT,created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_project_cursor ON events(project,id);
      CREATE INDEX IF NOT EXISTS events_ticket_cursor ON events(ticket_id,id);
    `);
    this.#migrate();
    this.#finishV11Migration();
  }

  async #prepareV11Migration() {
    const source = path.resolve(this.#file), destination = `${source}.pre-viq11.sqlite`, manifest = `${destination}.manifest.json`;
    const [hasSnapshot, hasManifest] = await Promise.all([exists(destination), exists(manifest)]);
    const binding = v11Binding(this.#db);
    let sealed = null;
    if (hasSnapshot || hasManifest) {
      if (!hasSnapshot || !hasManifest) throw new DomainError(409, 'invalid_migration_snapshot', 'VIQ-11 snapshot family is incomplete; refusing to overwrite it');
      sealed = await validateV11Snapshot(source, destination, manifest);
      if (!binding) throw unstampedV11Recovery();
      if (binding !== sealed.familyToken) throw new DomainError(409, 'invalid_migration_snapshot', 'VIQ-11 snapshot belongs to a different database family');
    } else if (binding) throw new DomainError(409, 'invalid_migration_snapshot', 'VIQ-11 bound database is missing its snapshot family');
    const hasTickets = this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tickets'").get();
    if (!hasTickets || Number(this.#db.prepare('PRAGMA user_version').get().user_version) >= 11) return;
    const ticketColumns = this.#columns('tickets');
    const hasMemberships = this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ticket_projects'").get();
    const hasEvents = this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='events'").get();
    const eventHasProject = hasEvents && this.#columns('events').includes('project');
    const tickets = this.#db.prepare('SELECT * FROM tickets ORDER BY id').all();
    const plan = [];
    for (const ticket of tickets) {
      const memberships = hasMemberships ? this.#db.prepare('SELECT project_key FROM ticket_projects WHERE ticket_id=? ORDER BY project_key').all(ticket.id).map((row) => row.project_key) : [ticket.project];
      const eventProjects = eventHasProject ? this.#db.prepare('SELECT DISTINCT project FROM events WHERE ticket_id=? AND project IS NOT NULL ORDER BY project').all(ticket.id).map((row) => row.project) : [];
      const projectExists = this.#db.prepare('SELECT 1 FROM projects WHERE key=?').get(ticket.project);
      if (!projectExists || !memberships.includes(ticket.project) || eventProjects.some((project) => project !== ticket.project)) throw new DomainError(409, 'unsafe_project_migration', `ticket ${ticket.id} has contradictory project provenance`);
      if (!Number.isSafeInteger(ticket.number) || ticket.number < 1 || ticket.id !== `${ticket.project}-${ticket.number}`) throw new DomainError(409, 'unsafe_ticket_identity_migration', `ticket ${ticket.id} has contradictory identity`);
      let assignment = ticketColumns.includes('assignment') ? ticket.assignment : null;
      if (!assignment) {
        const hasClaims = this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='claims'").get();
        const activeClaim = hasClaims && this.#db.prepare(`SELECT actor,${this.#columns('claims').includes('device_id') ? 'device_id' : 'NULL device_id'} FROM claims WHERE ticket_id=? AND released_at IS NULL`).get(ticket.id);
        if (activeClaim) {
          const legacyIdentity = ticket.assignee_id ?? ticket.assigned_to;
          if (legacyIdentity && ![activeClaim.actor, activeClaim.device_id].includes(legacyIdentity)) throw new DomainError(409, 'unsafe_assignment_migration', `ticket ${ticket.id} claim contradicts assignment`);
          assignment = 'Agent';
        } else if (!ticket.assignee_type && !ticket.assignee_id && !ticket.assigned_to) assignment = 'Unassigned';
        else {
          const identity = ticket.assignee_id ?? ticket.assigned_to;
          let kinds = [];
          const hasActors = this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='actors'").get();
          const hasDevices = this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='devices'").get();
          if (hasActors && ticket.assignee_type === 'role') kinds = this.#db.prepare('SELECT DISTINCT kind FROM actors WHERE role_id=?').all(identity).map((row) => row.kind);
          else if (hasActors) {
            const actor = this.#db.prepare('SELECT kind FROM actors WHERE id=?').get(identity) ?? (hasDevices ? this.#db.prepare('SELECT a.kind FROM devices d JOIN actors a ON a.id=d.actor_id WHERE d.id=?').get(identity) : null);
            if (actor) kinds = [actor.kind];
          }
          if (kinds.length !== 1 || !['human', 'agent'].includes(kinds[0])) throw new DomainError(409, 'unsafe_assignment_migration', `ticket ${ticket.id} assignment is ambiguous`);
          assignment = kinds[0] === 'human' ? 'Human' : 'Agent';
        }
      }
      if (!['Unassigned', 'Human', 'Agent'].includes(assignment)) throw new DomainError(409, 'unsafe_assignment_migration', `ticket ${ticket.id} assignment is invalid`);
      plan.push({ id: ticket.id, project: ticket.project, assignment });
    }
    if (!sealed) {
      const temporary = `${destination}.tmp.${process.pid}`, temporaryManifest = `${manifest}.tmp.${process.pid}`;
      await rm(temporary, { force: true }); await rm(temporaryManifest, { force: true });
      await backup(this.#db, temporary); await syncPath(temporary);
      sealed = { format: 2, migration: 'VIQ-11', source, sha256: await fileSha256(temporary), familyToken: randomBytes(32).toString('hex') };
      await writeFile(temporaryManifest, `${JSON.stringify(sealed)}\n`, { mode: 0o600 }); await syncPath(temporaryManifest);
      await rename(temporary, destination); await syncPath(path.dirname(destination));
      await rename(temporaryManifest, manifest); await syncPath(path.dirname(manifest));
      bindV11Family(this.#db, sealed.familyToken);
    }
    this.#v11Plan = plan;
  }

  #finishV11Migration() {
    if (Number(this.#db.prepare('PRAGMA user_version').get().user_version) >= 11) return;
    this.#transaction(() => {
      if (!this.#columns('tickets').includes('assignment')) this.#db.exec("ALTER TABLE tickets ADD COLUMN assignment TEXT NOT NULL DEFAULT 'Unassigned' CHECK(assignment IN ('Unassigned','Human','Agent'))");
      const deletedTicketGuards = this.#db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name IN ('deleted_tickets_immutable','tickets_audit_preserved') AND tbl_name='tickets' ORDER BY name").all();
      for (const guard of deletedTicketGuards) this.#db.exec(`DROP TRIGGER "${guard.name}"`);
      for (const row of this.#v11Plan ?? []) {
        this.#db.prepare('UPDATE tickets SET assignment=? WHERE id=? AND assignment<>?').run(row.assignment, row.id, row.assignment);
        if (this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ticket_projects'").get()) this.#db.prepare('DELETE FROM ticket_projects WHERE ticket_id=? AND project_key<>?').run(row.id, row.project);
      }
      for (const guard of deletedTicketGuards) this.#db.exec(guard.sql);
      this.#db.exec('UPDATE projects SET next_number=MAX(next_number,COALESCE((SELECT MAX(number)+1 FROM tickets WHERE tickets.project=projects.key),1)); PRAGMA user_version=11');
    });
    this.#v11Plan = null;
  }

  #columns(table) { return this.#db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name); }
  #migrate() {
    this.#transaction(() => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS actors (
          id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('human','agent')),machine TEXT,
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
          role_id TEXT REFERENCES roles(id),admin INTEGER NOT NULL DEFAULT 0 CHECK(admin IN (0,1))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('coordinator','worker')),
          token_hash BLOB NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','revoked')),
          created_at INTEGER NOT NULL,revoked_at INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS pairing_codes (
          code_hash BLOB PRIMARY KEY,intended_kind TEXT NOT NULL CHECK(intended_kind IN ('coordinator','worker')),
          expires_at INTEGER NOT NULL,used_at INTEGER,created_by_device_id TEXT NOT NULL REFERENCES devices(id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS worker_sessions (
          id TEXT PRIMARY KEY,capability_hash BLOB NOT NULL,device_id TEXT NOT NULL REFERENCES devices(id),
          created_at INTEGER NOT NULL,revoked_at INTEGER
        ) STRICT;
        CREATE INDEX IF NOT EXISTS worker_sessions_device ON worker_sessions(device_id,revoked_at);
        CREATE TABLE IF NOT EXISTS device_roles (
          device_id TEXT NOT NULL REFERENCES devices(id),role_id TEXT NOT NULL REFERENCES roles(id),PRIMARY KEY(device_id,role_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS actor_roles (
          actor_id TEXT NOT NULL REFERENCES actors(id),role_id TEXT NOT NULL REFERENCES roles(id),PRIMARY KEY(actor_id,role_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS questions (
          id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),asked_by TEXT NOT NULL REFERENCES actors(id),
          target_type TEXT NOT NULL CHECK(target_type IN ('actor','role')),target_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('text','approval')),text TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','answered')),
          answer TEXT,answered_by TEXT REFERENCES actors(id),created_at INTEGER NOT NULL,answered_at INTEGER
        ) STRICT;
        CREATE INDEX IF NOT EXISTS questions_ticket ON questions(ticket_id,created_at,id);
        CREATE TABLE IF NOT EXISTS submission_authority (
          request_id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL,actor TEXT NOT NULL,device_id TEXT NOT NULL,session_id TEXT NOT NULL,
          claim_id TEXT NOT NULL,claim_token_hash BLOB NOT NULL,generation INTEGER NOT NULL,question_id TEXT NOT NULL,
          submitted_event_id INTEGER NOT NULL,question_event_id INTEGER NOT NULL,created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TRIGGER IF NOT EXISTS submission_authority_immutable_update BEFORE UPDATE ON submission_authority BEGIN SELECT RAISE(ABORT,'submission authority is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS submission_authority_immutable_delete BEFORE DELETE ON submission_authority BEGIN SELECT RAISE(ABORT,'submission authority is immutable'); END;
        CREATE TABLE IF NOT EXISTS ticket_blocks (
          id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),created_by TEXT NOT NULL REFERENCES actors(id),
          reason TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','resolved')),created_at INTEGER NOT NULL,
          resolved_by TEXT REFERENCES actors(id),resolved_at INTEGER
        ) STRICT;
        CREATE INDEX IF NOT EXISTS ticket_blocks_open ON ticket_blocks(ticket_id,status,created_at);
        CREATE TABLE IF NOT EXISTS ticket_tombstones (
          ticket_id TEXT PRIMARY KEY,project TEXT NOT NULL,number INTEGER NOT NULL,deleted_at INTEGER NOT NULL,
          deleted_by_actor TEXT NOT NULL,deleted_by_device TEXT NOT NULL,delete_event_id INTEGER NOT NULL UNIQUE,
          FOREIGN KEY(ticket_id) REFERENCES tickets(id),FOREIGN KEY(deleted_by_actor) REFERENCES actors(id),
          FOREIGN KEY(deleted_by_device) REFERENCES devices(id),FOREIGN KEY(delete_event_id) REFERENCES events(id),
          UNIQUE(project,number)
        ) STRICT;
        CREATE TRIGGER IF NOT EXISTS ticket_tombstones_immutable_update BEFORE UPDATE ON ticket_tombstones BEGIN SELECT RAISE(ABORT,'ticket tombstones are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ticket_tombstones_immutable_delete BEFORE DELETE ON ticket_tombstones BEGIN SELECT RAISE(ABORT,'ticket tombstones are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS tickets_audit_preserved BEFORE DELETE ON tickets WHEN OLD.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'deleted ticket audit cannot be physically deleted'); END;
      `);
      const actorColumns = this.#columns('actors');
      if (!actorColumns.includes('machine')) this.#db.exec('ALTER TABLE actors ADD COLUMN machine TEXT');
      if (!actorColumns.includes('updated_at')) { this.#db.exec('ALTER TABLE actors ADD COLUMN updated_at INTEGER'); this.#db.exec('UPDATE actors SET updated_at=created_at WHERE updated_at IS NULL'); }
      if (!actorColumns.includes('role_id')) this.#db.exec('ALTER TABLE actors ADD COLUMN role_id TEXT REFERENCES roles(id)');
      if (!actorColumns.includes('admin')) this.#db.exec('ALTER TABLE actors ADD COLUMN admin INTEGER NOT NULL DEFAULT 0 CHECK(admin IN (0,1))');
      const deviceColumns = this.#columns('devices');
      if (!deviceColumns.includes('actor_id')) this.#db.exec('ALTER TABLE devices ADD COLUMN actor_id TEXT REFERENCES actors(id)');
      const pairingColumns = this.#columns('pairing_codes');
      if (!pairingColumns.includes('actor_id')) this.#db.exec('ALTER TABLE pairing_codes ADD COLUMN actor_id TEXT REFERENCES actors(id)');
      if (!pairingColumns.includes('device_id')) this.#db.exec('ALTER TABLE pairing_codes ADD COLUMN device_id TEXT');
      if (!pairingColumns.includes('device_name')) this.#db.exec('ALTER TABLE pairing_codes ADD COLUMN device_name TEXT');
      const claimColumns = this.#columns('claims');
      if (!claimColumns.includes('device_id')) this.#db.exec('ALTER TABLE claims ADD COLUMN device_id TEXT REFERENCES devices(id)');
      if (!claimColumns.includes('session_id')) this.#db.exec('ALTER TABLE claims ADD COLUMN session_id TEXT');
      this.#db.exec('CREATE UNIQUE INDEX IF NOT EXISTS claims_one_current_device ON claims(device_id) WHERE released_at IS NULL AND device_id IS NOT NULL');
      const ticketColumns = this.#columns('tickets');
      if (!ticketColumns.includes('board_state')) {
        this.#db.exec("ALTER TABLE tickets ADD COLUMN board_state TEXT NOT NULL DEFAULT 'Open' CHECK(board_state IN ('Open','Working','Waiting','Done'))");
        this.#db.exec("UPDATE tickets SET board_state=CASE state WHEN 'done' THEN 'Done' WHEN 'review' THEN 'Waiting' ELSE 'Open' END");
      }
      if (!ticketColumns.includes('board_order')) {
        this.#db.exec('ALTER TABLE tickets ADD COLUMN board_order INTEGER NOT NULL DEFAULT 0');
        this.#db.exec('UPDATE tickets SET board_order=updated_at*1000000+rowid');
      }
      this.#db.exec(`CREATE TRIGGER IF NOT EXISTS tickets_updated_to_top AFTER UPDATE OF updated_at ON tickets
        WHEN NEW.updated_at<>OLD.updated_at BEGIN
          UPDATE tickets SET board_order=(SELECT COALESCE(MAX(board_order),0)+1 FROM tickets) WHERE id=NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS tickets_legacy_state_insert AFTER INSERT ON tickets BEGIN
          UPDATE tickets SET board_state=CASE NEW.state WHEN 'done' THEN 'Done' WHEN 'review' THEN 'Waiting' ELSE 'Open' END WHERE id=NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS tickets_legacy_state_sync AFTER UPDATE OF state ON tickets
        WHEN NEW.state<>OLD.state AND NEW.board_state=OLD.board_state BEGIN
          UPDATE tickets SET board_state=CASE NEW.state WHEN 'done' THEN 'Done' WHEN 'review' THEN 'Waiting' ELSE 'Open' END WHERE id=NEW.id;
        END`);
      if (!ticketColumns.includes('assignee_type')) this.#db.exec('ALTER TABLE tickets ADD COLUMN assignee_type TEXT');
      if (!ticketColumns.includes('assignee_id')) this.#db.exec('ALTER TABLE tickets ADD COLUMN assignee_id TEXT');
      if (!ticketColumns.includes('archived_at')) this.#db.exec('ALTER TABLE tickets ADD COLUMN archived_at INTEGER');
      if (!ticketColumns.includes('deleted_at')) this.#db.exec('ALTER TABLE tickets ADD COLUMN deleted_at INTEGER');
      this.#db.exec("CREATE TRIGGER IF NOT EXISTS deleted_tickets_immutable BEFORE UPDATE ON tickets WHEN OLD.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'deleted tickets are immutable'); END");
      const questionColumns = this.#columns('questions');
      if (!questionColumns.includes('question_event_id')) this.#db.exec('ALTER TABLE questions ADD COLUMN question_event_id INTEGER');
      if (!questionColumns.includes('blocking')) this.#db.exec("ALTER TABLE questions ADD COLUMN blocking INTEGER NOT NULL DEFAULT 0 CHECK(blocking IN (0,1))");
      if (!questionColumns.includes('asked_by_role')) this.#db.exec('ALTER TABLE questions ADD COLUMN asked_by_role TEXT');
      if (!questionColumns.includes('asked_by_device_id')) this.#db.exec('ALTER TABLE questions ADD COLUMN asked_by_device_id TEXT');
      if (!questionColumns.includes('asked_by_session_id')) this.#db.exec('ALTER TABLE questions ADD COLUMN asked_by_session_id TEXT');
      if (!questionColumns.includes('answered_by_role')) this.#db.exec('ALTER TABLE questions ADD COLUMN answered_by_role TEXT');
      if (!questionColumns.includes('answered_by_device_id')) this.#db.exec('ALTER TABLE questions ADD COLUMN answered_by_device_id TEXT');
      if (!questionColumns.includes('answer_request_id')) this.#db.exec('ALTER TABLE questions ADD COLUMN answer_request_id TEXT');
      if (!questionColumns.includes('submission_request_id')) this.#db.exec('ALTER TABLE questions ADD COLUMN submission_request_id TEXT');
      this.#db.exec("UPDATE questions SET blocking=1 WHERE kind='approval'");
      this.#db.exec('CREATE UNIQUE INDEX IF NOT EXISTS questions_answer_request ON questions(answer_request_id) WHERE answer_request_id IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS questions_submission_request ON questions(submission_request_id) WHERE submission_request_id IS NOT NULL');
      if (this.#db.prepare("PRAGMA table_info(events)").all().find((r) => r.name === 'project')?.notnull) {
        this.#db.exec(`
          DROP INDEX IF EXISTS events_project_cursor; DROP INDEX IF EXISTS events_ticket_cursor;
          ALTER TABLE events RENAME TO events_legacy;
          CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,ticket_id TEXT REFERENCES tickets(id),project TEXT REFERENCES projects(key),
            type TEXT NOT NULL,actor TEXT,message TEXT,created_at INTEGER NOT NULL,metadata TEXT
          ) STRICT;
          INSERT INTO events(id,ticket_id,project,type,actor,message,created_at) SELECT id,ticket_id,project,type,actor,message,created_at FROM events_legacy;
          DROP TABLE events_legacy;
          CREATE INDEX events_project_cursor ON events(project,id); CREATE INDEX events_ticket_cursor ON events(ticket_id,id);
        `);
      }
      const eventColumns = this.#columns('events');
      if (!eventColumns.includes('metadata')) this.#db.exec('ALTER TABLE events ADD COLUMN metadata TEXT');
      if (!eventColumns.includes('device_id')) this.#db.exec('ALTER TABLE events ADD COLUMN device_id TEXT REFERENCES devices(id)');
      // Existing rows receive the best factual snapshot available from authoritative actor/device state at migration time.
      const needsActorRoleSnapshot = !eventColumns.includes('actor_role');
      const needsMachineSnapshot = !eventColumns.includes('machine_name');
      if (needsActorRoleSnapshot) this.#db.exec('ALTER TABLE events ADD COLUMN actor_role TEXT');
      if (needsMachineSnapshot) this.#db.exec('ALTER TABLE events ADD COLUMN machine_name TEXT');
      if (needsActorRoleSnapshot) this.#db.exec('UPDATE events SET actor_role=(SELECT role_id FROM actors WHERE actors.id=events.actor)');
      if (needsMachineSnapshot) this.#db.exec('UPDATE events SET machine_name=(SELECT name FROM devices WHERE devices.id=events.device_id)');
      this.#db.exec(`CREATE TRIGGER IF NOT EXISTS events_immutable_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS events_immutable_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;`);
      this.#db.exec(`CREATE TABLE IF NOT EXISTS ticket_projects (
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,project_key TEXT NOT NULL REFERENCES projects(key),
        PRIMARY KEY(ticket_id,project_key)
      ) STRICT`);
      this.#db.exec('INSERT OR IGNORE INTO ticket_projects(ticket_id,project_key) SELECT id,project FROM tickets');
      this.#db.exec("UPDATE questions SET question_event_id=(SELECT id FROM events WHERE type='question_asked' AND json_extract(metadata,'$.question_id')=questions.id ORDER BY id LIMIT 1) WHERE question_event_id IS NULL");
      const legacy = this.#db.prepare(`SELECT assigned_to value FROM tickets WHERE assigned_to IS NOT NULL UNION SELECT actor value FROM claims`).all();
      for (const { value } of legacy) {
        if (typeof value !== 'string' || !value.trim()) throw new DomainError(409, 'unsafe_actor_migration', 'legacy actor identity is empty');
        const now = this.#now();
        this.#db.prepare("INSERT OR IGNORE INTO actors(id,name,kind,machine,active,created_at,updated_at) VALUES(?,?,'agent',NULL,1,?,?)").run(value, value, now, now);
        this.#db.prepare("UPDATE tickets SET assignee_type='actor',assignee_id=? WHERE assigned_to=? AND assignee_type IS NULL").run(value, value);
      }
      this.#db.exec("UPDATE devices SET actor_id=id WHERE actor_id IS NULL");
      this.#db.exec("UPDATE actors SET admin=1 WHERE id IN (SELECT actor_id FROM devices WHERE kind='coordinator') AND NOT EXISTS(SELECT 1 FROM actors WHERE admin=1)");
      this.#db.exec("UPDATE claims SET device_id=actor WHERE device_id IS NULL AND actor IN (SELECT id FROM devices)");
      this.#db.exec("UPDATE claims SET actor=(SELECT actor_id FROM devices WHERE devices.id=claims.device_id) WHERE device_id IS NOT NULL");
      this.#db.exec("UPDATE actor_roles SET role_id=(SELECT role_id FROM actors WHERE actors.id=actor_roles.actor_id) WHERE 0");
    });
  }

  async close() { this.#db?.close(); this.#db = null; }
  #transaction(fn) { this.#db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.#db.exec('COMMIT'); return value; } catch (error) { try { this.#db.exec('ROLLBACK'); } catch {} throw error; } }
  #event(ticketId, project, type, actor = null, message = null, metadata = null, deviceId = null) {
    if (ticketId && type !== 'ticket_reordered') this.#db.prepare('UPDATE tickets SET updated_at=?,board_order=(SELECT COALESCE(MAX(board_order),0)+1 FROM tickets) WHERE id=?').run(this.#now(), ticketId);
    if (actor) { const device = this.#db.prepare('SELECT id,actor_id FROM devices WHERE id=?').get(actor); if (device) { deviceId ??= device.id; actor = device.actor_id; } }
    const actorRole = actor ? this.#db.prepare('SELECT role_id FROM actors WHERE id=?').get(actor)?.role_id ?? null : null;
    const machineName = deviceId ? this.#db.prepare('SELECT name FROM devices WHERE id=?').get(deviceId)?.name ?? null : null;
    return Number(this.#db.prepare('INSERT INTO events(ticket_id,project,type,actor,message,created_at,metadata,device_id,actor_role,machine_name) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(ticketId, project, type, actor, message, this.#now(), serializeMetadata(metadata), deviceId, actorRole, machineName).lastInsertRowid);
  }
  #eventRow(id) { const row = this.#db.prepare(`SELECT id cursor,ticket_id,project,type,actor,device_id,message,metadata,created_at,actor_role,machine_name machine FROM events WHERE id=?`).get(id); return { ...row, metadata: parseMetadata(row.metadata) }; }
  #project(raw) { const key = String(raw ?? '').toUpperCase(); const row = this.#db.prepare('SELECT key,next_number,created_at FROM projects WHERE key=?').get(key); if (!row) throw new DomainError(404, 'project_not_found', `project ${key} not found`); return { key: row.key, next_number: row.next_number, created_at: row.created_at }; }
  #requiredProject(raw) { if (typeof raw !== 'string' || !/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(raw.trim())) throw new DomainError(400, 'invalid_project', 'a valid nonempty project is required'); return this.#project(raw.trim()).key; }
  #actorRow(raw) { return this.#db.prepare('SELECT id,name,kind,machine,active,role_id,admin,created_at,updated_at FROM actors WHERE id=?').get(String(raw ?? '')) ?? this.#db.prepare('SELECT id,name,kind,machine,active,role_id,admin,created_at,updated_at FROM actors WHERE id=?').get(stableId(raw)); }
  #actor(raw, { active = true } = {}) {
    const row = this.#actorRow(raw);
    if (!row) throw new DomainError(404, 'actor_not_found', `actor ${stableId(raw)} not found`);
    if (active && !row.active) throw new DomainError(409, 'actor_inactive', `actor ${row.id} is inactive`);
    return { ...row, active: Boolean(row.active), admin: Boolean(row.admin) };
  }
  #workflowActor(raw) { const device = this.#db.prepare('SELECT actor_id FROM devices WHERE id=?').get(stableId(raw)); return this.#actor(device?.actor_id ?? raw); }
  #human(raw) { const actor = this.#workflowActor(raw); if (actor.kind !== 'human') throw new DomainError(403, 'human_required', 'a human actor is required'); return actor; }
  #role(raw) { const id = stableId(raw); const row = this.#db.prepare('SELECT id,name,created_at FROM roles WHERE id=?').get(id); if (!row) throw new DomainError(404, 'role_not_found', `role ${id} not found`); return row; }
  #device(raw, { active = true, kind } = {}) { const id = stableId(raw); const row = this.#db.prepare('SELECT d.id,d.name,d.kind,d.status,d.actor_id,a.name actor_name,a.role_id,a.admin,a.active actor_active,d.created_at,d.revoked_at FROM devices d LEFT JOIN actors a ON a.id=d.actor_id WHERE d.id=?').get(id); if (!row) throw new DomainError(401, 'device_unpaired', 'paired device credential is required'); if (active && (row.status !== 'active' || !row.actor_id || !row.actor_active)) throw new DomainError(401, row.status !== 'active' ? 'device_revoked' : 'actor_inactive', 'device or actor is inactive'); if (kind && row.kind !== kind) throw new DomainError(403, `${kind}_required`, `${kind} device is required`); return { ...row, admin: Boolean(row.admin), actor_active: Boolean(row.actor_active) }; }
  #adminDevice(raw) { const device = this.#device(raw); if (!device.admin) throw new DomainError(403, device.kind === 'worker' ? 'coordinator_required' : 'admin_required', device.kind === 'worker' ? 'coordinator device is required' : 'active admin actor is required'); return device; }
  #activeRoleHolder(roleId, { worker = false } = {}) { return this.#db.prepare(`SELECT 1 FROM actors a JOIN devices d ON d.actor_id=a.id WHERE a.role_id=? AND a.active=1 AND d.status='active'${worker ? " AND d.kind='worker'" : ''} LIMIT 1`).get(roleId); }
  #target(value, { assignment = false, actorActive = assignment } = {}) {
    const allowed = assignment ? ['device', 'actor', 'role'] : ['actor', 'device', 'role'];
    if (!value || !allowed.includes(value.type) || !value.id) throw new DomainError(400, assignment ? 'assignee_ineligible' : 'invalid_question_target', 'target must identify a device or role');
    let id = stableId(value.id); const type = value.type === 'device' ? 'actor' : value.type;
    if (type === 'actor') {
      if (assignment) { try { const actor = this.#actor(value.id); if (!this.#db.prepare("SELECT 1 FROM devices WHERE actor_id=? AND kind='worker' AND status='active'").get(actor.id)) throw new DomainError(409, 'assignee_ineligible', 'actor has no active worker device'); id = actor.id; } catch (error) { throw new DomainError(409, 'assignee_ineligible', error.message); } }
      else { try { id = this.#actor(value.id, { active: actorActive }).id; } catch (error) { throw error; } }
    } else {
      try { this.#role(id); } catch (error) { if (assignment) throw new DomainError(409, 'assignee_ineligible', error.message); throw error; }
      if (!this.#activeRoleHolder(id, { worker: assignment })) throw new DomainError(409, assignment ? 'assignee_ineligible' : 'question_forbidden', `role ${id} has no active paired ${assignment ? 'worker' : 'holder'}`);
    }
    return { type, id };
  }
  #row(id, { includeDeleted = false } = {}) { const row = this.#db.prepare(`SELECT t.id,t.project,t.number,t.title,t.body,t.state,t.assigned_to,t.assignment,t.created_at,t.updated_at,t.board_state,CAST(t.board_order AS TEXT) board_order,t.assignee_type,t.assignee_id,t.archived_at,t.deleted_at,c.claim_id,c.actor claim_actor,c.device_id claim_device_id,c.session_id claim_session_id,d.name claim_machine,c.generation,c.claimed_at,(SELECT COUNT(*) FROM ticket_blocks b WHERE b.ticket_id=t.id AND b.status='open') unresolved_blockers,(SELECT COUNT(*) FROM questions q WHERE q.ticket_id=t.id AND q.status='open') open_questions FROM tickets t LEFT JOIN claims c ON c.ticket_id=t.id AND c.released_at IS NULL LEFT JOIN devices d ON d.id=c.device_id WHERE t.id=?${includeDeleted ? '' : ' AND t.deleted_at IS NULL'}`).get(id); if (!row) throw new DomainError(404, 'ticket_not_found', `ticket ${id} not found`); return row; }
  #effectiveBoardState(row) { return row.claim_id ? 'Working' : (row.board_state ?? (row.state === 'done' ? 'Done' : row.state === 'review' ? 'Waiting' : 'Open')); }
  #publicTicket(row) { const claim = row.claim_id ? { claim_id: row.claim_id, actor: row.claim_actor, device_id: row.claim_device_id ?? null, machine: row.claim_machine ?? null, session_id: row.claim_session_id ?? null, generation: row.generation, claimed_at: row.claimed_at } : null; const state = this.#effectiveBoardState(row); return { id: row.id, project: row.project, title: row.title, description: row.body, assignment: row.assignment ?? 'Unassigned', assigned_worker: row.assignment === 'Agent' && row.assignee_type === 'actor' && row.assignee_id ? { id: row.assignee_id, name: this.#actor(row.assignee_id, { active: false }).name } : null, state, board_order: Number(row.board_order ?? 0), open_questions: Number(row.open_questions ?? 0), archived_at: row.archived_at ?? null, deleted_at: row.deleted_at ?? null, created_at: row.created_at, updated_at: row.updated_at, claim, unresolved_blockers: Number(row.unresolved_blockers ?? 0) }; }
  #ticket(id, options) { return this.#publicTicket(this.#row(id, options)); }
  #mutableTicket(id) { const ticket = this.#ticket(id, { includeDeleted: true }); if (ticket.deleted_at !== null) throw new DomainError(409, 'ticket_deleted', 'deleted tickets are immutable tombstones'); if (ticket.archived_at !== null) throw new DomainError(409, 'ticket_archived', 'archived tickets are immutable until restored'); return ticket; }
  #title(value) { if (typeof value !== 'string' || !value.trim()) throw new DomainError(400, 'invalid_title', 'title is required'); return value.trim(); }

  async createProject(raw) { return this.#transaction(() => { const key = String(raw ?? '').toUpperCase(); if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw new DomainError(400, 'invalid_project_key', 'project key must be 2-10 uppercase letters or digits'); try { this.#db.prepare('INSERT INTO projects(key,next_number,created_at) VALUES(?,1,?)').run(key, this.#now()); } catch (error) { if (error.code?.startsWith('ERR_SQLITE_CONSTRAINT')) throw new DomainError(409, 'project_exists', `project ${key} already exists`); throw error; } return this.#project(key); }); }
  async listProjects() { return this.#db.prepare('SELECT key,next_number,created_at FROM projects ORDER BY key').all(); }
  async cleanSlateProjectsAndTickets() { return this.#transaction(() => {
    const count = (table) => Number(this.#db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
    const removed = { projects: count('projects'), tickets: count('tickets'), claims: count('claims'), questions: count('questions'), blocks: count('ticket_blocks'), tombstones: count('ticket_tombstones'), submission_authorities: count('submission_authority'), ticket_projects: count('ticket_projects'), events: Number(this.#db.prepare('SELECT count(*) n FROM events WHERE ticket_id IS NOT NULL OR project IS NOT NULL').get().n) };
    this.#db.exec(`
      DROP TRIGGER submission_authority_immutable_delete;
      DROP TRIGGER ticket_tombstones_immutable_delete;
      DROP TRIGGER events_immutable_delete;
      DROP TRIGGER tickets_audit_preserved;
      DELETE FROM submission_authority;
      DELETE FROM ticket_tombstones;
      DELETE FROM questions;
      DELETE FROM ticket_blocks;
      DELETE FROM claims;
      DELETE FROM ticket_projects;
      DELETE FROM events WHERE ticket_id IS NOT NULL OR project IS NOT NULL;
    `);
    if (this.#cleanSlateFailure) this.#cleanSlateFailure();
    this.#db.exec(`
      DELETE FROM tickets;
      DELETE FROM projects;
      CREATE TRIGGER submission_authority_immutable_delete BEFORE DELETE ON submission_authority BEGIN SELECT RAISE(ABORT,'submission authority is immutable'); END;
      CREATE TRIGGER ticket_tombstones_immutable_delete BEFORE DELETE ON ticket_tombstones BEGIN SELECT RAISE(ABORT,'ticket tombstones are immutable'); END;
      CREATE TRIGGER events_immutable_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events are immutable'); END;
      CREATE TRIGGER tickets_audit_preserved BEFORE DELETE ON tickets WHEN OLD.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'deleted ticket audit cannot be physically deleted'); END;
    `);
    return { success: true, removed };
  }); }

  #insertDevice({ id, name, kind, actor_id: actorId }, token, createdAt = this.#now()) { const key = stableId(id); const label = cleanOptional(name, 'name'); const actor = this.#actor(actorId); if (!key || !label || !['coordinator','worker'].includes(kind)) throw new DomainError(400, 'invalid_device', 'valid id, name, actor, and device kind are required'); this.#db.prepare('INSERT INTO devices(id,name,kind,token_hash,status,created_at,revoked_at,actor_id) VALUES(?,?,?,?,\'active\',?,NULL,?)').run(key, label, kind, hash(token), createdAt, actor.id); return this.#device(key); }
  async bootstrapCoordinator({ id, name }) { return this.#transaction(() => { if (this.#db.prepare('SELECT 1 FROM devices LIMIT 1').get()) throw new DomainError(409, 'bootstrap_complete', 'first coordinator was already bootstrapped'); const key = stableId(id); const now = this.#now(); this.#db.prepare("INSERT OR IGNORE INTO actors(id,name,kind,machine,active,created_at,updated_at,admin) VALUES(?,?,'human',NULL,1,?,?,1)").run(key, cleanOptional(name, 'name'), now, now); this.#db.prepare("UPDATE actors SET kind='human',active=1,admin=1,updated_at=? WHERE id=?").run(now, key); const credential = `${key}.${randomBytes(32).toString('base64url')}`; const device = this.#insertDevice({ id: key, name, kind: 'coordinator', actor_id: key }, credential); this.#event(null, null, 'device_bootstrapped', device.id, null, { kind: device.kind }); return { device, credential }; }); }
  async authenticateDevice(credential) { if (typeof credential !== 'string' || !credential.includes('.')) throw new DomainError(401, 'device_unauthorized', 'valid paired device credential is required'); const id = stableId(credential.slice(0, credential.indexOf('.'))); const stored = this.#db.prepare('SELECT token_hash FROM devices WHERE id=?').get(id)?.token_hash; const candidate = hash(credential); if (!stored || stored.length !== candidate.length || !timingSafeEqual(Buffer.from(stored), candidate)) throw new DomainError(401, 'device_unauthorized', 'valid paired device credential is required'); return this.#device(id); }
  #createPairingCode(creator, { intended_kind: intendedKind, actor_id: actorId, device_id: deviceId, device_name: deviceName, ttl_ms: ttlMs = 300000 } = {}, { maxTtlMs = 900000 } = {}) { const actor = actorId == null ? null : this.#actor(actorId); if (!['coordinator','worker'].includes(intendedKind)) throw new DomainError(400, 'invalid_device_kind', 'intended_kind must be coordinator or worker'); const boundId = deviceId == null ? null : stableId(deviceId), boundName = cleanOptional(deviceName, 'device_name'); if ((deviceId != null || deviceName != null) && (!boundId || !boundName)) throw new DomainError(400, 'invalid_device', 'valid device_id and device_name are required together'); const ttl = Number(ttlMs); if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > maxTtlMs) throw new DomainError(400, 'invalid_pairing_ttl', `ttl_ms must be 1000-${maxTtlMs}`); const code = randomBytes(9).toString('base64url'); const expires_at = this.#now() + ttl; this.#db.prepare('INSERT INTO pairing_codes(code_hash,intended_kind,expires_at,used_at,created_by_device_id,actor_id,device_id,device_name) VALUES(?,?,?,?,?,?,?,?)').run(hash(code), intendedKind, expires_at, null, creator.id, actor?.id ?? null, boundId, boundName); this.#event(null, null, 'pairing_code_created', creator.id, null, { intended_kind: intendedKind, expires_at, device_id: boundId }); return { code, intended_kind: intendedKind, actor_id: actor?.id ?? null, device_id: boundId, device_name: boundName, expires_at }; }
  async createPairingCode(issuerDeviceId, options) { return this.#transaction(() => this.#createPairingCode(this.#adminDevice(issuerDeviceId), options)); }
  async createLocalBrowserPairing({ device_name: deviceName } = {}) { return this.#transaction(() => {
    const name = cleanOptional(deviceName, 'device_name');
    if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw new DomainError(400, 'invalid_browser_name', 'browser name must contain 1-200 printable characters');
    const creator = this.#db.prepare("SELECT d.id FROM devices d JOIN actors a ON a.id=d.actor_id WHERE d.status='active' AND d.kind='coordinator' AND a.active=1 AND a.admin=1 ORDER BY d.id LIMIT 1").get();
    if (!creator) throw new DomainError(409, 'local_operator_unavailable', 'an active admin coordinator identity is required');
    const deviceId = `browser-${randomBytes(12).toString('hex')}`;
    const issued = this.#createPairingCode(this.#adminDevice(creator.id), { intended_kind: 'coordinator', actor_id: this.#device(creator.id).actor_id, device_id: deviceId, device_name: name, ttl_ms: 3600000 }, { maxTtlMs: 3600000 });
    return { code: issued.code, device_id: issued.device_id, device_name: issued.device_name, expires_at: issued.expires_at };
  }); }
  async recoverCoordinatorPairingCode({ actor_id: actorId, device_id: deviceId, device_name: deviceName }, deliver, { beforeCommit = null } = {}) {
    if (typeof deliver !== 'function') throw new DomainError(400, 'invalid_recovery_output', 'a verified recovery output is required');
    this.#db.exec('BEGIN IMMEDIATE');
    let sanitize = null;
    try {
      if (!this.#db.prepare('SELECT 1 FROM devices LIMIT 1').get()) throw new DomainError(409, 'bootstrap_required', 'local recovery is only valid for a populated device database');
      const actor = this.#actor(actorId);
      if (actor.kind !== 'human') throw new DomainError(403, 'human_required', 'an active human actor is required');
      if (!actor.admin) throw new DomainError(403, 'admin_required', 'the human actor is not eligible for coordinator recovery');
      const creator = this.#db.prepare("SELECT id,name,kind,status,actor_id FROM devices WHERE actor_id=? AND status='active' ORDER BY id LIMIT 1").get(actor.id);
      if (!creator) throw new DomainError(409, 'recovery_actor_device_required', 'the recovery actor must have an active existing device');
      const result = this.#createPairingCode(creator, { intended_kind: 'coordinator', actor_id: actor.id, device_id: deviceId, device_name: deviceName, ttl_ms: 300000 });
      this.#event(null, null, 'local_coordinator_recovery_code_created', actor.id, null, { intended_kind: 'coordinator', expires_at: result.expires_at, device_id: result.device_id }, creator.id);
      sanitize = await deliver(result.code);
      if (beforeCommit) await beforeCommit();
      this.#db.exec('COMMIT');
      return { expires_at: result.expires_at };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      if (sanitize) { try { await sanitize(); } catch {} }
      throw error;
    }
  }
  async pairDevice({ code, id, name }, { requiredKind = null, requireBoundIdentity = false, requireBoundActor = false } = {}) { return this.#transaction(() => {
    if (typeof code !== 'string' || !code) throw new DomainError(400, 'invalid_pairing_code', 'pairing code is required');
    const codeHash = hash(code), row = this.#db.prepare("SELECT pc.* FROM pairing_codes pc JOIN devices issuer ON issuer.id=pc.created_by_device_id AND issuer.status='active' WHERE pc.code_hash=?").get(codeHash);
    if (!row || row.used_at !== null) throw new DomainError(409, 'pairing_code_used_or_invalid', 'pairing code is invalid or already used');
    if (row.expires_at <= this.#now()) throw new DomainError(409, 'pairing_code_expired', 'pairing code expired');
    if (requiredKind && row.intended_kind !== requiredKind) throw new DomainError(409, 'pairing_kind_mismatch', `pairing code is not valid for ${requiredKind} devices`);
    if (requireBoundIdentity && (!row.device_id || !row.device_name)) throw new DomainError(409, 'pairing_device_binding_required', 'pairing requires a server-bound device identity');
    if (requireBoundActor && !row.actor_id) throw new DomainError(409, 'pairing_actor_binding_required', 'browser pairing requires a server-bound actor');
    if (row.device_id && ((id != null && stableId(id) !== row.device_id) || (name != null && cleanOptional(name, 'name') !== row.device_name))) throw new DomainError(409, 'pairing_device_mismatch', 'pairing code is bound to a different device');
    const selectedId = row.device_id ?? id, selectedName = row.device_name ?? name, key = stableId(selectedId), label = cleanOptional(selectedName, 'name');
    if (!key || !label) throw new DomainError(400, 'invalid_device', 'legacy pairing code requires explicit device id and name');
    const existing = this.#db.prepare('SELECT id,name,kind,status,actor_id FROM devices WHERE id=?').get(key);
    if (existing?.status === 'active') throw new DomainError(409, 'device_exists', `device ${key} already exists`);
    const credential = `${key}.${randomBytes(32).toString('base64url')}`;
    let device;
    if (existing) {
      // Reactivation is credential rotation, not takeover: every authority-bearing identity field must be server-bound and exact.
      if (!row.device_id || !row.device_name || !row.actor_id || row.device_id !== existing.id || row.device_name !== existing.name || row.actor_id !== existing.actor_id || row.intended_kind !== existing.kind || label !== existing.name) throw new DomainError(409, 'pairing_device_mismatch', 'pairing code does not exactly match the revoked device');
      const now = this.#now();
      this.#db.prepare("UPDATE devices SET token_hash=?,name=?,kind=?,status='active',created_at=?,revoked_at=NULL,actor_id=? WHERE id=? AND status='revoked'").run(hash(credential), label, row.intended_kind, now, row.actor_id, key);
      this.#db.prepare('UPDATE worker_sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL').run(now, key);
      this.#db.prepare('DELETE FROM device_roles WHERE device_id=?').run(key);
      device = this.#device(key);
    } else {
      if (!row.actor_id) { const now = this.#now(); this.#db.prepare("INSERT OR IGNORE INTO actors(id,name,kind,machine,active,created_at,updated_at) VALUES(?,?,?,NULL,1,?,?)").run(key, label, row.intended_kind === 'coordinator' ? 'human' : 'agent', now, now); }
      device = this.#insertDevice({ id: key, name: label, kind: row.intended_kind, actor_id: row.actor_id ?? key }, credential);
    }
    const used = this.#db.prepare('UPDATE pairing_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL').run(this.#now(), codeHash);
    if (used.changes !== 1) throw new DomainError(409, 'pairing_code_used_or_invalid', 'pairing code is invalid or already used');
    this.#event(null, null, 'device_paired', row.created_by_device_id, null, { device_id: device.id, kind: device.kind, repaired: Boolean(existing) });
    return { device, credential };
  }); }
  async listDevices() { return this.#db.prepare('SELECT d.id,d.name,d.kind,d.status,d.actor_id,a.name actor_name,a.role_id derived_role,d.created_at,d.revoked_at FROM devices d LEFT JOIN actors a ON a.id=d.actor_id ORDER BY d.id').all(); }
  async updateDevice(deviceId, { name, actor_id: actorId }, byDeviceId) { return this.#transaction(() => { const admin = this.#adminDevice(byDeviceId); const device = this.#device(deviceId, { active: false }); const label = name === undefined ? device.name : cleanOptional(name, 'name'); const actor = actorId === undefined ? this.#actor(device.actor_id, { active: false }) : this.#actor(actorId); if (!label) throw new DomainError(400, 'invalid_name', 'device name is required'); this.#db.prepare('UPDATE devices SET name=?,actor_id=? WHERE id=?').run(label, actor.id, device.id); this.#event(null, null, 'device_updated', admin.id, null, { device_id: device.id, actor_id: actor.id }); return this.#device(device.id, { active: false }); }); }
  async revokeDevice(deviceId, byDeviceId) { return this.#transaction(() => { const coordinator = this.#adminDevice(byDeviceId); const device = this.#device(deviceId, { active: false }); if (device.status === 'revoked') return device; const now = this.#now(); this.#db.prepare("UPDATE devices SET status='revoked',revoked_at=? WHERE id=?").run(now, device.id); this.#db.prepare('UPDATE pairing_codes SET used_at=? WHERE created_by_device_id=? AND used_at IS NULL').run(now, device.id); this.#event(null, null, 'device_revoked', coordinator.id, null, { device_id: device.id }); return this.#device(device.id, { active: false }); }); }
  async getDevice(id) { const device = this.#device(id, { active: false }); return { ...device, roles: (await this.listDeviceRoles(device.id)).roles }; }
  async listDeviceRoles(deviceId) { const device = this.#device(deviceId, { active: false }); return { roles: this.#db.prepare('SELECT r.id,r.name,r.created_at FROM roles r JOIN device_roles dr ON dr.role_id=r.id WHERE dr.device_id=? ORDER BY r.id').all(device.id) }; }
  async grantDeviceRole(deviceId, roleId, byDeviceId) { return this.#transaction(() => { const coordinator = this.#adminDevice(byDeviceId); const device = this.#device(deviceId); const role = this.#role(roleId); this.#db.prepare('INSERT OR IGNORE INTO device_roles(device_id,role_id) VALUES(?,?)').run(device.id, role.id); this.#db.prepare('INSERT OR IGNORE INTO actor_roles(actor_id,role_id) VALUES(?,?)').run(device.actor_id, role.id); this.#db.prepare('UPDATE actors SET role_id=?,updated_at=? WHERE id=?').run(role.id, this.#now(), device.actor_id); this.#event(null, null, 'role_granted', coordinator.id, null, { device_id: device.id, role_id: role.id }); return { device_id: device.id, role: role.id }; }); }
  async revokeDeviceRole(deviceId, roleId, byDeviceId) { return this.#transaction(() => { const coordinator = this.#adminDevice(byDeviceId); const device = this.#device(deviceId, { active: false }); const role = this.#role(roleId); this.#db.prepare('DELETE FROM device_roles WHERE device_id=? AND role_id=?').run(device.id, role.id); this.#db.prepare('DELETE FROM actor_roles WHERE actor_id=? AND role_id=?').run(device.actor_id, role.id); this.#db.prepare('UPDATE actors SET role_id=NULL,updated_at=? WHERE id=? AND role_id=?').run(this.#now(), device.actor_id, role.id); this.#event(null, null, 'role_revoked', coordinator.id, null, { device_id: device.id, role_id: role.id }); return { device_id: device.id, role: role.id }; }); }
  async deleteRole(roleId, byDeviceId = null) { return this.#transaction(() => { const actor = byDeviceId ? this.#adminDevice(byDeviceId) : null; const role = this.#role(roleId); if (this.#db.prepare("SELECT 1 FROM actors WHERE role_id=? LIMIT 1").get(role.id) || this.#db.prepare('SELECT 1 FROM tickets WHERE assignee_type=\'role\' AND assignee_id=? AND deleted_at IS NULL LIMIT 1').get(role.id)) throw new DomainError(409, 'role_in_use', 'role is used by an actor or ticket'); this.#db.prepare('DELETE FROM device_roles WHERE role_id=?').run(role.id); this.#db.prepare('DELETE FROM actor_roles WHERE role_id=?').run(role.id); this.#db.prepare('DELETE FROM roles WHERE id=?').run(role.id); this.#event(null, null, 'role_deleted', actor?.id ?? null, null, { role_id: role.id }); return role; }); }
  async canDeviceReadTicket(deviceId, ticketId) { const device = this.#device(deviceId); const ticket = this.#ticket(ticketId); return device.kind === 'coordinator' || this.#eligible(ticket, device); }

  async createActor({ id, name, kind = 'agent', machine = null, active = true, role_id: roleId = null, admin = false }, byDeviceId = null) { return this.#transaction(() => { const creator = byDeviceId ? this.#adminDevice(byDeviceId) : null; const key = stableId(id); const label = cleanOptional(name, 'name'); const host = cleanOptional(machine, 'machine'); const role = roleId ? this.#role(roleId) : null; if (!key || !label || !['agent', 'human'].includes(kind)) throw new DomainError(400, 'invalid_actor', 'valid id, name, and kind are required'); const now = this.#now(); try { this.#db.prepare('INSERT INTO actors(id,name,kind,machine,active,created_at,updated_at,role_id,admin) VALUES(?,?,?,?,?,?,?,?,?)').run(key, label, kind, host, active ? 1 : 0, now, now, role?.id ?? null, admin ? 1 : 0); } catch (error) { if (error.code?.startsWith('ERR_SQLITE_CONSTRAINT')) throw new DomainError(409, 'actor_exists', `actor ${key} already exists`); throw error; } this.#event(null, null, 'actor_created', creator?.id ?? key, null, { actor_id: key }); return this.#actor(key, { active: false }); }); }
  async getActor(id) { return this.#actor(id, { active: false }); }
  async listActors({ active } = {}) { const where = active === undefined ? '' : ' WHERE active=?'; const rows = this.#db.prepare(`SELECT id,name,kind,machine,active,role_id,admin,created_at,updated_at FROM actors${where} ORDER BY id`).all(...(active === undefined ? [] : [active ? 1 : 0])); return rows.map((r) => ({ ...r, active: Boolean(r.active), admin: Boolean(r.admin) })); }
  async updateActor(id, changes = {}, byDeviceId = null) { return this.#transaction(() => { const editor = byDeviceId ? this.#adminDevice(byDeviceId) : null; const current = this.#actor(id, { active: false }); const name = 'name' in changes ? cleanOptional(changes.name, 'name') : current.name; const kind = 'kind' in changes ? changes.kind : current.kind; const machine = 'machine' in changes ? cleanOptional(changes.machine, 'machine') : current.machine; const active = 'active' in changes ? Boolean(changes.active) : current.active; const admin = 'admin' in changes ? Boolean(changes.admin) : current.admin; const role = 'role_id' in changes ? (changes.role_id ? this.#role(changes.role_id) : null) : { id: current.role_id }; if (!name || !['human', 'agent'].includes(kind)) throw new DomainError(400, 'invalid_actor', 'valid name and kind are required'); this.#db.prepare('UPDATE actors SET name=?,kind=?,machine=?,active=?,role_id=?,admin=?,updated_at=? WHERE id=?').run(name, kind, machine, active ? 1 : 0, role?.id ?? null, admin ? 1 : 0, this.#now(), current.id); this.#event(null, null, active === current.active ? 'actor_updated' : active ? 'actor_activated' : 'actor_deactivated', editor?.id ?? current.id, null, { actor_id: current.id }); return this.#actor(current.id, { active: false }); }); }
  async deactivateActor(id) { return this.updateActor(id, { active: false }); }
  async createRole({ id, name, actor = null }) { return this.#transaction(() => { const key = stableId(id); const label = cleanOptional(name, 'name'); const creator = actor ? this.#adminDevice(actor) : null; if (!key || !label) throw new DomainError(400, 'invalid_role', 'valid id and name are required'); try { this.#db.prepare('INSERT INTO roles(id,name,created_at) VALUES(?,?,?)').run(key, label, this.#now()); } catch (error) { if (error.code?.startsWith('ERR_SQLITE_CONSTRAINT')) throw new DomainError(409, 'role_exists', `role ${key} already exists`); throw error; } this.#event(null, null, 'role_created', creator?.id ?? null, null, { role_id: key }); return this.#role(key); }); }
  async listRoles() { return this.#db.prepare('SELECT id,name,created_at FROM roles ORDER BY id').all(); }
  async listRoleActors(roleId) { const role = this.#role(roleId); return { role, actors: this.#db.prepare('SELECT a.id,a.name,a.kind,a.machine,a.active,a.created_at,a.updated_at FROM actors a JOIN actor_roles ar ON ar.actor_id=a.id WHERE ar.role_id=? ORDER BY a.id').all(role.id).map((a) => ({ ...a, active: Boolean(a.active) })) }; }
  async grantRole(actorId, roleId) { return this.#transaction(() => { const actor = this.#actor(actorId); const role = this.#role(roleId); this.#db.prepare('INSERT OR IGNORE INTO actor_roles(actor_id,role_id) VALUES(?,?)').run(actor.id, role.id); this.#event(null, null, 'role_granted', actor.id, null, { role_id: role.id }); return { actor_id: actor.id, role: role.id }; }); }
  async addActorRole(actorId, roleId) { return this.grantRole(actorId, roleId); }
  async revokeRole(actorId, roleId) { return this.#transaction(() => { const actor = this.#actor(actorId, { active: false }); const role = this.#role(roleId); this.#db.prepare('DELETE FROM actor_roles WHERE actor_id=? AND role_id=?').run(actor.id, role.id); this.#event(null, null, 'role_revoked', actor.id, null, { role_id: role.id }); return { actor_id: actor.id, role: role.id }; }); }
  async listActorRoles(actorId) { const actor = this.#actor(actorId, { active: false }); return { roles: this.#db.prepare('SELECT r.id,r.name,r.created_at FROM roles r JOIN actor_roles ar ON ar.role_id=r.id WHERE ar.actor_id=? ORDER BY r.id').all(actor.id) }; }

  async createTicket(input = {}) {
    if ('projects' in input || 'assignee' in input || 'assigned_to' in input || 'body' in input || 'worker_actor_id' in input) throw new DomainError(400, 'invalid_ticket_fields', 'ticket create accepts only project, title, description, and categorical assignment');
    const { project: rawProject, title, description = '', assignment = 'Unassigned', actor: rawActor = null } = input;
    return this.#transaction(() => { const project = this.#project(rawProject); const creator = rawActor == null ? null : this.#adminDevice(rawActor); if (!['Unassigned','Human','Agent'].includes(assignment)) throw new DomainError(400, 'invalid_assignment', 'assignment must be Unassigned, Human, or Agent'); const number = project.next_number; const id = `${project.key}-${number}`; const now = this.#now(); this.#db.prepare("INSERT INTO tickets(id,project,number,title,body,state,assigned_to,assignee_type,assignee_id,assignment,created_at,updated_at) VALUES(?,?,?,?,?,'open',NULL,NULL,NULL,?,?,?)").run(id, project.key, number, this.#title(title), cleanOptional(description, 'description') ?? '', assignment, now, now); this.#db.prepare('UPDATE projects SET next_number=next_number+1 WHERE key=?').run(project.key); this.#db.prepare('INSERT INTO ticket_projects(ticket_id,project_key) VALUES(?,?)').run(id, project.key); this.#event(id, project.key, 'ticket_created', creator?.id ?? null, null, { assignment }); return this.#ticket(id); });
  }
  async listTickets(rawProject, options = {}) { const project = this.#project(rawProject); if ('assigneeType' in options || 'assigneeId' in options) throw new DomainError(400, 'invalid_ticket_filter', 'role or device assignment filters are not supported'); const where = ['t.project=?', 't.deleted_at IS NULL']; const values = [project.key]; if (!options.includeArchived) where.push('t.archived_at IS NULL'); return this.#db.prepare(`SELECT t.id,t.project,t.number,t.title,t.body,t.state,t.assigned_to,t.assignment,t.created_at,t.updated_at,t.board_state,CAST(t.board_order AS TEXT) board_order,t.assignee_type,t.assignee_id,t.archived_at,t.deleted_at,c.claim_id,c.actor claim_actor,c.device_id claim_device_id,c.session_id claim_session_id,d.name claim_machine,c.generation,c.claimed_at,(SELECT COUNT(*) FROM ticket_blocks b WHERE b.ticket_id=t.id AND b.status='open') unresolved_blockers,(SELECT COUNT(*) FROM questions q WHERE q.ticket_id=t.id AND q.status='open') open_questions FROM tickets t LEFT JOIN claims c ON c.ticket_id=t.id AND c.released_at IS NULL LEFT JOIN devices d ON d.id=c.device_id WHERE ${where.join(' AND ')} ORDER BY t.board_order DESC,t.id`).all(...values).map((r) => this.#publicTicket(r)); }
  async listBoardTickets() { return this.#db.prepare(`SELECT t.id,t.project,t.number,t.title,t.body,t.state,t.assigned_to,t.assignment,t.created_at,t.updated_at,t.board_state,CAST(t.board_order AS TEXT) board_order,t.assignee_type,t.assignee_id,t.archived_at,t.deleted_at,c.claim_id,c.actor claim_actor,c.device_id claim_device_id,c.session_id claim_session_id,d.name claim_machine,c.generation,c.claimed_at,(SELECT COUNT(*) FROM ticket_blocks b WHERE b.ticket_id=t.id AND b.status='open') unresolved_blockers,(SELECT COUNT(*) FROM questions q WHERE q.ticket_id=t.id AND q.status='open') open_questions FROM tickets t LEFT JOIN claims c ON c.ticket_id=t.id AND c.released_at IS NULL LEFT JOIN devices d ON d.id=c.device_id WHERE t.deleted_at IS NULL AND t.archived_at IS NULL ORDER BY t.board_order DESC,t.id`).all().map((row) => this.#publicTicket(row)); }
  async getTicket(id) { return this.#ticket(id); }
  async listTicketsForDevice(rawProject, deviceId, options = {}) { const device = this.#device(deviceId); const tickets = await this.listTickets(rawProject, options); return device.kind === 'coordinator' ? tickets : tickets.filter((ticket) => this.#eligible(ticket, device)); }
  async activeClaimsForDevice(deviceId) { const device = this.#device(deviceId); return this.#db.prepare("SELECT t.*,c.claim_id,c.actor claim_actor,c.device_id claim_device_id,c.session_id claim_session_id,d.name claim_machine,c.generation,c.claimed_at,(SELECT COUNT(*) FROM ticket_blocks b WHERE b.ticket_id=t.id AND b.status='open') unresolved_blockers,0 open_questions FROM tickets t JOIN claims c ON c.ticket_id=t.id AND c.released_at IS NULL LEFT JOIN devices d ON d.id=c.device_id WHERE c.actor=? AND t.deleted_at IS NULL ORDER BY c.claimed_at,t.id").all(device.actor_id).map((row) => this.#publicTicket(row)); }
  async archiveTicket(id, { actor: rawActor }) { return this.#transaction(() => { const ticket = this.#ticket(id); const actor = this.#human(rawActor); if (ticket.deleted_at !== null) throw new DomainError(409, 'ticket_deleted', 'deleted tickets cannot be archived'); if (ticket.archived_at !== null) return ticket; const now = this.#now(); if (ticket.claim) this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(now, ticket.claim.claim_id); this.#db.prepare('UPDATE tickets SET archived_at=?,updated_at=? WHERE id=?').run(now, now, id); this.#event(id, ticket.project, 'archived', actor.id, 'Archived ticket.'); return this.#ticket(id); }); }
  async restoreTicket(id, { actor: rawActor }) { return this.#transaction(() => { const ticket = this.#ticket(id); const actor = this.#human(rawActor); if (ticket.deleted_at !== null) throw new DomainError(409, 'ticket_deleted', 'deleted tickets cannot be restored'); if (ticket.archived_at === null) return ticket; this.#db.prepare('UPDATE tickets SET archived_at=NULL,updated_at=? WHERE id=?').run(this.#now(), id); this.#event(id, ticket.project, 'restored', actor.id, 'Restored ticket from archive.'); return this.#ticket(id); }); }
  async deleteTicket(id, { actor: rawActor, confirmed = false }) { return this.#transaction(() => { if (confirmed !== true) throw new DomainError(409, 'delete_confirmation_required', 'explicit delete confirmation is required'); const existing = this.#ticket(id); const device = this.#adminDevice(rawActor); if (device.kind !== 'coordinator') throw new DomainError(403, 'coordinator_required', 'coordinator device is required'); const actor = this.#human(device.id); if (existing.archived_at !== null) throw new DomainError(409, 'ticket_archived', 'archived tickets cannot be deleted'); const now = this.#now(); if (existing.claim) this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(now, existing.claim.claim_id); const eventId = this.#event(id, existing.project, 'deleted', actor.id, 'Permanently deleted ticket. Audit history retained.', { non_restorable: true }, device.id); this.#db.prepare('UPDATE tickets SET deleted_at=? WHERE id=? AND deleted_at IS NULL').run(now, id); const number = Number(id.slice(existing.project.length + 1)); this.#db.prepare('INSERT INTO ticket_tombstones(ticket_id,project,number,deleted_at,deleted_by_actor,deleted_by_device,delete_event_id) VALUES(?,?,?,?,?,?,?)').run(id, existing.project, number, now, actor.id, device.id, eventId); return this.#ticket(id, { includeDeleted: true }); }); }
  #eligible(ticket, device) { return device.kind === 'worker' && device.status === 'active' && ticket.assignment === 'Agent' && (!ticket.assigned_worker || ticket.assigned_worker.id === device.actor_id); }
  #claimable(ticket, device) { return ticket.state === 'Open' && ticket.archived_at === null && ticket.deleted_at === null && !ticket.claim && ticket.unresolved_blockers === 0 && this.#eligible(ticket, device); }
  #sessionCapability(raw, deviceId) {
    if (typeof raw !== 'string' || raw.length > 300 || !raw.includes('.')) throw new DomainError(401, 'session_unauthorized', 'a live server-issued session capability is required');
    const id = raw.slice(0, raw.indexOf('.')); const row = this.#db.prepare('SELECT id,capability_hash,device_id,revoked_at FROM worker_sessions WHERE id=?').get(id);
    const candidate = hash(raw); const stored = row?.capability_hash ? Buffer.from(row.capability_hash) : null;
    if (!row || row.revoked_at !== null || row.device_id !== deviceId || !stored || stored.length !== candidate.length || !timingSafeEqual(stored, candidate)) throw new DomainError(401, 'session_unauthorized', 'a live server-issued session capability is required');
    return row;
  }
  #insertWorkerSession(device) { const id = `ps_${randomBytes(18).toString('base64url')}`; const capability = `${id}.${randomBytes(32).toString('base64url')}`; this.#db.prepare('INSERT INTO worker_sessions(id,capability_hash,device_id,created_at,revoked_at) VALUES(?,?,?,?,NULL)').run(id, hash(capability), device.id, this.#now()); return { session_id: id, session_capability: capability }; }
  async openWorkerSession(deviceId) { return this.#transaction(() => this.#insertWorkerSession(this.#device(deviceId, { kind: 'worker' }))); }
  async closeWorkerSession(deviceId, capability) { return this.#transaction(() => { const session = this.#sessionCapability(capability, this.#device(deviceId, { kind: 'worker' }).id); this.#db.prepare('UPDATE worker_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(this.#now(), session.id); return { session_id: session.id, revoked: true }; }); }
  #next(device, rawProject = null) { const project = rawProject == null ? null : this.#project(rawProject).key; const row = this.#db.prepare(`SELECT t.id,t.project,t.number,t.title,t.body,t.state,t.assigned_to,t.assignment,t.created_at,t.updated_at,t.board_state,CAST(t.board_order AS TEXT) board_order,t.assignee_type,t.assignee_id,t.archived_at,t.deleted_at,NULL claim_id,NULL claim_actor,NULL claim_device_id,NULL claim_session_id,NULL claim_machine,NULL generation,NULL claimed_at,(SELECT COUNT(*) FROM ticket_blocks b WHERE b.ticket_id=t.id AND b.status='open') unresolved_blockers,0 open_questions FROM tickets t WHERE t.state='open' AND t.board_state='Open' AND t.assignment='Agent' AND t.archived_at IS NULL AND t.deleted_at IS NULL AND (? IS NULL OR t.project=?) AND (t.assignee_type IS NULL OR (t.assignee_type='actor' AND t.assignee_id=?)) AND NOT EXISTS(SELECT 1 FROM claims c WHERE c.ticket_id=t.id AND c.released_at IS NULL) AND NOT EXISTS(SELECT 1 FROM ticket_blocks b WHERE b.ticket_id=t.id AND b.status='open') ORDER BY t.board_order DESC,t.id LIMIT 1`).get(project, project, device.actor_id); const ticket = row ? this.#publicTicket(row) : null; return ticket && this.#claimable(ticket, device) ? ticket : null; }
  #claim(ticket, device, sessionId) { if (this.#db.prepare('SELECT 1 FROM claims WHERE device_id=? AND released_at IS NULL').get(device.id)) throw new DomainError(409, 'machine_already_claimed', 'this machine already has an active claim'); const generation = Number(this.#db.prepare('SELECT COALESCE(MAX(generation),0)+1 generation FROM claims WHERE ticket_id=?').get(ticket.id).generation); const token = randomBytes(32).toString('base64url'); const claimId = randomUUID(); this.#db.prepare('INSERT INTO claims(claim_id,ticket_id,actor,generation,token_hash,claimed_at,device_id,session_id) VALUES(?,?,?,?,?,?,?,?)').run(claimId, ticket.id, device.actor_id, generation, hash(token), this.#now(), device.id, sessionId); this.#db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(this.#now(), ticket.id); this.#event(ticket.id, ticket.project, 'claimed', device.actor_id, null, { session_bound: sessionId !== null, machine: device.name }, device.id); return { ticket: this.#ticket(ticket.id), claim_token: token }; }
  async next({ device: deviceId, actor: legacyId } = {}) { const device = this.#device(deviceId ?? legacyId, { kind: 'worker' }); return this.#next(device); }
  async claimNext(options = {}) { const { device: deviceId, actor: legacyId, session_capability: capability, project } = options; const projectKey = Object.hasOwn(options, 'project') ? this.#requiredProject(project) : null; return this.#transaction(() => { const device = this.#device(deviceId ?? legacyId, { kind: 'worker' }); const sessionId = this.#sessionCapability(capability, device.id).id; const ticket = this.#next(device, projectKey); return ticket ? this.#claim(ticket, device, sessionId) : null; }); }
  #nextExactAssigned(device) { const row = this.#db.prepare(`SELECT t.id,t.project,t.number,t.title,t.body,t.state,t.assigned_to,t.assignment,t.created_at,t.updated_at,t.board_state,CAST(t.board_order AS TEXT) board_order,t.assignee_type,t.assignee_id,t.archived_at,t.deleted_at,NULL claim_id,NULL claim_actor,NULL claim_device_id,NULL claim_session_id,NULL claim_machine,NULL generation,NULL claimed_at,(SELECT COUNT(*) FROM ticket_blocks b WHERE b.ticket_id=t.id AND b.status='open') unresolved_blockers,0 open_questions FROM tickets t WHERE t.state='open' AND t.board_state='Open' AND t.assignment='Agent' AND t.assignee_type='actor' AND t.assignee_id=? AND t.archived_at IS NULL AND t.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM claims c WHERE c.ticket_id=t.id AND c.released_at IS NULL) AND NOT EXISTS(SELECT 1 FROM ticket_blocks b WHERE b.ticket_id=t.id AND b.status='open') ORDER BY t.board_order DESC,t.id LIMIT 1`).get(device.actor_id); const ticket = row ? this.#publicTicket(row) : null; return ticket && this.#claimable(ticket, device) ? ticket : null; }
  async editTicket(id, changes = {}) { return this.#transaction(() => {
    const ticket = this.#mutableTicket(id); const actor = this.#adminDevice(changes.actor);
    for (const forbidden of ['project','projects','assignee','assigned_to','body']) if (forbidden in changes) throw new DomainError(400, 'immutable_project', 'ticket project is immutable and legacy mutation fields are unsupported');
    const title = 'title' in changes ? this.#title(changes.title) : ticket.title;
    const description = 'description' in changes ? cleanOptional(changes.description, 'description') ?? '' : ticket.description;
    const assignment = 'assignment' in changes ? changes.assignment : ticket.assignment;
    if (!['Unassigned','Human','Agent'].includes(assignment)) throw new DomainError(400, 'invalid_assignment', 'assignment must be Unassigned, Human, or Agent');
    this.#db.prepare("UPDATE tickets SET title=?,body=?,assignment=?,assignee_type=CASE WHEN ?='Agent' THEN assignee_type ELSE NULL END,assignee_id=CASE WHEN ?='Agent' THEN assignee_id ELSE NULL END,updated_at=? WHERE id=?").run(title, description, assignment, assignment, assignment, this.#now(), id);
    this.#event(id, ticket.project, 'ticket_edited', actor.id, 'Updated ticket title, description, or assignment.');
    return this.#ticket(id);
  }); }

  async setTicketState(id, { state, actor: rawActor }) { return this.#transaction(() => {
    const ticket = this.#mutableTicket(id); const actor = this.#workflowActor(rawActor); if (actor.kind !== 'human') throw new DomainError(403, 'human_required', 'a human actor is required');
    if (!['Open', 'Working', 'Waiting', 'Done'].includes(state)) throw new DomainError(400, 'invalid_state', 'state must be Open, Working, Waiting, or Done');
    if (ticket.state === state) return ticket;
    const storedState = state === 'Done' ? 'done' : state === 'Waiting' ? 'review' : 'open';
    const now = this.#now();
    if (state !== 'Working' && ticket.claim) this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(now, ticket.claim.claim_id);
    if (ticket.state === 'Waiting' && state !== 'Waiting' && this.#db.prepare("SELECT 1 FROM questions WHERE ticket_id=? AND status='open' AND blocking=1 AND kind='text'").get(id)) throw new DomainError(409, 'blocking_question_pending', 'answer every blocking question before leaving Waiting');
    if (ticket.state === 'Waiting' && state !== 'Waiting') {
      const decision = state === 'Done' ? 'accept' : 'request_changes'; const note = `State changed directly to ${state}.`;
      for (const q of this.#db.prepare("SELECT * FROM questions WHERE ticket_id=? AND kind='approval' AND status='open'").all(id)) {
        this.#db.prepare("UPDATE questions SET status='answered',answer=?,answered_by=?,answered_at=? WHERE id=?").run(JSON.stringify({ decision, note }), actor.id, now, q.id);
        this.#event(id, ticket.project, 'question_answered', actor.id, decision, { question_id: q.id, question_event_id: q.question_event_id ?? null, kind: 'approval' });
      }
    }
    this.#db.prepare('UPDATE tickets SET state=?,board_state=?,updated_at=? WHERE id=?').run(storedState, state, now, id);
    this.#event(id, ticket.project, 'state_changed', actor.id, `Moved from ${ticket.state} to ${state}.`, { from: ticket.state, to: state });
    return this.#ticket(id);
  }); }
  async moveHumanTicket(id, { state, index, visible_ids: rawVisibleIds, actor: rawActor }) { return this.#transaction(() => {
    const ticket = this.#mutableTicket(id); const actor = this.#workflowActor(rawActor);
    if (actor.kind !== 'human') throw new DomainError(403, 'human_required', 'a human actor is required');
    if (ticket.assignment !== 'Human') throw new DomainError(409, 'human_assignment_required', 'only Human-assigned tickets can be moved on the board');
    if (!['Open','Working','Waiting','Done'].includes(state)) throw new DomainError(400, 'invalid_state', 'state must be Open, Working, Waiting, or Done');
    const position = Number(index); if (!Number.isSafeInteger(position) || position < 0) throw new DomainError(400, 'invalid_position', 'index must be a non-negative integer');
    if (!Array.isArray(rawVisibleIds) || rawVisibleIds.some((item) => typeof item !== 'string')) throw new DomainError(400, 'invalid_visible_order', 'visible_ids must be the ordered visible target-lane ticket ids');
    const visibleIds = rawVisibleIds.filter((ticketId) => ticketId !== id);
    if (new Set(visibleIds).size !== visibleIds.length || position > visibleIds.length) throw new DomainError(400, 'invalid_visible_order', 'visible_ids and index must describe one ordered visible subsequence');
    if (ticket.claim) throw new DomainError(409, 'active_claim', 'claimed tickets cannot be moved by the human board');
    const global = this.#db.prepare('SELECT t.id,t.board_state,c.claim_id FROM tickets t LEFT JOIN claims c ON c.ticket_id=t.id AND c.released_at IS NULL WHERE t.deleted_at IS NULL AND t.archived_at IS NULL ORDER BY t.board_order DESC,t.id').all();
    const targetIds = global.filter((row) => this.#effectiveBoardState(row) === state && row.id !== id).map((row) => row.id);
    let cursor = -1;
    for (const visibleId of visibleIds) {
      const next = targetIds.indexOf(visibleId, cursor + 1);
      if (next < 0) throw new DomainError(409, 'stale_visible_order', 'visible_ids are no longer an ordered target-lane subsequence');
      cursor = next;
    }
    const ordered = global.map((row) => row.id);
    const visibleSlots = ordered.map((ticketId, offset) => ticketId === id || visibleIds.includes(ticketId) ? offset : -1).filter((offset) => offset >= 0);
    const reorderedVisible = [...visibleIds]; reorderedVisible.splice(position, 0, id);
    visibleSlots.forEach((offset, slot) => { ordered[offset] = reorderedVisible[slot]; });
    const storedState = state === 'Done' ? 'done' : state === 'Waiting' ? 'review' : 'open';
    this.#db.prepare('UPDATE tickets SET state=?,board_state=? WHERE id=?').run(storedState, state, id);
    if (ticket.state !== state) this.#event(id, ticket.project, 'state_changed', actor.id, `Moved from ${ticket.state} to ${state}.`, { from: ticket.state, to: state });
    else this.#event(id, ticket.project, 'ticket_reordered', actor.id, `Moved within ${state}.`, { state });
    ordered.forEach((ticketId, offset) => this.#db.prepare('UPDATE tickets SET board_order=? WHERE id=?').run(ordered.length - offset, ticketId));
    return this.#ticket(id);
  }); }

  #appendManualEvent(ticket, actor, device, message, metadata = null) { const text = cleanOptional(message, 'message'); if (!text) throw new DomainError(400, 'invalid_message', 'message is required'); const facts = metadata == null ? null : { ...metadata }; if (facts) for (const key of ['actor','actor_id','role','role_id','actor_role','device','device_id','machine','session','session_id']) delete facts[key]; const cursor = this.#event(ticket.id, ticket.project, 'progress', actor.id, text, facts, device.id); return { event: this.#eventRow(cursor), cursor }; }
  async appendTicketEvent(id, { actor: rawActor, message, metadata = null }) { return this.#transaction(() => {
    const ticket = this.#mutableTicket(id); const device = this.#adminDevice(rawActor); if (device.kind !== 'coordinator') throw new DomainError(403, 'coordinator_required', 'coordinator device is required'); const actor = this.#human(device.id);
    return this.#appendManualEvent(ticket, actor, device, message, metadata);
  }); }

  async claim(id, { device: deviceId, actor: legacyId, session_capability: capability } = {}) { return this.#transaction(() => { const ticket = this.#ticket(id); const device = this.#device(deviceId ?? legacyId, { kind: 'worker' }); const sessionId = this.#sessionCapability(capability, device.id).id; if (!this.#claimable(ticket, device)) throw new DomainError(409, 'ticket_ineligible', 'ticket is not eligible for this paired worker'); return this.#claim(ticket, device, sessionId); }); }
  #authority(id, { claim_id: claimId, actor, device, session_capability: capability, generation, claim_token: token }) { const current = this.#db.prepare('SELECT * FROM claims WHERE ticket_id=? AND released_at IS NULL').get(id); let session = null; try { session = this.#sessionCapability(capability, device); } catch {} const candidate = typeof token === 'string' ? hash(token) : Buffer.alloc(0); const stored = current?.token_hash ? Buffer.from(current.token_hash) : null; const valid = stored && stored.length === candidate.length && timingSafeEqual(stored, candidate); if (!current || current.claim_id !== claimId || current.actor !== actor || current.generation !== generation || current.device_id !== device || !session || current.session_id !== session.id || !valid) throw new DomainError(409, 'stale_claim', 'claim fence is no longer owned by this machine and live Pi session'); return current; }
  async verify(id, identity) { this.#row(id); this.#authority(id, identity); return this.#ticket(id); }
  async release(id, { release_message: releaseMessage, release_metadata: releaseMetadata = null, ...identity }) { return this.#transaction(() => { const ticket = this.#ticket(id); const claim = this.#authority(id, identity); if (releaseMessage != null) this.#appendManualEvent(ticket, this.#actor(claim.actor), this.#device(claim.device_id, { kind: 'worker' }), releaseMessage, releaseMetadata); this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(this.#now(), claim.claim_id); this.#db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(this.#now(), id); this.#event(id, ticket.project, 'released', claim.actor, null, null, identity.device ?? claim.device_id); return this.#ticket(id); }); }
  async postEvent(id, { message, metadata = null, ...identity }) { return this.#transaction(() => { const ticket = this.#mutableTicket(id); const claim = this.#authority(id, identity); const actor = this.#actor(claim.actor); const device = this.#device(claim.device_id, { kind: 'worker' }); return this.#appendManualEvent(ticket, actor, device, message, metadata); }); }
  #publicBlock(row) { return { id: row.id, ticket_id: row.ticket_id, created_by: row.created_by, reason: row.reason, status: row.status, created_at: row.created_at, resolved_by: row.resolved_by, resolved_at: row.resolved_at }; }
  async blockTicket(id, { reason, ...identity }) { return this.#transaction(() => { const ticket = this.#ticket(id); const claim = this.#authority(id, identity); const text = cleanOptional(reason, 'reason'); if (!text) throw new DomainError(400, 'invalid_reason', 'block reason is required'); const blockId = `b_${randomBytes(9).toString('base64url')}`; const now = this.#now(); this.#db.prepare("INSERT INTO ticket_blocks(id,ticket_id,created_by,reason,status,created_at) VALUES(?,?,?,?,'open',?)").run(blockId, id, claim.actor, text, now); this.#event(id, ticket.project, 'blocked', claim.actor, text, { block_id: blockId }, identity.device ?? claim.device_id); return { block: this.#publicBlock(this.#db.prepare('SELECT * FROM ticket_blocks WHERE id=?').get(blockId)), ticket: this.#ticket(id) }; }); }
  async listBlocks(id, { status } = {}) { this.#row(id); const where = ['ticket_id=?']; const values = [id]; if (status) { if (!['open','resolved'].includes(status)) throw new DomainError(400, 'invalid_block_status', 'status must be open or resolved'); where.push('status=?'); values.push(status); } return { blocks: this.#db.prepare(`SELECT * FROM ticket_blocks WHERE ${where.join(' AND ')} ORDER BY created_at,id`).all(...values).map((row) => this.#publicBlock(row)) }; }
  async resolveBlock(id, blockId, { actor: rawActor }) { return this.#transaction(() => { const ticket = this.#mutableTicket(id); const actor = this.#human(rawActor); const block = this.#db.prepare('SELECT * FROM ticket_blocks WHERE id=? AND ticket_id=?').get(blockId, id); if (!block) throw new DomainError(404, 'block_not_found', `block ${blockId} not found`); if (block.status === 'resolved') return { block: this.#publicBlock(block), ticket }; const now = this.#now(); this.#db.prepare("UPDATE ticket_blocks SET status='resolved',resolved_by=?,resolved_at=? WHERE id=? AND status='open'").run(actor.id, now, blockId); this.#event(id, ticket.project, 'block_resolved', actor.id, 'Block resolved.', { block_id: blockId }); return { block: this.#publicBlock(this.#db.prepare('SELECT * FROM ticket_blocks WHERE id=?').get(blockId)), ticket: this.#ticket(id) }; }); }

  #questionRow(id) { const row = this.#db.prepare('SELECT * FROM questions WHERE id=?').get(id); if (!row) throw new DomainError(404, 'question_not_found', `question ${id} not found`); return row; }
  #publicQuestion(q) { return { id: q.id, ticket_id: q.ticket_id, asked_by: q.asked_by, asked_by_role: q.asked_by_role ?? null, asked_by_device_id: q.asked_by_device_id ?? null, asked_by_session_id: q.asked_by_session_id ?? null, target_type: q.target_type, target_id: q.target_id, kind: q.kind, blocking: Boolean(q.blocking), text: q.text, status: q.status, answer: q.answer, answered_by: q.answered_by, answered_by_role: q.answered_by_role ?? null, answered_by_device_id: q.answered_by_device_id ?? null, question_event_id: q.question_event_id ?? null, created_at: q.created_at, answered_at: q.answered_at }; }
  #insertQuestion(ticket, asker, { target_type, target_id, kind = 'text', blocking = false, text, device_id = null, session_id = null, submission_request_id = null }) { if (!['text', 'approval'].includes(kind)) throw new DomainError(400, 'invalid_question_kind', 'question kind must be text or approval'); if (typeof blocking !== 'boolean' || (kind === 'approval' && !blocking)) throw new DomainError(400, 'invalid_question_blocking', 'questions must explicitly be blocking or non-blocking; approvals are blocking'); const prompt = cleanOptional(text, 'question_text'); if (!prompt) throw new DomainError(400, 'invalid_question_answer', 'question text is required'); const askerActor = this.#actor(asker); const target = this.#target({ type: target_type, id: target_id }, { actorActive: true }); const id = `q_${randomBytes(9).toString('base64url')}`; this.#db.prepare("INSERT INTO questions(id,ticket_id,asked_by,asked_by_role,asked_by_device_id,asked_by_session_id,target_type,target_id,kind,blocking,text,status,created_at,submission_request_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,'open',?,?)").run(id, ticket.id, askerActor.id, askerActor.role_id, device_id, session_id, target.type, target.id, kind, blocking ? 1 : 0, prompt, this.#now(), submission_request_id); const metadata = { question_id: id, kind, blocking, target_type: target.type, target_id: target.id, actor_role: askerActor.role_id, session_id }; const eventId = this.#event(ticket.id, ticket.project, 'question_asked', askerActor.id, prompt, metadata, device_id); this.#db.prepare('UPDATE questions SET question_event_id=? WHERE id=?').run(eventId, id); return this.#publicQuestion(this.#questionRow(id)); }
  async askQuestion(id, input) { return this.#transaction(() => { const ticket = this.#ticket(id); const claim = this.#authority(id, input); const kind = input.kind ?? 'text'; if (kind !== 'text') throw new DomainError(400, 'invalid_question_kind', 'claim owners may ask text questions; approval is created by submit'); const blocking = input.blocking ?? false; if (typeof blocking !== 'boolean') throw new DomainError(400, 'invalid_question_blocking', 'blocking must be true or false'); const question = this.#insertQuestion(ticket, claim.actor, { target_type: input.target_type ?? input.responder?.type, target_id: input.target_id ?? input.responder?.id, kind, blocking, text: input.text ?? input.prompt, device_id: claim.device_id, session_id: claim.session_id }); if (blocking) { const now = this.#now(); this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(now, claim.claim_id); this.#db.prepare("UPDATE tickets SET state='review',board_state='Waiting',updated_at=? WHERE id=?").run(now, id); this.#event(id, ticket.project, 'waiting_for_answer', claim.actor, null, { question_id: question.id, actor_role: this.#actor(claim.actor).role_id, session_id: claim.session_id }, claim.device_id); } return { question, ticket: this.#ticket(id) }; }); }
  async askHumanQuestion(id, input) { return this.#transaction(() => { const ticket = this.#mutableTicket(id); const actor = this.#workflowActor(input.actor); if (actor.kind !== 'human') throw new DomainError(403, 'human_required', 'a human actor is required'); const blocking = input.blocking ?? false; if (typeof blocking !== 'boolean') throw new DomainError(400, 'invalid_question_blocking', 'blocking must be true or false'); const device = this.#device(input.actor); const question = this.#insertQuestion(ticket, actor.id, { target_type: input.target_type ?? input.responder?.type, target_id: input.target_id ?? input.responder?.id, kind: 'text', blocking, text: input.text, device_id: device.id }); if (blocking) { const now = this.#now(); if (ticket.claim) this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(now, ticket.claim.claim_id); this.#db.prepare("UPDATE tickets SET state='review',board_state='Waiting',updated_at=? WHERE id=?").run(now, id); this.#event(id, ticket.project, 'waiting_for_answer', actor.id, null, { question_id: question.id, actor_role: actor.role_id }, device.id); } return { question, ticket: this.#ticket(id) }; }); }
  async listQuestions(id, { status } = {}) { this.#row(id); const where = ['ticket_id=?']; const values = [id]; if (status) { if (!['open', 'answered'].includes(status)) throw new DomainError(400, 'invalid_question_status', 'status must be open or answered'); where.push('status=?'); values.push(status); } return { questions: this.#db.prepare(`SELECT * FROM questions WHERE ${where.join(' AND ')} ORDER BY created_at,id`).all(...values).map((q) => this.#publicQuestion(q)) }; }
  async listOpenQuestions() { return { questions: this.#db.prepare("SELECT q.* FROM questions q JOIN tickets t ON t.id=q.ticket_id WHERE q.status='open' AND t.deleted_at IS NULL AND t.archived_at IS NULL ORDER BY q.blocking DESC,q.created_at,q.id").all().map((q) => this.#publicQuestion(q)) }; }
  #authorized(q, actor) { return q.target_type === 'actor' ? q.target_id === actor.id : actor.role_id === q.target_id; }
  #answerQuestionTx(id, questionId, input) { const ticket = this.#mutableTicket(id); const q = this.#questionRow(questionId); if (q.ticket_id !== id) throw new DomainError(404, 'question_not_found', `question ${questionId} not found`); const requestId = cleanOptional(input.request_id, 'request_id'); if (q.status !== 'open') { if (requestId && q.answer_request_id === requestId) return { question: this.#publicQuestion(q), ticket: this.#ticket(id) }; throw new DomainError(409, 'question_already_answered', 'question was already answered'); } const device = this.#adminDevice(input.actor); const actor = this.#actor(device.actor_id); if (!this.#authorized(q, actor)) throw new DomainError(403, 'question_forbidden', 'actor is not an authorized responder'); const { answer, decision, note } = input; let canonical; if (q.kind === 'approval') { if (!['accept', 'request_changes'].includes(decision) || answer != null) throw new DomainError(400, 'invalid_question_answer', 'approval answer must be accept or request_changes'); canonical = JSON.stringify({ decision, note: cleanOptional(note, 'note') }); } else { if (decision != null || !(canonical = cleanOptional(answer, 'answer'))) throw new DomainError(400, 'invalid_question_answer', 'text question requires a non-empty answer'); } const changed = this.#db.prepare("UPDATE questions SET status='answered',answer=?,answered_by=?,answered_by_role=?,answered_by_device_id=?,answered_at=?,answer_request_id=? WHERE id=? AND status='open'").run(canonical, actor.id, actor.role_id, device.id, this.#now(), requestId, q.id); if (!changed.changes) throw new DomainError(409, 'question_already_answered', 'question was already answered'); this.#event(id, ticket.project, 'question_answered', actor.id, q.kind === 'approval' ? decision : canonical, { question_id: q.id, question_event_id: q.question_event_id ?? null, kind: q.kind, blocking: Boolean(q.blocking), actor_role: actor.role_id }, device.id); if (q.kind === 'approval') { if (ticket.state !== 'Waiting') throw new DomainError(409, 'invalid_state', 'approval ticket is no longer waiting'); const stillBlocked = Boolean(this.#db.prepare("SELECT 1 FROM questions WHERE ticket_id=? AND status='open' AND blocking=1").get(id)); const next = stillBlocked ? 'review' : decision === 'accept' ? 'done' : 'open'; const board = stillBlocked ? 'Waiting' : decision === 'accept' ? 'Done' : 'Open'; this.#db.prepare('UPDATE tickets SET state=?,board_state=?,updated_at=? WHERE id=?').run(next, board, this.#now(), id); this.#event(id, ticket.project, decision === 'accept' ? 'accepted' : 'changes_requested', actor.id, cleanOptional(note, 'note'), { question_id: q.id, actor_role: actor.role_id, pending_blocking_questions: stillBlocked }, device.id); } else if (q.blocking && !this.#db.prepare("SELECT 1 FROM questions WHERE ticket_id=? AND status='open' AND blocking=1").get(id)) { const accepted = this.#db.prepare("SELECT 1 FROM questions WHERE ticket_id=? AND kind='approval' AND status='answered' AND json_extract(answer,'$.decision')='accept' ORDER BY answered_at DESC LIMIT 1").get(id); const next = accepted ? 'done' : 'open', board = accepted ? 'Done' : 'Open'; this.#db.prepare('UPDATE tickets SET state=?,board_state=?,updated_at=? WHERE id=?').run(next, board, this.#now(), id); this.#event(id, ticket.project, 'answer_unblocked', actor.id, null, { question_id: q.id, actor_role: actor.role_id, to: board }, device.id); } return { question: this.#publicQuestion(this.#questionRow(q.id)), ticket: this.#ticket(id) }; }
  async answerQuestion(id, questionId, input) { return this.#transaction(() => this.#answerQuestionTx(id, questionId, input)); }
  async submit(id, input) { return this.#transaction(() => { const requestId = cleanOptional(input.request_id, 'request_id'); if (requestId) { const fingerprint = this.#db.prepare('SELECT * FROM submission_authority WHERE request_id=?').get(requestId); if (fingerprint) { let session = null; try { session = this.#sessionCapability(input.session_capability, input.device); } catch {} const candidate = typeof input.claim_token === 'string' ? hash(input.claim_token) : Buffer.alloc(0); const stored = Buffer.from(fingerprint.claim_token_hash); const validToken = stored.length === candidate.length && timingSafeEqual(stored, candidate); if (fingerprint.ticket_id !== id || fingerprint.actor !== input.actor || fingerprint.device_id !== input.device || fingerprint.session_id !== session?.id || fingerprint.claim_id !== input.claim_id || fingerprint.generation !== input.generation || !validToken) throw new DomainError(409, 'stale_claim', 'submission retry is not from the exact owning fenced session'); const existing = this.#db.prepare('SELECT * FROM questions WHERE id=?').get(fingerprint.question_id); if (!existing) throw new DomainError(409, 'stale_claim', 'submission retry authority no longer resolves to its original approval'); return { ticket: this.#ticket(id), question: this.#publicQuestion(existing) }; } } const ticket = this.#ticket(id); const claim = this.#authority(id, input); if (!['Open','Working'].includes(ticket.state)) throw new DomainError(409, 'invalid_state', 'only open or working tickets can be submitted'); const reviewer = input.reviewer ?? (input.review_target_type ? { type: input.review_target_type, id: input.review_target_id } : null); const target = this.#target(reviewer, { actorActive: true }); if (this.#db.prepare("SELECT 1 FROM questions WHERE ticket_id=? AND kind='approval' AND status='open'").get(id)) throw new DomainError(409, 'approval_exists', 'an approval is already open'); const now = this.#now(); this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(now, claim.claim_id); this.#db.prepare("UPDATE tickets SET state='review',board_state='Waiting',updated_at=? WHERE id=?").run(now, id); const actorRole = this.#actor(claim.actor).role_id; const submittedEventId = this.#event(id, ticket.project, 'submitted', claim.actor, cleanOptional(input.message, 'message'), { review_target_type: target.type, review_target_id: target.id, actor_role: actorRole, session_id: claim.session_id }, claim.device_id); const question = this.#insertQuestion(ticket, claim.actor, { target_type: target.type, target_id: target.id, kind: 'approval', blocking: true, text: 'Approve submitted work?', device_id: claim.device_id, session_id: claim.session_id, submission_request_id: requestId }); if (requestId) this.#db.prepare('INSERT INTO submission_authority(request_id,ticket_id,actor,device_id,session_id,claim_id,claim_token_hash,generation,question_id,submitted_event_id,question_event_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(requestId, id, claim.actor, claim.device_id, claim.session_id, claim.claim_id, claim.token_hash, claim.generation, question.id, submittedEventId, question.question_event_id, now); return { ticket: this.#ticket(id), question }; }); }
  async accept(id, { actor, message = null } = {}) { return this.#transaction(() => { const ticket = this.#mutableTicket(id); if (ticket.state !== 'Waiting') throw new DomainError(409, 'invalid_state', 'only waiting tickets can be accepted'); const approvals = this.#db.prepare("SELECT id FROM questions WHERE ticket_id=? AND kind='approval' AND status='open'").all(id); if (approvals.length !== 1) throw new DomainError(409, 'approval_not_unique', 'exactly one current approval is required'); return this.#answerQuestionTx(id, approvals[0].id, { actor, decision: 'accept', note: message }).ticket; }); }
  async reopen(id, { actor: rawActor = null, message = null } = {}) { return this.#transaction(() => { const ticket = this.#mutableTicket(id); const actor = this.#human(rawActor); if (ticket.state === 'Waiting' && this.#db.prepare("SELECT 1 FROM questions WHERE ticket_id=? AND kind='approval' AND status='open'").get(id)) throw new DomainError(409, 'approval_pending', 'answer the current approval with request_changes'); if (ticket.state === 'Waiting' && this.#db.prepare("SELECT 1 FROM questions WHERE ticket_id=? AND blocking=1 AND status='open'").get(id)) throw new DomainError(409, 'blocking_question_pending', 'answer every blocking question before reopening'); if (ticket.state !== 'Done' && ticket.state !== 'Waiting') throw new DomainError(409, 'invalid_state', 'only review or done tickets can be reopened'); this.#db.prepare("UPDATE tickets SET state='open',board_state='Open',updated_at=? WHERE id=?").run(this.#now(), id); this.#event(id, ticket.project, 'reopened', actor.id, cleanOptional(message, 'message')); return this.#ticket(id); }); }
  async actorInbox(actorId, { after = 0 } = {}) { const actor = this.#actor(actorId); const cursor = Number(after); if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DomainError(400, 'invalid_cursor', 'after must be a non-negative integer'); const questions = this.#db.prepare(`SELECT q.* FROM questions q JOIN tickets t ON t.id=q.ticket_id WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND q.status='open' AND ((q.target_type='actor' AND q.target_id=?) OR (q.target_type='role' AND EXISTS(SELECT 1 FROM actors ra WHERE ra.id=? AND ra.role_id=q.target_id))) ORDER BY q.created_at,q.id`).all(actor.id, actor.id).map((q) => this.#publicQuestion(q)); const events = this.#db.prepare(`SELECT e.id cursor,e.ticket_id,e.project,e.type,e.actor,e.device_id,e.message,e.metadata,e.created_at,e.actor_role,e.machine_name machine FROM events e WHERE e.id>? AND json_extract(e.metadata,'$.question_id') IN (SELECT q.id FROM questions q JOIN tickets t ON t.id=q.ticket_id WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND ((q.target_type='actor' AND q.target_id=?) OR (q.target_type='role' AND EXISTS(SELECT 1 FROM actors ra WHERE ra.id=? AND ra.role_id=q.target_id)))) ORDER BY e.id`).all(cursor, actor.id, actor.id).map((e) => ({ ...e, metadata: parseMetadata(e.metadata) })); const global = Number(this.#db.prepare('SELECT COALESCE(MAX(id),0) cursor FROM events').get().cursor); return { actor, questions, events, cursor: events.length ? events.at(-1).cursor : global }; }
  async listEvents({ project: rawProject, ticket: ticketId, after = 0 } = {}) { const cursor = Number(after); if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DomainError(400, 'invalid_cursor', 'after must be a non-negative integer'); const where = ['e.id>?', '(e.ticket_id IS NULL OR EXISTS(SELECT 1 FROM tickets t WHERE t.id=e.ticket_id AND t.deleted_at IS NULL))']; const values = [cursor]; if (rawProject) { where.push('e.project=?'); values.push(this.#project(rawProject).key); } if (ticketId) { this.#row(ticketId); where.push('e.ticket_id=?'); values.push(ticketId); } const events = this.#db.prepare(`SELECT e.id cursor,e.ticket_id,e.project,e.type,e.actor,e.device_id,e.message,e.metadata,e.created_at,e.actor_role,e.machine_name machine FROM events e WHERE ${where.join(' AND ')} ORDER BY e.id`).all(...values).map((e) => ({ ...e, metadata: parseMetadata(e.metadata) })); const global = Number(this.#db.prepare('SELECT COALESCE(MAX(id),0) cursor FROM events').get().cursor); return { events, cursor: events.length ? events.at(-1).cursor : global }; }
  async listTicketHistory(id, { before = null, limit = 25 } = {}) { this.#row(id); const size = Number(limit); if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new DomainError(400, 'invalid_limit', 'limit must be 1-100'); const ceiling = before == null ? Number.MAX_SAFE_INTEGER : Number(before); if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw new DomainError(400, 'invalid_cursor', 'before must be a positive integer'); const rows = this.#db.prepare(`SELECT id cursor,ticket_id,project,type,actor,device_id,message,metadata,created_at,actor_role,machine_name machine FROM events WHERE ticket_id=? AND id<? ORDER BY id DESC LIMIT ?`).all(id, ceiling, size + 1); const hasMore = rows.length > size; const page = rows.slice(0, size).reverse().map((e) => ({ ...e, metadata: parseMetadata(e.metadata) })); return { events: page, next_before: hasMore ? rows[size - 1].cursor : null, has_more: hasMore }; }
  async auditDeletedTicket(id) { const tombstone = this.#db.prepare('SELECT * FROM ticket_tombstones WHERE ticket_id=?').get(id); if (!tombstone) throw new DomainError(404, 'tombstone_not_found', 'deleted ticket tombstone not found'); const ticket = this.#ticket(id, { includeDeleted: true }); const events = this.#db.prepare('SELECT id cursor,ticket_id,project,type,actor,device_id,message,metadata,created_at,actor_role,machine_name machine FROM events WHERE ticket_id=? ORDER BY id').all(id).map((e) => ({ ...e, metadata: parseMetadata(e.metadata) })); return { tombstone, ticket, events }; }
}
