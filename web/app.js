import { activityFact, applyActivityFilters, applyTicketFilters, createModalController, dedupeTickets, reconcileProjectSelection, renderMarkdown } from './ui-core.js';

const $ = (selector) => document.querySelector(selector);
const credentialKey = 'viq.deviceCredential';
const lanes = ['Open', 'Working', 'Waiting', 'Done'];
const state = { projects: [], tickets: [], events: [], questions: [], machines: [], actors: [], selectedProjects: new Set(), selectedRoles: new Set(), allProjects: true, active: 'Activity', drag: null, admin: false, vcWriter: false };
const modal = createModalController($('#modal'));
const request = async (path, options = {}) => {
  const credential = localStorage.getItem(credentialKey);
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(options.headers || {}) } });
  const text = await response.text(); const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    if (response.status === 401) { localStorage.removeItem(credentialKey); showPairing('This device pairing is no longer valid. Pair this browser again.'); }
    throw new Error(body?.error?.message || `Request failed (${response.status})`);
  }
  return body;
};
const actorName = (id) => id || 'System';
const roleName = (id) => id || '';
const projection = (ticket) => ticket.state === 'done' ? 'done' : ticket.state === 'review' ? 'review' : ticket.claim ? 'working' : 'todo';
const stateName = (ticket) => ({ todo: 'To do', working: 'Working', review: 'Review', done: 'Done' })[projection(ticket)];
function markdownElement(tag, text, className = '') { const element = document.createElement(tag); element.className = className; element.innerHTML = renderMarkdown(text); return element; }
function openModal({ title, eyebrow = '', content, trigger, initialFocus }) { $('#modal-title').textContent = title; $('#modal-eyebrow').textContent = eyebrow; $('#modal-content').replaceChildren(content); modal.open({ trigger, initialFocus }); }
const report = (error) => { $('#status').textContent = `Something went wrong: ${error.message}`; };
const safely = (handler) => async (event) => { try { await handler(event); } catch (error) { report(error); } };
function showPairing(message = '') { modal.dismiss(); $('#app-shell').hidden = true; $('#refresh').hidden = true; $('#disconnect-device').hidden = true; $('#pairing').hidden = false; $('#pairing-form').reset(); $('#pairing-status').textContent = message; $('#pairing-form').elements.code.focus(); }
function showBoard(identity) { state.admin = Boolean(identity.actor.admin); state.vcWriter = !state.admin && identity.actor.id === 'artem' && identity.actor.active === true && identity.device.id === 'artems-macbook-pro' && identity.device.kind === 'coordinator' && identity.device.status === 'active'; $('#pairing').hidden = true; $('#app-shell').hidden = false; $('#refresh').hidden = false; $('#disconnect-device').hidden = false; for (const id of ['#open-machines', '#open-project-create', '#open-ticket-create']) $(id).hidden = !state.admin; }
function chip(label, pressed, action) { const button = document.createElement('button'); button.type = 'button'; button.className = 'filter-chip'; button.textContent = label; button.setAttribute('aria-pressed', String(pressed)); button.addEventListener('click', action); return button; }
function renderFilters() {
  const keys = state.projects.map(({ key }) => key); const projects = $('#project-chips'); projects.replaceChildren();
  if (!keys.length) projects.append(Object.assign(document.createElement('span'), { className: 'empty', textContent: 'Create a project to organize your tickets.' }));
  else projects.append(chip('All', state.allProjects, () => { state.allProjects = true; state.selectedProjects = new Set(keys); renderFilters(); renderBoard(); }));
  for (const key of keys) projects.append(chip(key, state.selectedProjects.has(key), () => { state.allProjects = false; state.selectedProjects.has(key) ? state.selectedProjects.delete(key) : state.selectedProjects.add(key); if (state.selectedProjects.size === keys.length) state.allProjects = true; renderFilters(); renderBoard(); }));
  const roles = $('#role-chips'); roles.replaceChildren();
  for (const role of ['Human', 'Agent']) roles.append(chip(role, state.selectedRoles.has(role), () => { state.selectedRoles.has(role) ? state.selectedRoles.delete(role) : state.selectedRoles.add(role); renderFilters(); renderBoard(); }));
}
const visibleTickets = () => applyTicketFilters(state.tickets, state.selectedProjects, state.selectedRoles);
function filteredEvents(visible) { return applyActivityFilters(state.events, visible, state.selectedProjects, state.selectedRoles, state.projects.map(({ key }) => key)).toReversed(); }
function announce(message) { $('#status').textContent = message; }
function cardFor(ticket, laneTickets, index) {
  const card = document.createElement('article'); card.className = 'ticket-card'; card.dataset.id = ticket.id; card.draggable = state.admin && ticket.assignment === 'Human'; card.tabIndex = 0;
  card.setAttribute('aria-label', `${ticket.id}, ${ticket.title}, ${ticket.assignment}, ${ticket.state}, position ${index + 1} of ${laneTickets.length}`);
  card.innerHTML = '<button type="button" class="ticket-open"><small></small><strong></strong><span class="card-meta"></span></button>';
  const summary = card.querySelector('.ticket-open'); summary.dataset.id = ticket.id; summary.children[0].textContent = ticket.id; summary.children[1].textContent = ticket.title;
  summary.children[2].textContent = `${ticket.assigned_worker ? `Agent · assigned to ${ticket.assigned_worker.name}` : ticket.assignment}${ticket.open_questions ? ` · ${ticket.open_questions} open question${ticket.open_questions === 1 ? '' : 's'}` : ''}${ticket.claim?.device_id ? ` · active on ${ticket.claim.device_id}` : ''}`;
  summary.addEventListener('click', (event) => { event.stopPropagation(); showDetail(ticket.id, card).catch(report); });
  if (state.vcWriter && ticket.project === 'VC' && /^VC-[1-5]$/.test(ticket.id)) { const control = document.createElement('select'); control.className = 'vc-state-control'; control.setAttribute('aria-label', `Change ${ticket.id} state`); for (const lane of lanes) control.append(new Option(lane, lane)); control.value = ticket.state; control.addEventListener('click', event => event.stopPropagation()); control.addEventListener('change', safely(async event => { event.stopPropagation(); control.disabled = true; await request(`/v1/tickets/${ticket.id}/state`, { method: 'POST', body: JSON.stringify({ state: control.value }) }); await refresh(ticket.id); announce(`${ticket.id} moved to ${control.value}.`); })); card.append(control); }
  card.addEventListener('click', (event) => { if (event.target === card) showDetail(ticket.id, card).catch(report); });
  card.addEventListener('dragstart', (event) => { state.drag = { id: ticket.id, state: ticket.state, index }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', ticket.id); card.classList.add('dragging'); announce(`Moving ${ticket.id}. Drop in a lane, or press Escape to cancel.`); });
  card.addEventListener('dragend', () => { card.classList.remove('dragging'); if (state.drag) announce(`Move cancelled. ${ticket.id} remains in ${state.drag.state}, position ${state.drag.index + 1}.`); state.drag = null; document.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target')); });
  card.addEventListener('keydown', safely(async (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target === card) { event.preventDefault(); await showDetail(ticket.id, card); return; }
    if (event.key === 'Escape' && state.drag) { event.preventDefault(); state.drag = null; announce(`Move cancelled. ${ticket.id} remains in ${ticket.state}, position ${index + 1}.`); return; }
    if (!state.admin || ticket.assignment !== 'Human' || !event.altKey || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
    event.preventDefault(); let nextState = ticket.state; let nextIndex = index;
    if (event.key === 'ArrowUp') nextIndex = Math.max(0, index - 1); if (event.key === 'ArrowDown') nextIndex = Math.min(laneTickets.length - 1, index + 1);
    if (event.key === 'ArrowLeft') { nextState = lanes[Math.max(0, lanes.indexOf(ticket.state) - 1)]; nextIndex = 0; }
    if (event.key === 'ArrowRight') { nextState = lanes[Math.min(lanes.length - 1, lanes.indexOf(ticket.state) + 1)]; nextIndex = 0; }
    if (nextState === ticket.state && nextIndex === index) return;
    const target = visibleTickets().filter((item) => item.state === nextState && item.id !== ticket.id);
    await moveTicket(ticket.id, nextState, nextIndex, target.map(({ id }) => id));
  }));
  return card;
}
async function moveTicket(id, lane, index, visibleIds = visibleTickets().filter((ticket) => ticket.state === lane && ticket.id !== id).map(({ id }) => id)) {
  await request(`/v1/tickets/${encodeURIComponent(id)}/board-position`, { method: 'POST', body: JSON.stringify({ state: lane, index, visible_ids: visibleIds }) });
  state.drag = null; await refresh(id); const laneTickets = visibleTickets().filter((ticket) => ticket.state === lane); const position = laneTickets.findIndex((ticket) => ticket.id === id) + 1; announce(`${id} moved to ${lane}, position ${position} of ${laneTickets.length}.`);
}
function laneSurface(name, tickets) {
  const section = document.createElement('section'); section.className = 'surface lane'; section.dataset.surface = name; section.dataset.column = name.toLowerCase(); if (name === 'Done') section.dataset.tab = 'done'; section.setAttribute('aria-label', `${name} lane`);
  const heading = document.createElement('h2'); heading.innerHTML = `${name} <span>${tickets.length}</span>`; section.append(heading);
  const stack = document.createElement('div'); stack.className = 'card-stack';
  tickets.forEach((ticket, index) => stack.append(cardFor(ticket, tickets, index)));
  if (!tickets.length) stack.innerHTML = '<p class="empty">Nothing here</p>';
  stack.addEventListener('dragover', (event) => { if (!state.drag) return; event.preventDefault(); stack.classList.add('drop-target'); });
  stack.addEventListener('dragleave', () => stack.classList.remove('drop-target'));
  stack.addEventListener('drop', safely(async (event) => { event.preventDefault(); stack.classList.remove('drop-target'); if (!state.drag) return; const cards = [...stack.querySelectorAll('.ticket-card:not(.dragging)')]; const target = event.target.closest('.ticket-card'); const index = target ? cards.indexOf(target) : cards.length; await moveTicket(state.drag.id, name, Math.max(0, index)); }));
  section.append(stack); return section;
}
function visibleQuestions(visible) { const ids = new Set(visible.map(({ id }) => id)); return state.questions.filter((question) => ids.has(question.ticket_id)); }
function activitySurface(events, questions) {
  const section = document.createElement('section'); section.className = 'surface activity'; section.dataset.surface = 'Activity'; section.setAttribute('aria-label', 'Activity'); section.innerHTML = `<h2>Activity <span>${questions.length + events.length}</span></h2>`;
  const open = document.createElement('section'); open.className = 'activity-questions'; open.innerHTML = '<h3>Open questions</h3>'; for (const question of questions) open.append(questionCard(question)); if (!questions.length) open.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No open questions.' })); section.append(open);
  const list = document.createElement('ol'); list.className = 'activity-list';
  for (const event of events) { const item = document.createElement('li'); const fact = activityFact(event); item.innerHTML = '<strong></strong><p></p><small></small>'; item.children[0].textContent = fact.heading; item.children[1].textContent = fact.detail; item.children[2].textContent = new Date(event.created_at).toLocaleString(); list.append(item); }
  if (!events.length) list.innerHTML = '<li class="empty">No matching activity yet.</li>'; section.append(list); return section;
}
function renderBoard(focusId = null) {
  const visible = visibleTickets(); const board = $('#board'); board.replaceChildren(); const events = filteredEvents(visible); const questions = visibleQuestions(visible);
  if (!state.projects.length) {
    const welcome = document.createElement('section'); welcome.className = 'first-project-empty'; welcome.innerHTML = '<p class="eyebrow">Start your board</p><h2>Create your first project</h2><p>Projects keep related tickets together. Choose a short key such as HOME or APP.</p><button type="button">Create your first project</button>';
    welcome.querySelector('button').addEventListener('click', (event) => openProjectCreate(event.currentTarget)); board.append(welcome); $('#filter-empty').hidden = true; $('#state-tabs').hidden = true; return;
  }
  $('#state-tabs').hidden = false; board.append(activitySurface(events, questions)); for (const lane of lanes) board.append(laneSurface(lane, visible.filter((ticket) => ticket.state === lane)));
  $('#filter-empty').hidden = visible.length !== 0; document.querySelectorAll('#state-tabs [data-tab]').forEach((tab) => { const name = tab.dataset.tab; tab.querySelector('span').textContent = name === 'Activity' ? events.length + questions.length : visible.filter((ticket) => ticket.state === name).length; tab.setAttribute('aria-selected', String(name === state.active)); });
  const narrow = matchMedia('(max-width:600px)').matches; board.querySelectorAll('.surface').forEach((surface) => { surface.hidden = narrow && surface.dataset.surface !== state.active; });
  if (focusId) board.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus();
}
async function refresh(focusId = null) {
  const previous = state.projects.map(({ key }) => key);
  const [projects, board, activity, questions, machines] = await Promise.all([request('/v1/projects'), request('/v1/board'), request('/v1/events?after=0'), request('/v1/questions'), state.admin ? request('/v1/machines') : Promise.resolve({ machines: [] })]);
  state.projects = projects.projects; state.tickets = board.tickets; state.events = activity.events; state.questions = questions.questions; state.machines = machines.machines;
  state.selectedProjects = reconcileProjectSelection(previous, state.projects.map(({ key }) => key), state.selectedProjects, null); if (!previous.length) { state.selectedProjects = new Set(state.projects.map(({ key }) => key)); state.allProjects = true; }
  $('#open-ticket-create').disabled = !state.projects.length; $('#open-ticket-create').title = state.projects.length ? '' : 'Create a project first';
  renderFilters(); renderBoard(focusId); announce(state.admin ? (state.projects.length ? `${visibleTickets().length} tickets shown` : 'No projects yet. Create your first project to begin.') : state.vcWriter ? `${visibleTickets().length} tickets shown. State controls are limited to VC-1 through VC-5.` : `${visibleTickets().length} tickets shown. This paired coordinator can read the board; administrative operations remain restricted.`);
}
function questionCard(question, { compact = false, afterAnswer = null } = {}) {
  const ticket = state.tickets.find((item) => item.id === question.ticket_id); const article = document.createElement('article'); article.className = `question-card${question.blocking ? ' blocking' : ' non-blocking'}`; article.dataset.question = question.id;
  article.innerHTML = '<small></small><h3></h3><div class="markdown"></div>'; article.querySelector('small').textContent = `${question.kind === 'approval' ? 'Approval' : question.blocking ? 'Blocking question' : 'Non-blocking question'} · ${question.ticket_id}`; article.querySelector('h3').textContent = ticket?.title || question.ticket_id; article.querySelector('.markdown').innerHTML = renderMarkdown(question.text);
  const form = document.createElement('form'); form.className = 'inline-answer'; const requestId = crypto.randomUUID();
  if (question.kind === 'text') form.innerHTML = `<label>Answer<span class="sr-only"> ${question.ticket_id}</span><textarea name="answer" required rows="${compact ? 2 : 3}"></textarea></label><button>Send answer</button>`;
  else form.innerHTML = '<label>Note (optional)<textarea name="note" rows="2"></textarea></label><div class="form-actions"><button name="decision" value="accept">Accept work</button><button class="secondary" name="decision" value="request_changes">Request changes</button></div>';
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); const decision = event.submitter?.value; [...form.elements].forEach((element) => { element.disabled = true; }); await request(`/v1/tickets/${encodeURIComponent(question.ticket_id)}/questions/${encodeURIComponent(question.id)}/answer`, { method: 'POST', body: JSON.stringify({ request_id: requestId, ...(decision ? { decision, note: data.note } : { answer: data.answer }) }) }); await refresh(); announce(decision === 'accept' ? 'Work accepted' : decision === 'request_changes' ? 'Changes requested' : 'Answer sent'); await afterAnswer?.(); }));
  if (state.admin) article.append(form); return article;
}
const answerCard = (question) => questionCard(question, { compact: true });
const openAnswer = questionCard; // compatibility name; answers render inline and never open a nested modal


function eventItem(event) {
  const labels = { ticket_created: 'Ticket created', ticket_edited: 'Ticket edited', manual_event: 'Factual event', progress: 'Factual event', question_asked: 'Question asked', question_answered: 'Question answered', claimed: 'Work claimed', released: 'Claim released', submitted: 'Submitted', accepted: 'Approved', changes_requested: 'Changes requested', reopened: 'Reopened', state_changed: 'State changed', blocked: 'Blocked', block_resolved: 'Block resolved' };
  const item = document.createElement('li'); item.className = `event event-${event.type}`; item.dataset.cursor = event.cursor;
  const head = document.createElement('div'); head.className = 'event-head'; const title = document.createElement('strong'); title.textContent = labels[event.type] || event.type.replaceAll('_', ' ');
  const provenance = document.createElement('span'); const who = event.actor ? actorName(event.actor) : 'System'; provenance.textContent = `${who}${event.actor_role ? ` · ${roleName(event.actor_role)}` : ''}${event.machine ? ` · ${event.machine}` : ''} · `; const time = document.createElement('time'); time.dateTime = new Date(event.created_at).toISOString(); time.textContent = new Date(event.created_at).toLocaleString(); provenance.append(time); head.append(title, provenance); item.append(head);
  if (event.message) item.append(markdownElement('div', event.message, 'markdown event-message')); return item;
}

async function showDetail(id, trigger, intent = modal.begin()) {
  if (!modal.isActive(intent)) return;
  const focusReturn = trigger?.isConnected ? trigger : document.querySelector(`.ticket-card[data-id="${CSS.escape(id)}"]`);
  const [{ ticket }, { questions }, { blocks }, history] = await Promise.all([request(`/v1/tickets/${id}`), request(`/v1/tickets/${id}/questions`), request(`/v1/tickets/${id}/blocks`), request(`/v1/tickets/${id}/history?limit=25`)]);
  if (!modal.isActive(intent)) return;
  const content = document.createElement('div'); content.className = 'ticket-detail ticket-detail-editor';
  const identity = document.createElement('dl'); identity.className = 'ticket-facts immutable-facts'; identity.innerHTML = `<div><dt>ID</dt><dd></dd></div><div><dt>Project</dt><dd></dd></div><div><dt>Current state</dt><dd></dd></div>`; [ticket.id, ticket.project, ticket.state].forEach((value, index) => { identity.children[index].querySelector('dd').textContent = value; }); content.append(identity);
  const edit = document.createElement('form'); edit.className = 'modal-form detail-edit-form'; edit.innerHTML = '<label>Title<input name="title" required></label><label>Description (Markdown)<textarea name="description" rows="6"></textarea></label><label>Assignment<select name="assignment"><option>Unassigned</option><option>Human</option><option>Agent</option></select></label><button>Save changes</button>'; edit.elements.title.value = ticket.title; edit.elements.description.value = ticket.description; edit.elements.assignment.value = ticket.assignment;
  edit.addEventListener('submit', safely(async (event) => { event.preventDefault(); await request(`/v1/tickets/${ticket.id}`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(edit))) }); await refresh(modal.isActive(intent) ? null : ticket.id); if (!modal.isActive(intent)) return; await showDetail(ticket.id, focusReturn, intent); announce('Ticket updated'); })); if (state.admin) content.append(edit);
  const openSection = document.createElement('section'); openSection.className = 'ticket-open-questions'; openSection.innerHTML = '<h3>Open questions</h3>'; const openQuestions = questions.filter((question) => question.status === 'open'); for (const question of openQuestions) openSection.append(questionCard(question, { compact: true, afterAnswer: async () => { if (modal.isActive(intent)) await showDetail(ticket.id, focusReturn, intent); else document.querySelector(`.ticket-card[data-id="${CSS.escape(ticket.id)}"]`)?.focus(); } })); if (!openQuestions.length) openSection.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No open questions.' })); content.append(openSection);
  const composer = document.createElement('form'); composer.className = 'modal-form manual-event-composer'; composer.innerHTML = '<h3>Add factual event</h3><label>What happened?<textarea name="message" rows="3" required></textarea></label><button>Add event</button>'; composer.addEventListener('submit', safely(async (event) => { event.preventDefault(); await request(`/v1/tickets/${ticket.id}/notes`, { method: 'POST', body: JSON.stringify({ message: composer.elements.message.value }) }); await refresh(modal.isActive(intent) ? null : ticket.id); if (!modal.isActive(intent)) return; await showDetail(ticket.id, focusReturn, intent); announce('Factual event added'); })); if (state.admin) content.append(composer);
  const timeline = document.createElement('section'); timeline.className = 'ticket-history'; timeline.innerHTML = '<h3>Complete history</h3>'; const list = document.createElement('ol'); list.className = 'event-timeline'; history.events.forEach((entry) => list.append(eventItem(entry))); timeline.append(list);
  if (history.has_more) { const more = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary history-more', textContent: 'Load earlier history' }); let before = history.next_before; more.addEventListener('click', safely(async () => { const page = await request(`/v1/tickets/${ticket.id}/history?limit=25&before=${before}`); const fragment = document.createDocumentFragment(); page.events.forEach((entry) => fragment.append(eventItem(entry))); list.prepend(fragment); before = page.next_before; more.hidden = !page.has_more; announce('Earlier history loaded'); })); timeline.append(more); } content.append(timeline);
  for (const block of state.admin ? blocks.filter((item) => item.status === 'open') : []) { const resolve = Object.assign(document.createElement('button'), { type: 'button', textContent: `Resolve block: ${block.reason}`, className: 'secondary resolve-block' }); resolve.addEventListener('click', safely(async () => { await request(`/v1/tickets/${ticket.id}/blocks/${encodeURIComponent(block.id)}/resolve`, { method: 'POST', body: '{}' }); await refresh(modal.isActive(intent) ? null : ticket.id); if (modal.isActive(intent)) await showDetail(ticket.id, focusReturn, intent); })); content.append(resolve); }
  const danger = document.createElement('section'); danger.className = 'danger-zone inline-delete'; danger.innerHTML = '<h3>Delete permanently</h3><p>Deletion is non-restorable. The hidden audit tombstone and complete history are retained.</p><button type="button" class="danger reveal-delete">Delete ticket…</button><form hidden><label><input type="checkbox" name="confirm" required> I understand this ticket cannot be restored</label><button class="danger">Confirm permanent delete</button><button type="button" class="secondary cancel-delete">Cancel</button></form>'; const confirm = danger.querySelector('form'); danger.querySelector('.reveal-delete').addEventListener('click', () => { confirm.hidden = false; danger.querySelector('.reveal-delete').hidden = true; confirm.elements.confirm.focus(); }); danger.querySelector('.cancel-delete').addEventListener('click', () => { confirm.hidden = true; danger.querySelector('.reveal-delete').hidden = false; danger.querySelector('.reveal-delete').focus(); }); confirm.addEventListener('submit', safely(async (event) => { event.preventDefault(); await request(`/v1/tickets/${ticket.id}/delete`, { method: 'POST', body: JSON.stringify({ confirmed: confirm.elements.confirm.checked }) }); modal.dismiss(); await refresh(); announce('Ticket permanently deleted'); })); if (state.admin) content.append(danger);
  if (!modal.isActive(intent)) return;
  $('#modal-title').textContent = ticket.title; $('#modal-eyebrow').textContent = `${ticket.id} · ${ticket.project} · ${ticket.state}`; $('#modal-content').replaceChildren(content);
  modal.open({ title: ticket.title, content, trigger: focusReturn, initialFocus: edit.elements.title, intent });
}

async function openMachines(trigger) {
  state.actors = (await request('/v1/machines/actors')).actors;
  const panel = document.createElement('div'); panel.className = 'machines-panel';
  const list = document.createElement('section'); list.className = 'machine-list'; list.innerHTML = '<h3>Active machines</h3>';
  if (!state.machines.length) list.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No active machines.' }));
  for (const machine of state.machines) {
    const row = document.createElement('div'); row.className = 'machine-row';
    const identity = document.createElement('span'); identity.innerHTML = '<strong></strong><small></small>'; identity.querySelector('strong').textContent = machine.name; identity.querySelector('small').textContent = `${machine.role} · ${machine.id}`;
    const revoke = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary', textContent: 'Revoke' });
    const confirm = document.createElement('form'); confirm.className = 'revoke-confirm'; confirm.hidden = true; confirm.innerHTML = '<span>Revoke this machine?</span><button class="danger">Confirm revoke</button><button type="button" class="secondary">Cancel</button>';
    revoke.addEventListener('click', () => { revoke.hidden = true; confirm.hidden = false; confirm.querySelector('button').focus(); });
    confirm.querySelector('button[type="button"]').addEventListener('click', () => { confirm.hidden = true; revoke.hidden = false; revoke.focus(); });
    confirm.addEventListener('submit', safely(async (event) => { event.preventDefault(); await request(`/v1/machines/${encodeURIComponent(machine.id)}/revoke`, { method: 'POST', body: '{}' }); await refresh(); openMachines(trigger); announce('Machine revoked'); }));
    row.append(identity, revoke, confirm); list.append(row);
  }
  const pairing = document.createElement('form'); pairing.className = 'modal-form machine-pair-form'; pairing.innerHTML = '<h3>Pair device</h3><fieldset><legend>Device type</legend><label><input type="radio" name="type" value="browser" checked> Browser</label><label><input type="radio" name="type" value="worker"> Worker</label></fieldset><label>Name<input name="name" required maxlength="100" autocomplete="off"></label><label class="worker-actor" hidden>Actor<select name="actor_id"></select></label><button>Create code</button><div class="pairing-code-result" aria-live="polite"></div>';
  const actorLabel = pairing.querySelector('.worker-actor'), actorSelect = pairing.elements.actor_id, workerRadio = pairing.querySelector('[value="worker"]'); actorSelect.replaceChildren(...state.actors.map((actor) => new Option(actor.name, actor.id))); workerRadio.disabled = state.actors.length === 0; workerRadio.title = state.actors.length ? '' : 'No active worker actors are available'; const updateType = () => { const worker = pairing.elements.type.value === 'worker'; actorLabel.hidden = !worker; actorSelect.required = worker; }; pairing.elements.type.forEach((radio) => radio.addEventListener('change', updateType)); updateType();
  let expiryTimer; const clearCode = () => { clearTimeout(expiryTimer); pairing.querySelector('.pairing-code-result').replaceChildren(); }; $('#modal').addEventListener('close', clearCode, { once: true });
  pairing.addEventListener('submit', safely(async (event) => {
    event.preventDefault(); clearCode();
    const name = pairing.elements.name.value.trim(), worker = pairing.elements.type.value === 'worker';
    const issued = worker ? await request('/v1/pairing-codes', { method: 'POST', body: JSON.stringify({ actor_id: actorSelect.value, intended_kind: 'worker', device_id: `worker-${crypto.randomUUID()}`, device_name: name }) }) : await request('/v1/machines/pairing-codes', { method: 'POST', body: JSON.stringify({ role: 'Human', name }) });
    const expiryValue = issued.expires ?? issued.expires_at, expiresAt = typeof expiryValue === 'number' || (typeof expiryValue === 'string' && expiryValue.trim()) ? new Date(expiryValue).getTime() : Number.NaN, result = pairing.querySelector('.pairing-code-result');
    if (!Number.isFinite(expiresAt)) throw new Error('Pairing code response contained an invalid expiry');
    const copyButton = (label, value) => { const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary', textContent: `Copy ${label}` }); copy.addEventListener('click', safely(async () => { await navigator.clipboard.writeText(value); announce(`${label} copied`); })); return copy; };
    const done = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary', textContent: 'Done' }); done.addEventListener('click', () => { clearCode(); modal.close(); });
    const instruction = Object.assign(document.createElement('p'), { textContent: worker ? 'In an ordinary Pi session on the worker, run /viq pair <code>, replacing <code> with this one-time code. Pairing authorizes Pi; it does not start a process.' : 'On the other browser, open VIQ and enter all three values exactly as shown. Browser authorization is separate from worker pairing.' });
    const expiryDate = new Date(expiresAt); const expiry = Object.assign(document.createElement('time'), { dateTime: expiryDate.toISOString(), textContent: `Expires ${expiryDate.toLocaleTimeString()}` });
    if (worker) {
      const code = Object.assign(document.createElement('output'), { className: 'one-time-code', textContent: issued.code });
      result.append(code, expiry, instruction, copyButton('code', issued.code), done);
    } else {
      const details = document.createElement('section'); details.className = 'browser-pairing-handoff'; details.setAttribute('role', 'group'); details.setAttribute('aria-label', 'Browser pairing details');
      for (const [label, value, className] of [['One-time code', issued.code, 'one-time-code'], ['Device ID', issued.id, ''], ['Device name', issued.name, '']]) {
        const field = document.createElement('div'); field.className = 'pairing-handoff-field';
        const visibleLabel = Object.assign(document.createElement('span'), { className: 'pairing-handoff-label', textContent: label });
        const output = Object.assign(document.createElement('output'), { className: `pairing-handoff-value ${className}`.trim(), textContent: value }); output.setAttribute('aria-label', label);
        field.append(visibleLabel, output, copyButton(label.toLowerCase() === 'one-time code' ? 'one-time code' : label, value)); details.append(field);
      }
      details.append(expiry); result.append(details, instruction, done);
    }
    expiryTimer = setTimeout(clearCode, Math.max(0, expiresAt - Date.now()));
  }));
  panel.append(list, pairing); openModal({ title: 'Machines', eyebrow: 'Execution provenance', content: panel, trigger, initialFocus: pairing.elements.type[0] });
}



function openProjectCreate(trigger) {
  const form = document.createElement('form'); form.className = 'modal-form project-create-form'; form.innerHTML = '<p>Use a short key that is easy to recognize on every ticket.</p><label>Project key<input name="key" required minlength="2" maxlength="10" pattern="[A-Za-z][A-Za-z0-9]{1,9}" placeholder="HOME" autocomplete="off" aria-describedby="project-key-help"></label><small id="project-key-help">2–10 letters or numbers, starting with a letter.</small><button>Create project</button>';
  form.elements.key.addEventListener('input', () => { form.elements.key.value = form.elements.key.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); });
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const key = form.elements.key.value.trim().toUpperCase(); const result = await request('/v1/projects', { method: 'POST', body: JSON.stringify({ key }) }); state.allProjects = false; state.selectedProjects = new Set([result.project.key]); modal.dismiss(); await refresh(); state.allProjects = false; state.selectedProjects = new Set([result.project.key]); state.active = 'Open'; renderFilters(); renderBoard(); announce(`Project ${result.project.key} created. Create its first ticket.`); openTicketCreate($('#open-ticket-create'), result.project.key); }));
  openModal({ title: state.projects.length ? 'Create project' : 'Create your first project', eyebrow: 'New project', content: form, trigger, initialFocus: form.elements.key });
}

function openTicketCreate(trigger, projectKey = null) {
  if (!state.projects.length) return openProjectCreate(trigger);
  const form = document.createElement('form'); form.className = 'modal-form'; form.innerHTML = '<label>Project<select name="project" required></select></label><label>Ticket title<input name="title" required></label><label>Description (optional)<textarea name="description" rows="4"></textarea></label><label>Assignment<select name="assignment"><option value="Unassigned">Unassigned</option><option value="Human">Human</option></select></label><p class="assignment-help">Assigning work authorizes a paired worker to claim it. Viq never starts Pi.</p><button>Create ticket</button>'; const workers = new Map(state.machines.filter((machine) => machine.role === 'Agent' && machine.actor_id).map((machine) => [machine.actor_id, machine.actor_name || machine.name])); for (const [id, name] of workers) form.elements.assignment.append(new Option(`Agent · ${name}`, `worker:${id}`));
  form.elements.project.replaceChildren(new Option('Choose a project', ''), ...state.projects.map(({ key }) => new Option(key, key))); const selected = projectKey ? [projectKey] : [...state.selectedProjects]; if (selected.length === 1) form.elements.project.value = selected[0];
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); if (data.assignment.startsWith('worker:')) { data.worker_actor_id = data.assignment.slice(7); data.assignment = 'Agent'; } const result = await request('/v1/tickets', { method: 'POST', body: JSON.stringify(data) }); modal.dismiss(); await refresh(result.ticket.id); announce(result.ticket.assigned_worker ? `${result.ticket.id} assigned to ${result.ticket.assigned_worker.name}. Start Pi independently, then run /viq claim ${result.ticket.id}. Use /viq continue only after an answered blocking question.` : `${result.ticket.id} created.`); }));
  $('#modal-title').textContent = 'Create ticket'; $('#modal-eyebrow').textContent = 'Quick capture'; $('#modal-content').replaceChildren(form); modal.open({ trigger, initialFocus: selected.length === 1 ? form.elements.title : form.elements.project });
}
$('#pairing-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; $('#pairing-status').textContent = 'Pairing…'; try { const response = await fetch('/v1/browsers/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: form.elements.code.value }) }); const body = await response.json(); if (!response.ok) throw new Error(body?.error?.message || 'Pairing failed'); localStorage.setItem(credentialKey, body.credential); const identity = await request('/v1/devices/me'); $('#actor-select').replaceChildren(new Option(identity.actor.name, identity.actor.id)); showBoard(identity); await refresh(); } catch (error) { localStorage.removeItem(credentialKey); showPairing(error.message); } });
$('#disconnect-device').addEventListener('click', () => { localStorage.removeItem(credentialKey); showPairing('This browser is disconnected. The server-side device was not revoked.'); });
$('#refresh').addEventListener('click', safely(async () => refresh())); $('#close-modal').addEventListener('click', () => modal.close());
$('#open-machines').addEventListener('click', (event) => openMachines(event.currentTarget)); $('#open-project-create').addEventListener('click', (event) => openProjectCreate(event.currentTarget)); $('#open-ticket-create').addEventListener('click', (event) => openTicketCreate(event.currentTarget));
$('#reset-filters').addEventListener('click', () => { state.allProjects = true; state.selectedProjects = new Set(state.projects.map(({ key }) => key)); state.selectedRoles.clear(); renderFilters(); renderBoard(); });
$('#state-tabs').addEventListener('click', (event) => { const tab = event.target.closest('[data-tab]'); if (!tab) return; state.active = tab.dataset.tab; renderBoard(); });
addEventListener('resize', () => { if (!$('#modal').open) renderBoard(document.activeElement?.closest?.('.ticket-card')?.dataset.id || null); }); addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.drag) { const previous = state.drag; state.drag = null; announce(`Move cancelled. ${previous.id} remains in ${previous.state}, position ${previous.index + 1}.`); renderBoard(previous.id); } });
(async () => { if (!globalThis.__viqPhoneAuthorized && !localStorage.getItem(credentialKey)) return showPairing(); try { const identity = await request('/v1/devices/me'); $('#actor-select').replaceChildren(new Option(identity.actor.name, identity.actor.id)); showBoard(identity); await refresh(); } catch (error) { report(error); } })();
