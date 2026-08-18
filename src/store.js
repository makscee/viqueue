import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

export class Store {
  #file; #now; #db;
  constructor(file, { now = Date.now } = {}) { this.#file = file; this.#now = now; }

  async init() {
    await mkdir(path.dirname(path.resolve(this.#file)), { recursive: true });
    this.#db = new DatabaseSync(this.#file);
    this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (key TEXT PRIMARY KEY,next_number INTEGER NOT NULL,created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(key),number INTEGER NOT NULL,title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',state TEXT NOT NULL CHECK(state IN ('open','review','done')),assigned_to TEXT,
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
  }

  #columns(table) { return this.#db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name); }
  #migrate() {
    this.#transaction(() => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS actors (
          id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('human','agent')),machine TEXT,
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
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
      `);
      const actorColumns = this.#columns('actors');
      if (!actorColumns.includes('machine')) this.#db.exec('ALTER TABLE actors ADD COLUMN machine TEXT');
      if (!actorColumns.includes('updated_at')) { this.#db.exec('ALTER TABLE actors ADD COLUMN updated_at INTEGER'); this.#db.exec('UPDATE actors SET updated_at=created_at WHERE updated_at IS NULL'); }
      const ticketColumns = this.#columns('tickets');
      if (!ticketColumns.includes('assignee_type')) this.#db.exec('ALTER TABLE tickets ADD COLUMN assignee_type TEXT');
      if (!ticketColumns.includes('assignee_id')) this.#db.exec('ALTER TABLE tickets ADD COLUMN assignee_id TEXT');
      if (!ticketColumns.includes('archived_at')) this.#db.exec('ALTER TABLE tickets ADD COLUMN archived_at INTEGER');
      if (!ticketColumns.includes('deleted_at')) this.#db.exec('ALTER TABLE tickets ADD COLUMN deleted_at INTEGER');
      const questionColumns = this.#columns('questions');
      if (!questionColumns.includes('question_event_id')) this.#db.exec('ALTER TABLE questions ADD COLUMN question_event_id INTEGER');
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
      this.#db.exec("UPDATE questions SET question_event_id=(SELECT id FROM events WHERE type='question_asked' AND json_extract(metadata,'$.question_id')=questions.id ORDER BY id LIMIT 1) WHERE question_event_id IS NULL");
      const legacy = this.#db.prepare(`SELECT assigned_to value FROM tickets WHERE assigned_to IS NOT NULL UNION SELECT actor value FROM claims`).all();
      for (const { value } of legacy) {
        if (typeof value !== 'string' || !value.trim()) throw new DomainError(409, 'unsafe_actor_migration', 'legacy actor identity is empty');
        const now = this.#now();
        this.#db.prepare("INSERT OR IGNORE INTO actors(id,name,kind,machine,active,created_at,updated_at) VALUES(?,?,'agent',NULL,1,?,?)").run(value, value, now, now);
        this.#db.prepare("UPDATE tickets SET assignee_type='actor',assignee_id=? WHERE assigned_to=? AND assignee_type IS NULL").run(value, value);
      }
    });
  }

  async close() { this.#db?.close(); this.#db = null; }
  #transaction(fn) { this.#db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.#db.exec('COMMIT'); return value; } catch (error) { try { this.#db.exec('ROLLBACK'); } catch {} throw error; } }
  #event(ticketId, project, type, actor = null, message = null, metadata = null) {
    return Number(this.#db.prepare('INSERT INTO events(ticket_id,project,type,actor,message,created_at,metadata) VALUES(?,?,?,?,?,?,?)')
      .run(ticketId, project, type, actor, message, this.#now(), serializeMetadata(metadata)).lastInsertRowid);
  }
  #eventRow(id) { const row = this.#db.prepare('SELECT id cursor,ticket_id,project,type,actor,message,metadata,created_at FROM events WHERE id=?').get(id); return { ...row, metadata: parseMetadata(row.metadata) }; }
  #project(raw) { const key = String(raw ?? '').toUpperCase(); const row = this.#db.prepare('SELECT key,next_number,created_at FROM projects WHERE key=?').get(key); if (!row) throw new DomainError(404, 'project_not_found', `project ${key} not found`); return { key: row.key, next_number: row.next_number, created_at: row.created_at }; }
  #actorRow(raw) { return this.#db.prepare('SELECT id,name,kind,machine,active,created_at,updated_at FROM actors WHERE id=?').get(String(raw ?? '')) ?? this.#db.prepare('SELECT id,name,kind,machine,active,created_at,updated_at FROM actors WHERE id=?').get(stableId(raw)); }
  #actor(raw, { active = true } = {}) {
    const row = this.#actorRow(raw);
    if (!row) throw new DomainError(404, 'actor_not_found', `actor ${stableId(raw)} not found`);
    if (active && !row.active) throw new DomainError(409, 'actor_inactive', `actor ${row.id} is inactive`);
    return { ...row, active: Boolean(row.active) };
  }
  #human(raw) { const actor = this.#actor(raw); if (actor.kind !== 'human') throw new DomainError(403, 'human_required', 'a human actor is required'); return actor; }
  #role(raw) { const id = stableId(raw); const row = this.#db.prepare('SELECT id,name,created_at FROM roles WHERE id=?').get(id); if (!row) throw new DomainError(404, 'role_not_found', `role ${id} not found`); return row; }
  #activeRoleHolder(roleId) { return this.#db.prepare('SELECT 1 FROM actor_roles ar JOIN actors a ON a.id=ar.actor_id WHERE ar.role_id=? AND a.active=1 LIMIT 1').get(roleId); }
  #target(value, { assignment = false, actorActive = assignment } = {}) {
    if (!value || !['actor', 'role'].includes(value.type) || !value.id) throw new DomainError(400, assignment ? 'assignee_ineligible' : 'invalid_question_target', 'target must identify an actor or role');
    let id = stableId(value.id);
    if (value.type === 'actor') {
      try { id = this.#actor(value.id, { active: actorActive }).id; } catch (error) { if (assignment) throw new DomainError(409, 'assignee_ineligible', error.message); throw error; }
    } else {
      try { this.#role(id); } catch (error) { if (assignment) throw new DomainError(409, 'assignee_ineligible', error.message); throw error; }
      if (!this.#activeRoleHolder(id)) throw new DomainError(409, assignment ? 'assignee_ineligible' : 'question_forbidden', `role ${id} has no active holder`);
    }
    return { type: value.type, id };
  }
  #row(id) { const row = this.#db.prepare(`SELECT t.*,c.claim_id,c.actor claim_actor,c.generation,c.claimed_at FROM tickets t LEFT JOIN claims c ON c.ticket_id=t.id AND c.released_at IS NULL WHERE t.id=?`).get(id); if (!row) throw new DomainError(404, 'ticket_not_found', `ticket ${id} not found`); return row; }
  #publicTicket(row) { return { id: row.id, project: row.project, title: row.title, body: row.body, state: row.state, assigned_to: row.assigned_to ?? (row.assignee_type === 'actor' ? row.assignee_id : null), assignee: row.assignee_type ? { type: row.assignee_type, id: row.assignee_id } : null, archived_at: row.archived_at ?? null, deleted_at: row.deleted_at ?? null, created_at: row.created_at, updated_at: row.updated_at, claim: row.claim_id ? { claim_id: row.claim_id, actor: row.claim_actor, generation: row.generation, claimed_at: row.claimed_at } : null }; }
  #ticket(id) { return this.#publicTicket(this.#row(id)); }
  #mutableTicket(id) { const ticket = this.#ticket(id); if (ticket.deleted_at !== null) throw new DomainError(409, 'ticket_deleted', 'deleted tickets are immutable tombstones'); if (ticket.archived_at !== null) throw new DomainError(409, 'ticket_archived', 'archived tickets are immutable until restored'); return ticket; }
  #title(value) { if (typeof value !== 'string' || !value.trim()) throw new DomainError(400, 'invalid_title', 'title is required'); return value.trim(); }

  async createProject(raw) { return this.#transaction(() => { const key = String(raw ?? '').toUpperCase(); if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw new DomainError(400, 'invalid_project_key', 'project key must be 2-10 uppercase letters or digits'); try { this.#db.prepare('INSERT INTO projects(key,next_number,created_at) VALUES(?,1,?)').run(key, this.#now()); } catch (error) { if (error.code?.startsWith('ERR_SQLITE_CONSTRAINT')) throw new DomainError(409, 'project_exists', `project ${key} already exists`); throw error; } return this.#project(key); }); }
  async listProjects() { return this.#db.prepare('SELECT key,next_number,created_at FROM projects ORDER BY key').all(); }

  async createActor({ id, name, kind = 'agent', machine = null, active = true }) { return this.#transaction(() => { const key = stableId(id); const label = cleanOptional(name, 'name'); const host = cleanOptional(machine, 'machine'); if (!key || !label || !['agent', 'human'].includes(kind)) throw new DomainError(400, 'invalid_actor', 'valid id, name, and kind are required'); const now = this.#now(); try { this.#db.prepare('INSERT INTO actors(id,name,kind,machine,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(key, label, kind, host, active ? 1 : 0, now, now); } catch (error) { if (error.code?.startsWith('ERR_SQLITE_CONSTRAINT')) throw new DomainError(409, 'actor_exists', `actor ${key} already exists`); throw error; } this.#event(null, null, 'actor_created', key, null, { actor_id: key }); return this.#actor(key, { active: false }); }); }
  async getActor(id) { const actor = this.#actor(id, { active: false }); return { ...actor, roles: (await this.listActorRoles(actor.id)).roles }; }
  async listActors({ active } = {}) { const where = active === undefined ? '' : ' WHERE active=?'; const rows = this.#db.prepare(`SELECT id,name,kind,machine,active,created_at,updated_at FROM actors${where} ORDER BY id`).all(...(active === undefined ? [] : [active ? 1 : 0])); return rows.map((r) => ({ ...r, active: Boolean(r.active) })); }
  async updateActor(id, changes = {}) { return this.#transaction(() => { const current = this.#actor(id, { active: false }); const name = 'name' in changes ? cleanOptional(changes.name, 'name') : current.name; const kind = 'kind' in changes ? changes.kind : current.kind; const machine = 'machine' in changes ? cleanOptional(changes.machine, 'machine') : current.machine; const active = 'active' in changes ? Boolean(changes.active) : current.active; if (!name || !['human', 'agent'].includes(kind)) throw new DomainError(400, 'invalid_actor', 'valid name and kind are required'); this.#db.prepare('UPDATE actors SET name=?,kind=?,machine=?,active=?,updated_at=? WHERE id=?').run(name, kind, machine, active ? 1 : 0, this.#now(), current.id); this.#event(null, null, active === current.active ? 'actor_updated' : active ? 'actor_activated' : 'actor_deactivated', current.id, null, { actor_id: current.id }); return this.#actor(current.id, { active: false }); }); }
  async deactivateActor(id) { return this.updateActor(id, { active: false }); }
  async createRole({ id, name }) { return this.#transaction(() => { const key = stableId(id); const label = cleanOptional(name, 'name'); if (!key || !label) throw new DomainError(400, 'invalid_role', 'valid id and name are required'); try { this.#db.prepare('INSERT INTO roles(id,name,created_at) VALUES(?,?,?)').run(key, label, this.#now()); } catch (error) { if (error.code?.startsWith('ERR_SQLITE_CONSTRAINT')) throw new DomainError(409, 'role_exists', `role ${key} already exists`); throw error; } this.#event(null, null, 'role_created', null, null, { role_id: key }); return this.#role(key); }); }
  async listRoles() { return this.#db.prepare('SELECT id,name,created_at FROM roles ORDER BY id').all(); }
  async listRoleActors(roleId) { const role = this.#role(roleId); return { role, actors: this.#db.prepare('SELECT a.id,a.name,a.kind,a.machine,a.active,a.created_at,a.updated_at FROM actors a JOIN actor_roles ar ON ar.actor_id=a.id WHERE ar.role_id=? ORDER BY a.id').all(role.id).map((a) => ({ ...a, active: Boolean(a.active) })) }; }
  async grantRole(actorId, roleId) { return this.#transaction(() => { const actor = this.#actor(actorId); const role = this.#role(roleId); this.#db.prepare('INSERT OR IGNORE INTO actor_roles(actor_id,role_id) VALUES(?,?)').run(actor.id, role.id); this.#event(null, null, 'role_granted', actor.id, null, { role_id: role.id }); return { actor_id: actor.id, role: role.id }; }); }
  async addActorRole(actorId, roleId) { return this.grantRole(actorId, roleId); }
  async revokeRole(actorId, roleId) { return this.#transaction(() => { const actor = this.#actor(actorId, { active: false }); const role = this.#role(roleId); this.#db.prepare('DELETE FROM actor_roles WHERE actor_id=? AND role_id=?').run(actor.id, role.id); this.#event(null, null, 'role_revoked', actor.id, null, { role_id: role.id }); return { actor_id: actor.id, role: role.id }; }); }
  async listActorRoles(actorId) { const actor = this.#actor(actorId, { active: false }); return { roles: this.#db.prepare('SELECT r.id,r.name,r.created_at FROM roles r JOIN actor_roles ar ON ar.role_id=r.id WHERE ar.actor_id=? ORDER BY r.id').all(actor.id) }; }

  async createTicket({ project: rawProject, title, body = '', assignee = null, assignment = undefined, assigned_to = undefined, actor: rawActor = null }) {
    return this.#transaction(() => { const project = this.#project(rawProject); const creator = rawActor == null ? null : this.#human(rawActor); const number = project.next_number; const id = `${project.key}-${number}`; const now = this.#now(); let target = assignee ?? assignment ?? null; const legacy = cleanOptional(assigned_to, 'assigned_to'); if (!target && legacy) target = { type: 'actor', id: legacy }; if (target) target = this.#target(target, { assignment: true }); this.#db.prepare("INSERT INTO tickets(id,project,number,title,body,state,assigned_to,assignee_type,assignee_id,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?,?,?,?)").run(id, project.key, number, this.#title(title), cleanOptional(body, 'body') ?? '', legacy, target?.type ?? null, target?.id ?? null, now, now); this.#db.prepare('UPDATE projects SET next_number=next_number+1 WHERE key=?').run(project.key); this.#event(id, project.key, 'ticket_created', creator?.id ?? null, null, { assignee: target }); return this.#ticket(id); });
  }
  async listTickets(rawProject, { assigneeType, assigneeId, includeArchived = false } = {}) { const project = this.#project(rawProject); const where = ['t.project=?', 't.deleted_at IS NULL']; const values = [project.key]; if (!includeArchived) where.push('t.archived_at IS NULL'); if (assigneeType === 'none') where.push('t.assignee_type IS NULL'); else if (assigneeType || assigneeId) { if (!['actor', 'role'].includes(assigneeType) || !assigneeId) throw new DomainError(400, 'invalid_assignee_filter', 'assignee_type actor|role and assignee_id are required'); where.push('t.assignee_type=? AND t.assignee_id=?'); values.push(assigneeType, stableId(assigneeId)); } return this.#db.prepare(`SELECT t.*,c.claim_id,c.actor claim_actor,c.generation,c.claimed_at FROM tickets t LEFT JOIN claims c ON c.ticket_id=t.id AND c.released_at IS NULL WHERE ${where.join(' AND ')} ORDER BY t.number`).all(...values).map((r) => this.#publicTicket(r)); }
  async getTicket(id) { return this.#ticket(id); }
  async archiveTicket(id, { actor: rawActor }) { return this.#transaction(() => { const ticket = this.#ticket(id); const actor = this.#human(rawActor); if (ticket.deleted_at !== null) throw new DomainError(409, 'ticket_deleted', 'deleted tickets cannot be archived'); if (ticket.archived_at !== null) return ticket; const now = this.#now(); if (ticket.claim) this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(now, ticket.claim.claim_id); this.#db.prepare('UPDATE tickets SET archived_at=?,updated_at=? WHERE id=?').run(now, now, id); this.#event(id, ticket.project, 'archived', actor.id, 'Archived ticket.'); return this.#ticket(id); }); }
  async restoreTicket(id, { actor: rawActor }) { return this.#transaction(() => { const ticket = this.#ticket(id); const actor = this.#human(rawActor); if (ticket.deleted_at !== null) throw new DomainError(409, 'ticket_deleted', 'deleted tickets cannot be restored'); if (ticket.archived_at === null) return ticket; this.#db.prepare('UPDATE tickets SET archived_at=NULL,updated_at=? WHERE id=?').run(this.#now(), id); this.#event(id, ticket.project, 'restored', actor.id, 'Restored ticket from archive.'); return this.#ticket(id); }); }
  async deleteTicket(id, { actor: rawActor, confirmed = false }) { return this.#transaction(() => { if (!confirmed) throw new DomainError(409, 'delete_confirmation_required', 'explicit delete confirmation is required'); const existing = this.#ticket(id); const actor = this.#human(rawActor); if (existing.deleted_at !== null) return existing; if (existing.archived_at !== null) throw new DomainError(409, 'ticket_archived', 'archived tickets are immutable until restored'); const now = this.#now(); if (existing.claim) this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(now, existing.claim.claim_id); this.#db.prepare('UPDATE tickets SET deleted_at=?,updated_at=? WHERE id=?').run(now, now, id); this.#event(id, existing.project, 'deleted', actor.id, 'Deleted ticket (history retained as a tombstone).'); return this.#ticket(id); }); }
  #eligible(ticket, actor) { if (!ticket.assignee) return actor.kind === 'agent'; if (ticket.assignee.type === 'actor') return ticket.assignee.id === actor.id; return Boolean(this.#db.prepare('SELECT 1 FROM actor_roles WHERE actor_id=? AND role_id=?').get(actor.id, ticket.assignee.id)); }
  async next({ project: rawProject, actor: actorId } = {}) { const actor = actorId ? this.#actor(actorId) : null; let query = "SELECT t.*,NULL claim_id,NULL claim_actor,NULL generation,NULL claimed_at FROM tickets t WHERE t.state='open' AND t.archived_at IS NULL AND t.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM claims c WHERE c.ticket_id=t.id AND c.released_at IS NULL)"; const values = []; if (rawProject) { query += ' AND t.project=?'; values.push(this.#project(rawProject).key); } query += ' ORDER BY t.created_at,t.project,t.number'; const rows = this.#db.prepare(query).all(...values).map((r) => this.#publicTicket(r)); return actor ? rows.find((t) => this.#eligible(t, actor)) ?? null : rows[0] ?? null; }
  async editTicket(id, changes = {}) { return this.#transaction(() => {
    const ticket = this.#mutableTicket(id); const actor = this.#human(changes.actor); const row = this.#row(id); let title = ticket.title; let body = ticket.body; let assignee = ticket.assignee; let project = ticket.project; let number = row.number;
    let edited = false; let assigned = false; let moved = false;
    if ('title' in changes) { title = this.#title(changes.title); edited ||= title !== ticket.title; }
    if ('body' in changes) { body = cleanOptional(changes.body, 'body') ?? ''; edited ||= body !== ticket.body; }
    if ('project' in changes) { const destination = this.#project(changes.project); moved = destination.key !== ticket.project; if (moved) { project = destination.key; number = destination.next_number; this.#db.prepare('UPDATE projects SET next_number=next_number+1 WHERE key=?').run(project); } }
    if ('assignee' in changes || 'assignment' in changes || 'assigned_to' in changes) { const value = changes.assignee ?? changes.assignment ?? (cleanOptional(changes.assigned_to, 'assigned_to') ? { type: 'actor', id: changes.assigned_to } : null); assignee = value ? this.#target(value, { assignment: true }) : null; assigned = JSON.stringify(assignee) !== JSON.stringify(ticket.assignee); }
    if (!edited && !assigned && !moved) return ticket;
    this.#db.prepare('UPDATE tickets SET project=?,number=?,title=?,body=?,assigned_to=NULL,assignee_type=?,assignee_id=?,updated_at=? WHERE id=?').run(project, number, title, body, assignee?.type ?? null, assignee?.id ?? null, this.#now(), id);
    if (edited) this.#event(id, project, 'ticket_edited', actor.id, 'Updated ticket title or description.', { previous: { title: ticket.title, body: ticket.body }, current: { title, body } });
    if (moved) this.#event(id, project, 'ticket_moved', actor.id, `Moved from ${ticket.project} to ${project}.`, { from: ticket.project, to: project });
    if (assigned) this.#event(id, project, 'assigned', actor.id, assignee ? `Assigned to ${assignee.type} ${assignee.id}.` : 'Assignment cleared.', { previous: ticket.assignee, assignee });
    return this.#ticket(id);
  }); }

  async setTicketState(id, { state, actor: rawActor }) { return this.#transaction(() => {
    const ticket = this.#mutableTicket(id); const actor = this.#actor(rawActor); if (actor.kind !== 'human') throw new DomainError(403, 'human_required', 'a human actor is required');
    if (!['open', 'review', 'done'].includes(state)) throw new DomainError(400, 'invalid_state', 'state must be open, review, or done');
    if (ticket.state === state) return ticket;
    const now = this.#now();
    if (state !== 'open' && ticket.claim) this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(now, ticket.claim.claim_id);
    if (ticket.state === 'review' && state !== 'review') {
      const decision = state === 'done' ? 'accept' : 'request_changes'; const note = `State changed directly to ${state}.`;
      for (const q of this.#db.prepare("SELECT * FROM questions WHERE ticket_id=? AND kind='approval' AND status='open'").all(id)) {
        this.#db.prepare("UPDATE questions SET status='answered',answer=?,answered_by=?,answered_at=? WHERE id=?").run(JSON.stringify({ decision, note }), actor.id, now, q.id);
        this.#event(id, ticket.project, 'question_answered', actor.id, decision, { question_id: q.id, question_event_id: q.question_event_id ?? null, kind: 'approval' });
      }
    }
    this.#db.prepare('UPDATE tickets SET state=?,updated_at=? WHERE id=?').run(state, now, id);
    this.#event(id, ticket.project, 'state_changed', actor.id, `Moved from ${ticket.state} to ${state}.`, { from: ticket.state, to: state });
    return this.#ticket(id);
  }); }
  async appendTicketEvent(id, { actor: rawActor, message, metadata = null }) { return this.#transaction(() => {
    const ticket = this.#mutableTicket(id); const actor = this.#actor(rawActor); if (actor.kind !== 'human') throw new DomainError(403, 'human_required', 'a human actor is required');
    const text = cleanOptional(message, 'message'); if (!text) throw new DomainError(400, 'invalid_message', 'message is required');
    const cursor = this.#event(id, ticket.project, 'progress', actor.id, text, metadata); return { event: this.#eventRow(cursor), cursor };
  }); }

  async claim(id, { actor: rawActor }) { return this.#transaction(() => { const ticket = this.#ticket(id); const actor = this.#actor(rawActor); if (ticket.state !== 'open' || ticket.claim || ticket.archived_at !== null || ticket.deleted_at !== null) throw new DomainError(409, 'ticket_unavailable', 'ticket is not available to claim'); if (!this.#eligible(ticket, actor)) throw new DomainError(409, 'assignee_ineligible', 'actor is not eligible for this assignment'); const generation = Number(this.#db.prepare('SELECT COALESCE(MAX(generation),0)+1 generation FROM claims WHERE ticket_id=?').get(id).generation); const token = randomBytes(32).toString('base64url'); const claimId = randomUUID(); this.#db.prepare('INSERT INTO claims(claim_id,ticket_id,actor,generation,token_hash,claimed_at) VALUES(?,?,?,?,?,?)').run(claimId, id, actor.id, generation, hash(token), this.#now()); this.#db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(this.#now(), id); this.#event(id, ticket.project, 'claimed', actor.id, null, { machine: actor.machine }); return { ticket: this.#ticket(id), claim_token: token }; }); }
  #authority(id, { claim_id: claimId, actor, generation, claim_token: token }) { const current = this.#db.prepare('SELECT * FROM claims WHERE ticket_id=? AND released_at IS NULL').get(id); const candidate = typeof token === 'string' ? hash(token) : Buffer.alloc(0); const stored = current?.token_hash ? Buffer.from(current.token_hash) : null; const valid = stored && stored.length === candidate.length && timingSafeEqual(stored, candidate); if (!current || current.claim_id !== claimId || current.actor !== actor || current.generation !== generation || !valid) throw new DomainError(409, 'stale_claim', 'claim identity or generation is no longer current'); return current; }
  async verify(id, identity) { this.#row(id); this.#authority(id, identity); return this.#ticket(id); }
  async release(id, identity) { return this.#transaction(() => { const ticket = this.#ticket(id); const claim = this.#authority(id, identity); this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(this.#now(), claim.claim_id); this.#db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(this.#now(), id); this.#event(id, ticket.project, 'released', claim.actor); return this.#ticket(id); }); }
  async takeover(id, { actor: rawActor }) { return this.#transaction(() => { const ticket = this.#ticket(id); const actor = this.#actor(rawActor); if (ticket.state !== 'open' || !ticket.claim) throw new DomainError(409, 'takeover_not_allowed', 'takeover requires a currently claimed open ticket'); if (!this.#eligible(ticket, actor)) throw new DomainError(409, 'assignee_ineligible', 'actor is not eligible for this assignment'); this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(this.#now(), ticket.claim.claim_id); const token = randomBytes(32).toString('base64url'); const claimId = randomUUID(); const generation = ticket.claim.generation + 1; this.#db.prepare('INSERT INTO claims(claim_id,ticket_id,actor,generation,token_hash,claimed_at) VALUES(?,?,?,?,?,?)').run(claimId, id, actor.id, generation, hash(token), this.#now()); this.#db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(this.#now(), id); this.#event(id, ticket.project, 'taken_over', actor.id, null, { machine: actor.machine }); return { ticket: this.#ticket(id), claim_token: token }; }); }
  async postEvent(id, { message, metadata = null, ...identity }) { return this.#transaction(() => { const ticket = this.#ticket(id); const claim = this.#authority(id, identity); const text = cleanOptional(message, 'message'); if (!text) throw new DomainError(400, 'invalid_message', 'message is required'); const cursor = this.#event(id, ticket.project, 'progress', claim.actor, text, metadata); return { event: this.#eventRow(cursor), cursor }; }); }

  #questionRow(id) { const row = this.#db.prepare('SELECT * FROM questions WHERE id=?').get(id); if (!row) throw new DomainError(404, 'question_not_found', `question ${id} not found`); return row; }
  #publicQuestion(q) { return { id: q.id, ticket_id: q.ticket_id, asked_by: q.asked_by, target_type: q.target_type, target_id: q.target_id, kind: q.kind, text: q.text, status: q.status, answer: q.answer, answered_by: q.answered_by, question_event_id: q.question_event_id ?? null, created_at: q.created_at, answered_at: q.answered_at }; }
  #insertQuestion(ticket, asker, { target_type, target_id, kind = 'text', text }) { if (!['text', 'approval'].includes(kind)) throw new DomainError(400, 'invalid_question_kind', 'question kind must be text or approval'); const prompt = cleanOptional(text, 'question_text'); if (!prompt) throw new DomainError(400, 'invalid_question_answer', 'question text is required'); const askerId = this.#actor(asker).id; const target = this.#target({ type: target_type, id: target_id }, { actorActive: true }); const id = `q_${randomBytes(9).toString('base64url')}`; this.#db.prepare("INSERT INTO questions(id,ticket_id,asked_by,target_type,target_id,kind,text,status,created_at) VALUES(?,?,?,?,?,?,?,'open',?)").run(id, ticket.id, askerId, target.type, target.id, kind, prompt, this.#now()); const eventId = this.#event(ticket.id, ticket.project, 'question_asked', askerId, prompt, { question_id: id, kind, target_type: target.type, target_id: target.id }); this.#db.prepare('UPDATE questions SET question_event_id=? WHERE id=?').run(eventId, id); return this.#publicQuestion(this.#questionRow(id)); }
  async askQuestion(id, input) { return this.#transaction(() => { const ticket = this.#ticket(id); const claim = this.#authority(id, input); const kind = input.kind ?? 'text'; if (kind !== 'text') throw new DomainError(400, 'invalid_question_kind', 'claim owners may ask text questions; approval is created by submit'); const targetType = input.target_type ?? input.responder?.type; const targetId = input.target_id ?? input.responder?.id; const text = input.text ?? input.prompt; return { question: this.#insertQuestion(ticket, claim.actor, { target_type: targetType, target_id: targetId, kind, text }), ticket: this.#ticket(id) }; }); }
  async askHumanQuestion(id, input) { return this.#transaction(() => { const ticket = this.#mutableTicket(id); const actor = this.#actor(input.actor); if (actor.kind !== 'human') throw new DomainError(403, 'human_required', 'a human actor is required'); const question = this.#insertQuestion(ticket, actor.id, { target_type: input.target_type ?? input.responder?.type, target_id: input.target_id ?? input.responder?.id, kind: 'text', text: input.text }); return { question, ticket: this.#ticket(id) }; }); }
  async listQuestions(id, { status } = {}) { this.#row(id); const where = ['ticket_id=?']; const values = [id]; if (status) { if (!['open', 'answered'].includes(status)) throw new DomainError(400, 'invalid_question_status', 'status must be open or answered'); where.push('status=?'); values.push(status); } return { questions: this.#db.prepare(`SELECT * FROM questions WHERE ${where.join(' AND ')} ORDER BY created_at,id`).all(...values).map((q) => this.#publicQuestion(q)) }; }
  #authorized(q, actor) { return q.target_type === 'actor' ? q.target_id === actor.id : Boolean(this.#db.prepare('SELECT 1 FROM actor_roles WHERE actor_id=? AND role_id=?').get(actor.id, q.target_id)); }
  #answerQuestionTx(id, questionId, { actor: rawActor, answer, decision, note }) { const ticket = this.#mutableTicket(id); const q = this.#questionRow(questionId); if (q.ticket_id !== id) throw new DomainError(404, 'question_not_found', `question ${questionId} not found`); if (q.status !== 'open') throw new DomainError(409, 'question_already_answered', 'question was already answered'); const actor = this.#actor(rawActor); if (!this.#authorized(q, actor)) throw new DomainError(403, 'question_forbidden', 'actor is not an authorized responder'); let canonical; if (q.kind === 'approval') { if (!['accept', 'request_changes'].includes(decision) || answer != null) throw new DomainError(400, 'invalid_question_answer', 'approval answer must be accept or request_changes'); canonical = JSON.stringify({ decision, note: cleanOptional(note, 'note') }); } else { if (decision != null || !(canonical = cleanOptional(answer, 'answer'))) throw new DomainError(400, 'invalid_question_answer', 'text question requires a non-empty answer'); } const changed = this.#db.prepare("UPDATE questions SET status='answered',answer=?,answered_by=?,answered_at=? WHERE id=? AND status='open'").run(canonical, actor.id, this.#now(), q.id); if (!changed.changes) throw new DomainError(409, 'question_already_answered', 'question was already answered'); this.#event(id, ticket.project, 'question_answered', actor.id, q.kind === 'approval' ? decision : canonical, { question_id: q.id, question_event_id: q.question_event_id ?? null, kind: q.kind }); if (q.kind === 'approval') { if (ticket.state !== 'review') throw new DomainError(409, 'invalid_state', 'approval ticket is no longer in review'); const next = decision === 'accept' ? 'done' : 'open'; this.#db.prepare('UPDATE tickets SET state=?,updated_at=? WHERE id=?').run(next, this.#now(), id); this.#event(id, ticket.project, decision === 'accept' ? 'accepted' : 'changes_requested', actor.id, cleanOptional(note, 'note'), { question_id: q.id }); } return { question: this.#publicQuestion(this.#questionRow(q.id)), ticket: this.#ticket(id) }; }
  async answerQuestion(id, questionId, input) { return this.#transaction(() => this.#answerQuestionTx(id, questionId, input)); }
  async submit(id, input) { return this.#transaction(() => { const ticket = this.#ticket(id); const claim = this.#authority(id, input); if (ticket.state !== 'open') throw new DomainError(409, 'invalid_state', 'only open tickets can be submitted'); const reviewer = input.reviewer ?? (input.review_target_type ? { type: input.review_target_type, id: input.review_target_id } : null); const target = this.#target(reviewer, { actorActive: true }); if (this.#db.prepare("SELECT 1 FROM questions WHERE ticket_id=? AND kind='approval' AND status='open'").get(id)) throw new DomainError(409, 'approval_exists', 'an approval is already open'); const now = this.#now(); this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(now, claim.claim_id); this.#db.prepare("UPDATE tickets SET state='review',updated_at=? WHERE id=?").run(now, id); this.#event(id, ticket.project, 'submitted', claim.actor, cleanOptional(input.message, 'message'), { review_target_type: target.type, review_target_id: target.id }); const question = this.#insertQuestion(ticket, claim.actor, { target_type: target.type, target_id: target.id, kind: 'approval', text: 'Approve submitted work?' }); return { ticket: this.#ticket(id), question }; }); }
  async accept(id, { actor, message = null } = {}) { return this.#transaction(() => { const ticket = this.#mutableTicket(id); if (ticket.state !== 'review') throw new DomainError(409, 'invalid_state', 'only review tickets can be accepted'); const approvals = this.#db.prepare("SELECT id FROM questions WHERE ticket_id=? AND kind='approval' AND status='open'").all(id); if (approvals.length !== 1) throw new DomainError(409, 'approval_not_unique', 'exactly one current approval is required'); return this.#answerQuestionTx(id, approvals[0].id, { actor, decision: 'accept', note: message }).ticket; }); }
  async reopen(id, { actor: rawActor = null, message = null } = {}) { return this.#transaction(() => { const ticket = this.#mutableTicket(id); const actor = this.#human(rawActor); if (ticket.state === 'review' && this.#db.prepare("SELECT 1 FROM questions WHERE ticket_id=? AND kind='approval' AND status='open'").get(id)) throw new DomainError(409, 'approval_pending', 'answer the current approval with request_changes'); if (ticket.state !== 'done' && ticket.state !== 'review') throw new DomainError(409, 'invalid_state', 'only review or done tickets can be reopened'); this.#db.prepare("UPDATE tickets SET state='open',updated_at=? WHERE id=?").run(this.#now(), id); this.#event(id, ticket.project, 'reopened', actor.id, cleanOptional(message, 'message')); return this.#ticket(id); }); }
  async actorInbox(actorId, { after = 0 } = {}) { const actor = this.#actor(actorId); const cursor = Number(after); if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DomainError(400, 'invalid_cursor', 'after must be a non-negative integer'); const questions = this.#db.prepare(`SELECT q.* FROM questions q JOIN tickets t ON t.id=q.ticket_id WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND q.status='open' AND ((q.target_type='actor' AND q.target_id=?) OR (q.target_type='role' AND EXISTS(SELECT 1 FROM actor_roles ar WHERE ar.actor_id=? AND ar.role_id=q.target_id))) ORDER BY q.created_at,q.id`).all(actor.id, actor.id).map((q) => this.#publicQuestion(q)); const events = this.#db.prepare(`SELECT e.id cursor,e.ticket_id,e.project,e.type,e.actor,e.message,e.metadata,e.created_at FROM events e WHERE e.id>? AND json_extract(e.metadata,'$.question_id') IN (SELECT q.id FROM questions q JOIN tickets t ON t.id=q.ticket_id WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND ((q.target_type='actor' AND q.target_id=?) OR (q.target_type='role' AND EXISTS(SELECT 1 FROM actor_roles ar WHERE ar.actor_id=? AND ar.role_id=q.target_id)))) ORDER BY e.id`).all(cursor, actor.id, actor.id).map((e) => ({ ...e, metadata: parseMetadata(e.metadata) })); const global = Number(this.#db.prepare('SELECT COALESCE(MAX(id),0) cursor FROM events').get().cursor); return { actor, questions, events, cursor: events.length ? events.at(-1).cursor : global }; }
  async listEvents({ project: rawProject, ticket: ticketId, after = 0 } = {}) { const cursor = Number(after); if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DomainError(400, 'invalid_cursor', 'after must be a non-negative integer'); const where = ['id>?']; const values = [cursor]; if (rawProject) { where.push('project=?'); values.push(this.#project(rawProject).key); } if (ticketId) { this.#row(ticketId); where.push('ticket_id=?'); values.push(ticketId); } const events = this.#db.prepare(`SELECT id cursor,ticket_id,project,type,actor,message,metadata,created_at FROM events WHERE ${where.join(' AND ')} ORDER BY id`).all(...values).map((e) => ({ ...e, metadata: parseMetadata(e.metadata) })); const global = Number(this.#db.prepare('SELECT COALESCE(MAX(id),0) cursor FROM events').get().cursor); return { events, cursor: events.length ? events.at(-1).cursor : global }; }
}
