import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const copy = (value) => structuredClone(value);
const publicTicket = (ticket) => {
  const result = copy(ticket);
  if (result.claim) delete result.claim.token;
  return result;
};

export class Store {
  #file;
  #now;
  #queue = Promise.resolve();
  #data;

  constructor(file, { now = Date.now } = {}) {
    this.#file = file;
    this.#now = now;
  }

  async init() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      this.#data = JSON.parse(await readFile(this.#file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.#data = { projects: {}, tickets: {} };
      await this.#save();
    }
  }

  #exclusive(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #save() {
    const temp = `${this.#file}.${process.pid}.tmp`;
    const handle = await open(temp, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(this.#data, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, this.#file);
    const dir = await open(path.dirname(this.#file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }

  createProject(rawKey) {
    return this.#exclusive(async () => {
      const key = String(rawKey ?? '').toUpperCase();
      if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) {
        throw new DomainError(400, 'invalid_project_key', 'project key must be 2-10 uppercase letters or digits');
      }
      if (this.#data.projects[key]) throw new DomainError(409, 'project_exists', `project ${key} already exists`);
      const project = { key, next_number: 1 };
      this.#data.projects[key] = project;
      await this.#save();
      return copy(project);
    });
  }

  createTicket({ project: rawProject, title }) {
    return this.#exclusive(async () => {
      const project = this.#data.projects[String(rawProject ?? '').toUpperCase()];
      if (!project) throw new DomainError(404, 'project_not_found', 'project not found');
      if (typeof title !== 'string' || !title.trim()) throw new DomainError(400, 'invalid_title', 'title is required');
      const id = `${project.key}-${project.next_number++}`;
      const ticket = { id, project: project.key, title: title.trim(), state: 'ready', evidence: null, claim: null };
      this.#data.tickets[id] = ticket;
      await this.#save();
      return copy(ticket);
    });
  }

  #refresh(ticket) {
    if (ticket.state === 'claimed' && this.#now() >= ticket.claim.expires_at) {
      ticket.state = 'stale';
      return true;
    }
    return false;
  }

  next() {
    return this.#exclusive(async () => {
      let changed = false;
      let available = null;
      for (const ticket of Object.values(this.#data.tickets)) {
        changed = this.#refresh(ticket) || changed;
        if (!available && ticket.state === 'ready') available = ticket;
      }
      if (changed) await this.#save();
      return available ? publicTicket(available) : null;
    });
  }

  getTicket(id) {
    return this.#exclusive(async () => {
      const ticket = this.#ticket(id);
      if (this.#refresh(ticket)) await this.#save();
      return publicTicket(ticket);
    });
  }

  claim(id, { actor, ttl_ms: ttl }) {
    return this.#exclusive(async () => {
      const ticket = this.#ticket(id);
      this.#refresh(ticket);
      if (ticket.state !== 'ready') throw new DomainError(409, 'ticket_unavailable', 'ticket is not available to claim');
      const result = this.#newClaim(ticket, actor, ttl, 1);
      await this.#save();
      return result;
    });
  }

  renew(id, { actor, claim_token: token, generation, ttl_ms: rawTtl }) {
    return this.#exclusive(async () => {
      const ticket = this.#ticket(id);
      const changed = this.#refresh(ticket);
      const valid = ticket.claim && ticket.claim.actor === actor && ticket.claim.token === token && ticket.claim.generation === generation;
      if (!valid) {
        if (changed) await this.#save();
        throw new DomainError(409, 'stale_claim', 'claim token or generation is no longer current');
      }
      if (ticket.state !== 'claimed') {
        if (changed) await this.#save();
        throw new DomainError(409, 'claim_expired', 'claim is stale and requires explicit takeover');
      }
      const ttl = this.#ttl(rawTtl);
      ticket.claim.expires_at = this.#now() + ttl;
      await this.#save();
      return { ticket: publicTicket(ticket), claim_token: token };
    });
  }

  takeover(id, { actor, ttl_ms: ttl }) {
    return this.#exclusive(async () => {
      const ticket = this.#ticket(id);
      this.#refresh(ticket);
      if (ticket.state !== 'stale') throw new DomainError(409, 'takeover_not_allowed', 'only a stale claim can be taken over');
      const result = this.#newClaim(ticket, actor, ttl, ticket.claim.generation + 1);
      await this.#save();
      return result;
    });
  }

  #newClaim(ticket, actor, rawTtl, generation) {
    const ttl = this.#ttl(rawTtl);
    if (typeof actor !== 'string' || !actor.trim()) throw new DomainError(400, 'invalid_actor', 'actor is required');
    const token = randomBytes(24).toString('base64url');
    ticket.state = 'claimed';
    ticket.claim = { actor: actor.trim(), generation, expires_at: this.#now() + ttl, token };
    return { ticket: publicTicket(ticket), claim_token: token };
  }

  update(id, { actor, claim_token: token, generation, status, evidence = null }) {
    return this.#exclusive(async () => {
      const ticket = this.#ticket(id);
      const changed = this.#refresh(ticket);
      const valid = ticket.claim && ticket.claim.actor === actor && ticket.claim.token === token && ticket.claim.generation === generation;
      if (!valid) {
        if (changed) await this.#save();
        throw new DomainError(409, 'stale_claim', 'claim token or generation is no longer current');
      }
      if (ticket.state !== 'claimed') {
        if (changed) await this.#save();
        throw new DomainError(409, 'claim_expired', 'claim is stale and requires explicit takeover');
      }
      if (status !== 'submitted') throw new DomainError(400, 'invalid_status', 'phase 0 only supports submitted');
      if (!(typeof evidence === 'string' || (evidence && typeof evidence === 'object'))) {
        throw new DomainError(400, 'invalid_evidence', 'evidence must be text or JSON');
      }
      ticket.state = 'submitted';
      ticket.evidence = copy(evidence);
      await this.#save();
      return publicTicket(ticket);
    });
  }

  #ttl(rawTtl) {
    const ttl = Number(rawTtl);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86_400_000) {
      throw new DomainError(400, 'invalid_ttl', 'ttl_ms must be 1..86400000');
    }
    return ttl;
  }

  #ticket(id) {
    const ticket = this.#data.tickets[id];
    if (!ticket) throw new DomainError(404, 'ticket_not_found', `ticket ${id} not found`);
    return ticket;
  }
}
