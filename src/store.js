import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const hash = (token) => createHash('sha256').update(token).digest();
const cleanOptional = (value, field) => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new DomainError(400, `invalid_${field}`, `${field} must be text or null`);
  return value.trim() || null;
};

export class Store {
  #file;
  #now;
  #db;

  constructor(file, { now = Date.now } = {}) {
    this.#file = file;
    this.#now = now;
  }

  async init() {
    await mkdir(path.dirname(path.resolve(this.#file)), { recursive: true });
    this.#db = new DatabaseSync(this.#file);
    this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        key TEXT PRIMARY KEY, next_number INTEGER NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(key), number INTEGER NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', state TEXT NOT NULL CHECK(state IN ('open','review','done')),
        assigned_to TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(project, number)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS claims (
        claim_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), actor TEXT NOT NULL,
        generation INTEGER NOT NULL, token_hash BLOB NOT NULL, claimed_at INTEGER NOT NULL, released_at INTEGER,
        UNIQUE(ticket_id, generation)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS claims_one_current ON claims(ticket_id) WHERE released_at IS NULL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT REFERENCES tickets(id), project TEXT NOT NULL REFERENCES projects(key),
        type TEXT NOT NULL, actor TEXT, message TEXT, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_project_cursor ON events(project, id);
      CREATE INDEX IF NOT EXISTS events_ticket_cursor ON events(ticket_id, id);
    `);
  }

  async close() {
    this.#db?.close();
    this.#db = null;
  }

  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  #event(ticketId, project, type, actor = null, message = null) {
    const result = this.#db.prepare('INSERT INTO events(ticket_id, project, type, actor, message, created_at) VALUES(?,?,?,?,?,?)')
      .run(ticketId, project, type, actor, message, this.#now());
    return Number(result.lastInsertRowid);
  }

  #project(rawKey) {
    const key = String(rawKey ?? '').toUpperCase();
    const project = this.#db.prepare('SELECT key, next_number, created_at FROM projects WHERE key=?').get(key);
    if (!project) throw new DomainError(404, 'project_not_found', `project ${key} not found`);
    return { key: project.key, next_number: project.next_number, created_at: project.created_at };
  }

  #row(id) {
    const row = this.#db.prepare(`
      SELECT t.*, c.claim_id, c.actor claim_actor, c.generation, c.claimed_at
      FROM tickets t LEFT JOIN claims c ON c.ticket_id=t.id AND c.released_at IS NULL WHERE t.id=?
    `).get(id);
    if (!row) throw new DomainError(404, 'ticket_not_found', `ticket ${id} not found`);
    return row;
  }

  #public(row) {
    return {
      id: row.id, project: row.project, title: row.title, body: row.body, state: row.state,
      assigned_to: row.assigned_to, created_at: row.created_at, updated_at: row.updated_at,
      claim: row.claim_id ? {
        claim_id: row.claim_id, actor: row.claim_actor, generation: row.generation, claimed_at: row.claimed_at
      } : null
    };
  }

  #ticket(id) { return this.#public(this.#row(id)); }

  #title(value) {
    if (typeof value !== 'string' || !value.trim()) throw new DomainError(400, 'invalid_title', 'title is required');
    return value.trim();
  }

  async createProject(rawKey) {
    return this.#transaction(() => {
      const key = String(rawKey ?? '').toUpperCase();
      if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) {
        throw new DomainError(400, 'invalid_project_key', 'project key must be 2-10 uppercase letters or digits');
      }
      try { this.#db.prepare('INSERT INTO projects(key,next_number,created_at) VALUES(?,1,?)').run(key, this.#now()); }
      catch (error) {
        if (error.code?.startsWith('ERR_SQLITE_CONSTRAINT')) throw new DomainError(409, 'project_exists', `project ${key} already exists`);
        throw error;
      }
      return this.#project(key);
    });
  }

  async listProjects() {
    return this.#db.prepare('SELECT key, next_number, created_at FROM projects ORDER BY key').all()
      .map((row) => ({ key: row.key, next_number: row.next_number, created_at: row.created_at }));
  }

  async createTicket({ project: rawProject, title, body = '', assigned_to: assignedTo = null }) {
    return this.#transaction(() => {
      const project = this.#project(rawProject);
      const number = project.next_number;
      const id = `${project.key}-${number}`;
      const timestamp = this.#now();
      const cleanBody = cleanOptional(body, 'body') ?? '';
      const assignment = cleanOptional(assignedTo, 'assigned_to');
      this.#db.prepare(`INSERT INTO tickets(id,project,number,title,body,state,assigned_to,created_at,updated_at)
        VALUES(?,?,?,?,?,'open',?,?,?)`).run(id, project.key, number, this.#title(title), cleanBody, assignment, timestamp, timestamp);
      this.#db.prepare('UPDATE projects SET next_number=next_number+1 WHERE key=?').run(project.key);
      this.#event(id, project.key, 'ticket_created', null, null);
      return this.#ticket(id);
    });
  }

  async listTickets(rawProject) {
    const project = this.#project(rawProject);
    return this.#db.prepare(`
      SELECT t.*, c.claim_id, c.actor claim_actor, c.generation, c.claimed_at
      FROM tickets t LEFT JOIN claims c ON c.ticket_id=t.id AND c.released_at IS NULL
      WHERE t.project=? ORDER BY t.number
    `).all(project.key).map((row) => this.#public(row));
  }

  async getTicket(id) { return this.#ticket(id); }

  async next({ project: rawProject } = {}) {
    let query = `SELECT t.*, NULL claim_id, NULL claim_actor, NULL generation, NULL claimed_at FROM tickets t
      WHERE t.state='open' AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.ticket_id=t.id AND c.released_at IS NULL)`;
    const values = [];
    if (rawProject) { const project = this.#project(rawProject); query += ' AND t.project=?'; values.push(project.key); }
    query += ' ORDER BY t.created_at,t.project,t.number LIMIT 1';
    const row = this.#db.prepare(query).get(...values);
    return row ? this.#public(row) : null;
  }

  async claim(id, { actor }) {
    return this.#transaction(() => {
      const ticket = this.#ticket(id);
      const owner = cleanOptional(actor, 'actor');
      if (!owner) throw new DomainError(400, 'invalid_actor', 'actor is required');
      if (ticket.state !== 'open' || ticket.claim) throw new DomainError(409, 'ticket_unavailable', 'ticket is not available to claim');
      const generation = Number(this.#db.prepare('SELECT COALESCE(MAX(generation),0)+1 generation FROM claims WHERE ticket_id=?').get(id).generation);
      const token = randomBytes(32).toString('base64url');
      const claimId = randomUUID();
      this.#db.prepare('INSERT INTO claims(claim_id,ticket_id,actor,generation,token_hash,claimed_at) VALUES(?,?,?,?,?,?)')
        .run(claimId, id, owner, generation, hash(token), this.#now());
      this.#db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(this.#now(), id);
      this.#event(id, ticket.project, 'claimed', owner);
      return { ticket: this.#ticket(id), claim_token: token };
    });
  }

  #authority(id, { claim_id: claimId, actor, generation, claim_token: token }) {
    const current = this.#db.prepare('SELECT * FROM claims WHERE ticket_id=? AND released_at IS NULL').get(id);
    const candidate = typeof token === 'string' ? hash(token) : Buffer.alloc(0);
    const stored = current?.token_hash ? Buffer.from(current.token_hash) : null;
    const validToken = stored && stored.length === candidate.length && timingSafeEqual(stored, candidate);
    if (!current || current.claim_id !== claimId || current.actor !== actor || current.generation !== generation || !validToken) {
      throw new DomainError(409, 'stale_claim', 'claim identity or generation is no longer current');
    }
    return current;
  }

  async verify(id, identity) {
    this.#row(id);
    this.#authority(id, identity);
    return this.#ticket(id);
  }

  async release(id, identity) {
    return this.#transaction(() => {
      const ticket = this.#ticket(id);
      const claim = this.#authority(id, identity);
      this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(this.#now(), claim.claim_id);
      this.#db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(this.#now(), id);
      this.#event(id, ticket.project, 'released', claim.actor);
      return this.#ticket(id);
    });
  }

  async takeover(id, { actor }) {
    return this.#transaction(() => {
      const ticket = this.#ticket(id);
      const owner = cleanOptional(actor, 'actor');
      if (!owner) throw new DomainError(400, 'invalid_actor', 'actor is required');
      if (ticket.state !== 'open' || !ticket.claim) throw new DomainError(409, 'takeover_not_allowed', 'takeover requires a currently claimed open ticket');
      this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(this.#now(), ticket.claim.claim_id);
      const token = randomBytes(32).toString('base64url');
      const claimId = randomUUID();
      const generation = ticket.claim.generation + 1;
      this.#db.prepare('INSERT INTO claims(claim_id,ticket_id,actor,generation,token_hash,claimed_at) VALUES(?,?,?,?,?,?)')
        .run(claimId, id, owner, generation, hash(token), this.#now());
      this.#db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(this.#now(), id);
      this.#event(id, ticket.project, 'taken_over', owner);
      return { ticket: this.#ticket(id), claim_token: token };
    });
  }

  async postEvent(id, { message, ...identity }) {
    return this.#transaction(() => {
      const ticket = this.#ticket(id);
      const claim = this.#authority(id, identity);
      const note = cleanOptional(message, 'message');
      if (!note) throw new DomainError(400, 'invalid_message', 'message is required');
      const cursor = this.#event(id, ticket.project, 'progress', claim.actor, note);
      return { event: this.#db.prepare('SELECT id cursor,ticket_id,project,type,actor,message,created_at FROM events WHERE id=?').get(cursor), cursor };
    });
  }

  async submit(id, { message = null, ...identity }) {
    return this.#transaction(() => {
      const ticket = this.#ticket(id);
      const claim = this.#authority(id, identity);
      if (ticket.state !== 'open') throw new DomainError(409, 'invalid_state', 'only open tickets can be submitted');
      const timestamp = this.#now();
      this.#db.prepare('UPDATE claims SET released_at=? WHERE claim_id=?').run(timestamp, claim.claim_id);
      this.#db.prepare("UPDATE tickets SET state='review',updated_at=? WHERE id=?").run(timestamp, id);
      this.#event(id, ticket.project, 'submitted', claim.actor, cleanOptional(message, 'message'));
      return this.#ticket(id);
    });
  }

  async accept(id, { actor = null, message = null } = {}) {
    return this.#transition(id, 'review', 'done', 'accepted', actor, message);
  }

  async reopen(id, { actor = null, message = null } = {}) {
    return this.#transaction(() => {
      const ticket = this.#ticket(id);
      if (!['review', 'done'].includes(ticket.state)) throw new DomainError(409, 'invalid_state', 'only review or done tickets can be reopened');
      this.#db.prepare("UPDATE tickets SET state='open',updated_at=? WHERE id=?").run(this.#now(), id);
      this.#event(id, ticket.project, 'reopened', cleanOptional(actor, 'actor'), cleanOptional(message, 'message'));
      return this.#ticket(id);
    });
  }

  #transition(id, from, to, type, actor, message) {
    return this.#transaction(() => {
      const ticket = this.#ticket(id);
      if (ticket.state !== from) throw new DomainError(409, 'invalid_state', `only ${from} tickets can be ${type}`);
      this.#db.prepare('UPDATE tickets SET state=?,updated_at=? WHERE id=?').run(to, this.#now(), id);
      this.#event(id, ticket.project, type, cleanOptional(actor, 'actor'), cleanOptional(message, 'message'));
      return this.#ticket(id);
    });
  }

  async editTicket(id, changes = {}) {
    return this.#transaction(() => {
      const ticket = this.#ticket(id);
      const actor = cleanOptional(changes.actor, 'actor');
      let title = ticket.title;
      let body = ticket.body;
      let assignedTo = ticket.assigned_to;
      let edited = false;
      let assigned = false;
      if ('title' in changes) { title = this.#title(changes.title); edited = title !== ticket.title || edited; }
      if ('body' in changes) { body = cleanOptional(changes.body, 'body') ?? ''; edited = body !== ticket.body || edited; }
      if ('assigned_to' in changes) { assignedTo = cleanOptional(changes.assigned_to, 'assigned_to'); assigned = assignedTo !== ticket.assigned_to; }
      if (!edited && !assigned) return ticket;
      this.#db.prepare('UPDATE tickets SET title=?,body=?,assigned_to=?,updated_at=? WHERE id=?')
        .run(title, body, assignedTo, this.#now(), id);
      if (edited) this.#event(id, ticket.project, 'ticket_edited', actor);
      if (assigned) this.#event(id, ticket.project, 'assigned', actor, assignedTo);
      return this.#ticket(id);
    });
  }

  async listEvents({ project: rawProject, ticket: ticketId, after = 0 } = {}) {
    const cursor = Number(after);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DomainError(400, 'invalid_cursor', 'after must be a non-negative integer');
    const where = ['id>?'];
    const values = [cursor];
    if (rawProject) { const project = this.#project(rawProject); where.push('project=?'); values.push(project.key); }
    if (ticketId) { this.#row(ticketId); where.push('ticket_id=?'); values.push(ticketId); }
    const events = this.#db.prepare(`SELECT id cursor,ticket_id,project,type,actor,message,created_at FROM events WHERE ${where.join(' AND ')} ORDER BY id`).all(...values);
    const global = Number(this.#db.prepare('SELECT COALESCE(MAX(id),0) cursor FROM events').get().cursor);
    return { events, cursor: events.length ? events.at(-1).cursor : global };
  }
}
