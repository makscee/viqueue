import { activityFact, applyActivityFilters, applyTicketFilters, createModalController, dedupeTickets, reconcileProjectSelection, renderMarkdown } from './ui-core.js';

const $ = (selector) => document.querySelector(selector);
const credentialKey = 'viq.deviceCredential';
const lanes = ['Open', 'Working', 'Waiting', 'Done'];
const state = { projects: [], tickets: [], events: [], questions: [], actors: [], devices: [], roles: [], inbox: [], selectedProjects: new Set(), selectedRoles: new Set(), allProjects: true, active: 'Activity', drag: null };
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
const actorId = () => $('#actor-select').value;
const actorName = (id) => state.actors.find((actor) => actor.id === id)?.name || id;
const roleName = (id) => state.roles.find((role) => role.id === id)?.name || 'Assigned group';
const assigneeName = (assignee) => assignee?.type === 'actor' ? actorName(assignee.id) : assignee?.type === 'role' ? roleName(assignee.id) : 'Unassigned';
const projection = (ticket) => ticket.state === 'done' ? 'done' : ticket.state === 'review' ? 'review' : ticket.claim ? 'working' : 'todo';
const stateName = (ticket) => ({ todo: 'To do', working: 'Working', review: 'Review', done: 'Done' })[projection(ticket)];
function markdownElement(tag, text, className = '') { const element = document.createElement(tag); element.className = className; element.innerHTML = renderMarkdown(text); return element; }
function openModal({ title, eyebrow = '', content, trigger, initialFocus }) { $('#modal-title').textContent = title; $('#modal-eyebrow').textContent = eyebrow; $('#modal-content').replaceChildren(content); modal.open({ trigger, initialFocus }); }
const report = (error) => { $('#status').textContent = `Something went wrong: ${error.message}`; };
const safely = (handler) => async (event) => { try { await handler(event); } catch (error) { report(error); } };
function showPairing(message = '') { modal.dismiss(); $('#app-shell').hidden = true; $('#refresh').hidden = true; $('#disconnect-device').hidden = true; $('#pairing').hidden = false; $('#pairing-form').reset(); $('#pairing-status').textContent = message; $('#pairing-form').elements.code.focus(); }
function showBoard() { $('#pairing').hidden = true; $('#app-shell').hidden = false; $('#refresh').hidden = false; $('#disconnect-device').hidden = false; }
function chip(label, pressed, action) { const button = document.createElement('button'); button.type = 'button'; button.className = 'filter-chip'; button.textContent = label; button.setAttribute('aria-pressed', String(pressed)); button.addEventListener('click', action); return button; }
function renderFilters() {
  const keys = state.projects.map(({ key }) => key); const projects = $('#project-chips'); projects.replaceChildren();
  projects.append(chip('All', state.allProjects, () => { state.allProjects = true; state.selectedProjects = new Set(keys); renderFilters(); renderBoard(); }));
  for (const key of keys) projects.append(chip(key, state.selectedProjects.has(key), () => { state.allProjects = false; state.selectedProjects.has(key) ? state.selectedProjects.delete(key) : state.selectedProjects.add(key); if (state.selectedProjects.size === keys.length) state.allProjects = true; renderFilters(); renderBoard(); }));
  const roles = $('#role-chips'); roles.replaceChildren();
  for (const role of ['Human', 'Agent']) roles.append(chip(role, state.selectedRoles.has(role), () => { state.selectedRoles.has(role) ? state.selectedRoles.delete(role) : state.selectedRoles.add(role); renderFilters(); renderBoard(); }));
}
const visibleTickets = () => applyTicketFilters(state.tickets, state.selectedProjects, state.selectedRoles);
function filteredEvents(visible) { return applyActivityFilters(state.events, visible, state.selectedProjects, state.selectedRoles, state.projects.map(({ key }) => key)).toReversed(); }
function announce(message) { $('#status').textContent = message; }
function cardFor(ticket, laneTickets, index) {
  const card = document.createElement('article'); card.className = 'ticket-card'; card.dataset.id = ticket.id; card.draggable = ticket.assignment === 'Human'; card.tabIndex = 0;
  card.setAttribute('aria-label', `${ticket.id}, ${ticket.title}, ${ticket.assignment}, ${ticket.state}, position ${index + 1} of ${laneTickets.length}`);
  card.innerHTML = '<button type="button" class="ticket-open"><small></small><strong></strong><span class="card-meta"></span></button>';
  const summary = card.querySelector('.ticket-open'); summary.dataset.id = ticket.id; summary.children[0].textContent = ticket.id; summary.children[1].textContent = ticket.title;
  summary.children[2].textContent = `${ticket.assignment}${ticket.open_questions ? ` · ${ticket.open_questions} open question${ticket.open_questions === 1 ? '' : 's'}` : ''}${ticket.claim?.device_id ? ` · active on ${ticket.claim.device_id}` : ''}`;
  summary.addEventListener('click', (event) => { event.stopPropagation(); showDetail(ticket.id, card).catch(report); });
  card.addEventListener('click', (event) => { if (event.target === card) showDetail(ticket.id, card).catch(report); });
  card.addEventListener('dragstart', (event) => { state.drag = { id: ticket.id, state: ticket.state, index }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', ticket.id); card.classList.add('dragging'); announce(`Moving ${ticket.id}. Drop in a lane, or press Escape to cancel.`); });
  card.addEventListener('dragend', () => { card.classList.remove('dragging'); if (state.drag) announce(`Move cancelled. ${ticket.id} remains in ${state.drag.state}, position ${state.drag.index + 1}.`); state.drag = null; document.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target')); });
  card.addEventListener('keydown', safely(async (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target === card) { event.preventDefault(); await showDetail(ticket.id, card); return; }
    if (event.key === 'Escape' && state.drag) { event.preventDefault(); state.drag = null; announce(`Move cancelled. ${ticket.id} remains in ${ticket.state}, position ${index + 1}.`); return; }
    if (ticket.assignment !== 'Human' || !event.altKey || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
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
  board.append(activitySurface(events, questions)); for (const lane of lanes) board.append(laneSurface(lane, visible.filter((ticket) => ticket.state === lane)));
  $('#filter-empty').hidden = visible.length !== 0; document.querySelectorAll('#state-tabs [data-tab]').forEach((tab) => { const name = tab.dataset.tab; tab.querySelector('span').textContent = name === 'Activity' ? events.length + questions.length : visible.filter((ticket) => ticket.state === name).length; tab.setAttribute('aria-selected', String(name === state.active)); });
  const narrow = matchMedia('(max-width:600px)').matches; board.querySelectorAll('.surface').forEach((surface) => { surface.hidden = narrow && surface.dataset.surface !== state.active; });
  if (focusId) board.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus();
}
async function refresh(focusId = null) {
  const previous = state.projects.map(({ key }) => key);
  const [projects, board, activity, questions, actors, devices, roles] = await Promise.all([request('/v1/projects'), request('/v1/board'), request('/v1/events?after=0'), request('/v1/questions'), request('/v1/actors'), request('/v1/devices'), request('/v1/roles')]);
  state.projects = projects.projects; state.tickets = board.tickets; state.events = activity.events; state.questions = questions.questions; state.actors = actors.actors; state.devices = devices.devices; state.roles = roles.roles;
  const identity = actorId() || localStorage.getItem('viq.actor') || ''; $('#actor-select').replaceChildren(new Option('Actor', ''), ...state.actors.map((actor) => new Option(actor.name, actor.id))); $('#actor-select').value = state.actors.some((actor) => actor.id === identity) ? identity : '';
  state.selectedProjects = reconcileProjectSelection(previous, state.projects.map(({ key }) => key), state.selectedProjects, null); if (!previous.length) { state.selectedProjects = new Set(state.projects.map(({ key }) => key)); state.allProjects = true; }
  renderFilters(); renderBoard(focusId); await refreshInbox(); announce(`${visibleTickets().length} tickets shown`);
}
function questionCard(question, { compact = false, afterAnswer = null } = {}) {
  const ticket = state.tickets.find((item) => item.id === question.ticket_id); const article = document.createElement('article'); article.className = `question-card${question.blocking ? ' blocking' : ' non-blocking'}`; article.dataset.question = question.id;
  article.innerHTML = '<small></small><h3></h3><div class="markdown"></div>'; article.querySelector('small').textContent = `${question.kind === 'approval' ? 'Approval' : question.blocking ? 'Blocking question' : 'Non-blocking question'} · ${question.ticket_id}`; article.querySelector('h3').textContent = ticket?.title || question.ticket_id; article.querySelector('.markdown').innerHTML = renderMarkdown(question.text);
  const form = document.createElement('form'); form.className = 'inline-answer'; const requestId = crypto.randomUUID();
  if (question.kind === 'text') form.innerHTML = `<label>Answer<span class="sr-only"> ${question.ticket_id}</span><textarea name="answer" required rows="${compact ? 2 : 3}"></textarea></label><button>Send answer</button>`;
  else form.innerHTML = '<label>Note (optional)<textarea name="note" rows="2"></textarea></label><div class="form-actions"><button name="decision" value="accept">Accept work</button><button class="secondary" name="decision" value="request_changes">Request changes</button></div>';
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); const decision = event.submitter?.value; [...form.elements].forEach((element) => { element.disabled = true; }); await request(`/v1/tickets/${encodeURIComponent(question.ticket_id)}/questions/${encodeURIComponent(question.id)}/answer`, { method: 'POST', body: JSON.stringify({ request_id: requestId, ...(decision ? { decision, note: data.note } : { answer: data.answer }) }) }); await refresh(); announce(decision === 'accept' ? 'Work accepted' : decision === 'request_changes' ? 'Changes requested' : 'Answer sent'); await afterAnswer?.(); }));
  article.append(form); return article;
}
const answerCard = (question) => questionCard(question, { compact: true });
const openAnswer = questionCard; // compatibility name; answers render inline and never open a nested modal

async function refreshInbox() {
  const actor = actorId(); state.inbox = actor ? (await request(`/v1/devices/${encodeURIComponent(actor)}/inbox?after=0`)).questions : [];
  const list = $('#inbox-list');
  if (!actor) { $('#inbox-count').textContent = ''; list.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Choose your name to see questions waiting for you.' })); }
  else if (!state.inbox.length) { $('#inbox-count').textContent = 'All clear'; list.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Nothing needs your answer. New questions will appear here.' })); }
  else { $('#inbox-count').textContent = `${state.inbox.length} ${state.inbox.length === 1 ? 'question needs' : 'questions need'} your answer`; list.replaceChildren(...state.inbox.map(answerCard)); }
}


function requireHuman() { const actor = actorId(); if (!actor) throw new Error('Choose your name first'); return actor; }
async function changeState(id, nextState) { await request(`/v1/tickets/${id}/state`, { method: 'POST', body: JSON.stringify({ actor: requireHuman(), state: nextState }) }); await refresh(); $('#status').textContent = `State changed to ${nextState}`; }
async function ticketAction(id, action) { await request(`/v1/tickets/${id}/${action}`, { method: 'POST', body: JSON.stringify({ actor: requireHuman() }) }); modal.dismiss(); await refresh(); $('#status').textContent = action === 'archive' ? 'Ticket archived' : 'Ticket restored'; }
function assignmentOptions(select, selected) {
  select.append(new Option('Unassigned', ''));
  const actors = document.createElement('optgroup'); actors.label = 'Worker actors'; for (const actor of state.actors.filter((item) => item.active && state.devices.some((device) => device.actor_id === item.id && device.kind === 'worker' && device.status === 'active'))) actors.append(new Option(actor.name, `actor:${actor.id}`)); select.append(actors);
  const roles = document.createElement('optgroup'); roles.label = 'Roles'; for (const role of state.roles) roles.append(new Option(`Role — ${role.name}`, `role:${role.id}`)); select.append(roles);
  select.value = selected ? `${selected.type}:${selected.id}` : '';
}
function projectToggleField(selected = []) { const field = document.createElement('fieldset'); field.className = 'project-toggles chip-row'; field.innerHTML = '<legend>Projects</legend>'; for (const project of state.projects) { const label = document.createElement('label'); label.className = 'filter-chip'; const input = Object.assign(document.createElement('input'), { type: 'checkbox', name: 'projects', value: project.key, checked: selected.includes(project.key) }); label.append(input, document.createTextNode(project.key)); field.append(label); } return field; }
function selectedProjectKeys(form) { return [...form.querySelectorAll('input[name="projects"]:checked')].map((input) => input.value); }
function openEditTicket(ticket, trigger) {
  const form = document.createElement('form'); form.className = 'modal-form edit-ticket-form'; form.innerHTML = '<label>Ticket title<input name="title" required></label><label>Description (Markdown)<textarea name="body" rows="7"></textarea></label><label>Primary project<select name="project" required></select></label><label>Assignee<select name="assignee"></select><small>Assignment controls eligibility; it does not grant or transfer a claim.</small></label><label>State<select name="state"><option value="open">Open</option><option value="review">Review</option><option value="done">Done</option></select></label><button>Save ticket</button>';
  form.elements.title.value = ticket.title; form.elements.body.value = ticket.body; form.elements.title.closest('label').after(projectToggleField(ticket.projects)); form.elements.project.replaceChildren(...state.projects.map((project) => new Option(project.key, project.key))); form.elements.project.value = ticket.project; assignmentOptions(form.elements.assignee, ticket.assignee); form.elements.state.value = ticket.state;
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); const [type, id] = data.assignee.split(':'); await request(`/v1/tickets/${ticket.id}`, { method: 'PATCH', body: JSON.stringify({ actor: requireHuman(), title: data.title, body: data.body, project: data.project, projects: selectedProjectKeys(form), assignee: data.assignee ? { type, id } : null }) }); if (data.state !== ticket.state) await request(`/v1/tickets/${ticket.id}/state`, { method: 'POST', body: JSON.stringify({ actor: requireHuman(), state: data.state }) }); modal.dismiss(); await refresh(data.project); $('#status').textContent = 'Ticket updated'; }));
  openModal({ title: 'Edit ticket', eyebrow: ticket.id, content: form, trigger, initialFocus: form.elements.title });
}
function openProgress(ticket, trigger) {
  const form = document.createElement('form'); form.className = 'modal-form'; form.innerHTML = '<label>Progress (Markdown)<textarea name="message" rows="6" required></textarea></label><button>Add progress</button>';
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); await request(`/v1/tickets/${ticket.id}/notes`, { method: 'POST', body: JSON.stringify({ actor: requireHuman(), message: form.elements.message.value }) }); modal.dismiss(); await refresh(); $('#status').textContent = 'Progress added'; }));
  openModal({ title: 'Add progress', eyebrow: ticket.id, content: form, trigger, initialFocus: form.elements.message });
}
function openQuestion(ticket, trigger) {
  const form = document.createElement('form'); form.className = 'modal-form'; form.innerHTML = '<label>Question (Markdown)<textarea name="text" rows="6" required></textarea></label><label>Ask<select name="target" required></select></label><label><input type="checkbox" name="blocking"> Blocking question</label><button>Ask question</button>';
  const actors = document.createElement('optgroup'); actors.label = 'People and actors'; for (const actor of state.actors) actors.append(new Option(actor.name, `actor:${actor.id}`)); form.elements.target.append(actors); const roles = document.createElement('optgroup'); roles.label = 'Roles'; for (const role of state.roles) roles.append(new Option(role.name, `role:${role.id}`)); form.elements.target.append(roles);
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const [type, id] = form.elements.target.value.split(':'); await request(`/v1/tickets/${ticket.id}/human-questions`, { method: 'POST', body: JSON.stringify({ actor: requireHuman(), responder: { type, id }, text: form.elements.text.value, blocking: form.elements.blocking.checked }) }); modal.dismiss(); await refresh(); $('#status').textContent = 'Question asked'; }));
  openModal({ title: 'Ask question', eyebrow: ticket.id, content: form, trigger, initialFocus: form.elements.text });
}
function openDelete(ticket, trigger) {
  const form = document.createElement('form'); form.className = 'modal-form danger-zone'; form.innerHTML = '<p>Delete removes this ticket from normal views. Its event history remains as a tombstone.</p><label><input type="checkbox" name="confirm" required> Confirm delete</label><button class="danger">Confirm delete</button>';
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); await request(`/v1/tickets/${ticket.id}/delete`, { method: 'POST', body: JSON.stringify({ actor: requireHuman(), confirmed: form.elements.confirm.checked }) }); modal.dismiss(); await refresh(); $('#status').textContent = 'Ticket deleted'; }));
  openModal({ title: 'Delete ticket', eyebrow: ticket.id, content: form, trigger, initialFocus: form.elements.confirm });
}

async function legacyShowDetail(id, trigger) {
  const [{ ticket }, { questions }, { blocks }, { events }] = await Promise.all([request(`/v1/tickets/${id}`), request(`/v1/tickets/${id}/questions`), request(`/v1/tickets/${id}/blocks`), request(`/v1/events?ticket=${id}`)]);
  const content = document.createElement('div'); content.className = 'ticket-detail';
  content.append(markdownElement('div', ticket.body || 'No additional context.', 'detail-body markdown'));
  const facts = document.createElement('dl'); facts.className = 'ticket-facts';
  const fact = (term, value) => { const box = document.createElement('div'); const dt = document.createElement('dt'); const dd = document.createElement('dd'); dt.textContent = term; dd.textContent = value; box.append(dt, dd); return box; };
  facts.append(fact('Project', ticket.project)); if (ticket.assignee) facts.append(fact(ticket.assignee.type === 'role' ? 'Eligible group' : 'Assigned person', assigneeName(ticket.assignee))); if (ticket.unresolved_blockers) facts.append(fact('Open blockers', String(ticket.unresolved_blockers))); if (ticket.claim) facts.append(fact('Worker', actorName(ticket.claim.actor))); facts.append(fact('Status', stateName(ticket))); content.append(facts);
  const controls = document.createElement('div'); controls.className = 'detail-actions';
  if (ticket.archived_at === null) {
    const edit = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Edit ticket' }); edit.addEventListener('click', () => openEditTicket(ticket, edit));
    const progress = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Add progress' }); progress.className = 'secondary'; progress.addEventListener('click', () => openProgress(ticket, progress));
    const question = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Ask question' }); question.className = 'secondary'; question.addEventListener('click', () => openQuestion(ticket, question));
    const archive = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Archive' }); archive.className = 'secondary'; archive.addEventListener('click', safely(async () => ticketAction(ticket.id, 'archive')));
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Delete ticket' }); remove.className = 'danger'; remove.addEventListener('click', () => openDelete(ticket, remove)); controls.append(edit, progress, question, archive, remove);
    for (const block of blocks.filter((item) => item.status === 'open')) { const resolve = Object.assign(document.createElement('button'), { type: 'button', textContent: `Resolve block: ${block.reason}` }); resolve.className = 'secondary resolve-block'; resolve.addEventListener('click', safely(async () => { await request(`/v1/tickets/${ticket.id}/blocks/${encodeURIComponent(block.id)}/resolve`, { method: 'POST', body: '{}' }); modal.dismiss(); await refresh(); $('#status').textContent = 'Block resolved'; })); controls.append(resolve); }
    const stateLabel = document.createElement('label'); stateLabel.textContent = 'State'; const stateSelect = document.createElement('select'); for (const [value, label] of [['open', 'Open'], ['review', 'Review'], ['done', 'Done']]) stateSelect.append(new Option(label, value)); stateSelect.value = ticket.state; stateSelect.addEventListener('change', safely(async () => { await changeState(ticket.id, stateSelect.value); modal.dismiss(); })); stateLabel.append(stateSelect); controls.append(stateLabel);
  } else { const restore = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Restore' }); restore.addEventListener('click', safely(async () => ticketAction(ticket.id, 'restore'))); controls.append(restore); }
  content.append(controls);
  const questionSection = document.createElement('section'); questionSection.className = 'ticket-open-questions'; questionSection.innerHTML = '<h3>Open questions</h3>'; const openQuestions = questions.filter((question) => question.status === 'open'); for (const openQuestion of openQuestions) questionSection.append(questionCard(openQuestion, { afterAnswer: async () => { modal.dismiss(); await showDetail(ticket.id, focusReturn); } })); if (!openQuestions.length) questionSection.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No open questions.' })); content.append(questionSection);
  const timeline = document.createElement('section'); timeline.innerHTML = '<h3>History</h3>'; const list = document.createElement('ol'); list.className = 'event-timeline';
  const questionById = new Map(questions.map((question) => [question.id, question])); const labels = { ticket_created: 'Ticket created', ticket_edited: 'Ticket edited', ticket_moved: 'Project changed', assigned: 'Assignment changed', blocked: 'Blocked', block_resolved: 'Block resolved', claimed: 'Work claimed', released: 'Claim released', progress: 'Progress', question_asked: 'Question asked', question_answered: 'Question answered', submitted: 'Submitted', accepted: 'Approved', changes_requested: 'Changes requested', reopened: 'Reopened', state_changed: 'State changed', archived: 'Archived', restored: 'Restored', deleted: 'Deleted' };
  for (const event of events) {
    const item = document.createElement('li'); item.className = `event event-${event.type}`; const question = questionById.get(event.metadata?.question_id); if (event.type === 'question_asked') item.classList.add('ticket-question');
    const header = document.createElement('div'); header.className = 'event-head'; const name = document.createElement('strong'); name.textContent = labels[event.type] || event.type.replaceAll('_', ' '); const byline = document.createElement('span'); const author = event.actor ? actorName(event.actor) : 'System'; const time = document.createElement('time'); time.dateTime = new Date(event.created_at).toISOString(); time.textContent = new Date(event.created_at).toLocaleString(); byline.textContent = `${author} · `; byline.append(time); header.append(name, byline); item.append(header);
    if (event.message) item.append(markdownElement('div', event.message, 'markdown event-message'));
    if (event.type === 'question_answered' && event.metadata?.question_event_id) item.dataset.questionEvent = String(event.metadata.question_event_id);
    list.append(item);
  }
  timeline.append(list); content.append(timeline); const focusReturn = trigger?.isConnected ? trigger : document.querySelector(`.ticket-card[data-id="${CSS.escape(ticket.id)}"]`); openModal({ title: ticket.title, eyebrow: ticket.id, content, trigger: focusReturn });
}


function eventItem(event) {
  const labels = { ticket_created: 'Ticket created', ticket_edited: 'Ticket edited', manual_event: 'Factual event', progress: 'Factual event', question_asked: 'Question asked', question_answered: 'Question answered', claimed: 'Work claimed', released: 'Claim released', submitted: 'Submitted', accepted: 'Approved', changes_requested: 'Changes requested', reopened: 'Reopened', state_changed: 'State changed', blocked: 'Blocked', block_resolved: 'Block resolved' };
  const item = document.createElement('li'); item.className = `event event-${event.type}`; item.dataset.cursor = event.cursor;
  const head = document.createElement('div'); head.className = 'event-head'; const title = document.createElement('strong'); title.textContent = labels[event.type] || event.type.replaceAll('_', ' ');
  const provenance = document.createElement('span'); const who = event.actor ? actorName(event.actor) : 'System'; provenance.textContent = `${who}${event.actor_role ? ` · ${roleName(event.actor_role)}` : ''}${event.machine ? ` · ${event.machine}` : ''} · `; const time = document.createElement('time'); time.dateTime = new Date(event.created_at).toISOString(); time.textContent = new Date(event.created_at).toLocaleString(); provenance.append(time); head.append(title, provenance); item.append(head);
  if (event.message) item.append(markdownElement('div', event.message, 'markdown event-message')); return item;
}

async function showDetail(id, trigger) {
  const focusReturn = trigger?.isConnected ? trigger : document.querySelector(`.ticket-card[data-id="${CSS.escape(id)}"]`);
  const [{ ticket }, { questions }, { blocks }, history] = await Promise.all([request(`/v1/tickets/${id}`), request(`/v1/tickets/${id}/questions`), request(`/v1/tickets/${id}/blocks`), request(`/v1/tickets/${id}/history?limit=25`)]);
  const content = document.createElement('div'); content.className = 'ticket-detail ticket-detail-editor';
  const identity = document.createElement('dl'); identity.className = 'ticket-facts immutable-facts'; identity.innerHTML = `<div><dt>ID</dt><dd></dd></div><div><dt>Project</dt><dd></dd></div><div><dt>Current state</dt><dd></dd></div>`; [ticket.id, ticket.project, ticket.state].forEach((value, index) => { identity.children[index].querySelector('dd').textContent = value; }); content.append(identity);
  const edit = document.createElement('form'); edit.className = 'modal-form detail-edit-form'; edit.innerHTML = '<label>Title<input name="title" required></label><label>Description (Markdown)<textarea name="description" rows="6"></textarea></label><label>Assignment<select name="assignment"><option>Unassigned</option><option>Human</option><option>Agent</option></select></label><button>Save changes</button>'; edit.elements.title.value = ticket.title; edit.elements.description.value = ticket.description; edit.elements.assignment.value = ticket.assignment;
  edit.addEventListener('submit', safely(async (event) => { event.preventDefault(); await request(`/v1/tickets/${ticket.id}`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(edit))) }); await refresh(); await showDetail(ticket.id, focusReturn); announce('Ticket updated'); })); content.append(edit);
  const openSection = document.createElement('section'); openSection.className = 'ticket-open-questions'; openSection.innerHTML = '<h3>Open questions</h3>'; const openQuestions = questions.filter((question) => question.status === 'open'); for (const question of openQuestions) openSection.append(questionCard(question, { compact: true, afterAnswer: async () => showDetail(ticket.id, focusReturn) })); if (!openQuestions.length) openSection.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No open questions.' })); content.append(openSection);
  const composer = document.createElement('form'); composer.className = 'modal-form manual-event-composer'; composer.innerHTML = '<h3>Add factual event</h3><label>What happened?<textarea name="message" rows="3" required></textarea></label><button>Add event</button>'; composer.addEventListener('submit', safely(async (event) => { event.preventDefault(); await request(`/v1/tickets/${ticket.id}/notes`, { method: 'POST', body: JSON.stringify({ message: composer.elements.message.value }) }); await refresh(); await showDetail(ticket.id, focusReturn); announce('Factual event added'); })); content.append(composer);
  const timeline = document.createElement('section'); timeline.className = 'ticket-history'; timeline.innerHTML = '<h3>Complete history</h3>'; const list = document.createElement('ol'); list.className = 'event-timeline'; history.events.forEach((entry) => list.append(eventItem(entry))); timeline.append(list);
  if (history.has_more) { const more = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary history-more', textContent: 'Load earlier history' }); let before = history.next_before; more.addEventListener('click', safely(async () => { const page = await request(`/v1/tickets/${ticket.id}/history?limit=25&before=${before}`); const fragment = document.createDocumentFragment(); page.events.forEach((entry) => fragment.append(eventItem(entry))); list.prepend(fragment); before = page.next_before; more.hidden = !page.has_more; announce('Earlier history loaded'); })); timeline.append(more); } content.append(timeline);
  for (const block of blocks.filter((item) => item.status === 'open')) { const resolve = Object.assign(document.createElement('button'), { type: 'button', textContent: `Resolve block: ${block.reason}`, className: 'secondary resolve-block' }); resolve.addEventListener('click', safely(async () => { await request(`/v1/tickets/${ticket.id}/blocks/${encodeURIComponent(block.id)}/resolve`, { method: 'POST', body: '{}' }); await refresh(); await showDetail(ticket.id, focusReturn); })); content.append(resolve); }
  const danger = document.createElement('section'); danger.className = 'danger-zone inline-delete'; danger.innerHTML = '<h3>Delete permanently</h3><p>Deletion is non-restorable. The hidden audit tombstone and complete history are retained.</p><button type="button" class="danger reveal-delete">Delete ticket…</button><form hidden><label><input type="checkbox" name="confirm" required> I understand this ticket cannot be restored</label><button class="danger">Confirm permanent delete</button><button type="button" class="secondary cancel-delete">Cancel</button></form>'; const confirm = danger.querySelector('form'); danger.querySelector('.reveal-delete').addEventListener('click', () => { confirm.hidden = false; danger.querySelector('.reveal-delete').hidden = true; confirm.elements.confirm.focus(); }); danger.querySelector('.cancel-delete').addEventListener('click', () => { confirm.hidden = true; danger.querySelector('.reveal-delete').hidden = false; danger.querySelector('.reveal-delete').focus(); }); confirm.addEventListener('submit', safely(async (event) => { event.preventDefault(); await request(`/v1/tickets/${ticket.id}/delete`, { method: 'POST', body: JSON.stringify({ confirmed: confirm.elements.confirm.checked }) }); modal.dismiss(); await refresh(); announce('Ticket permanently deleted'); })); content.append(danger);
  openModal({ title: ticket.title, eyebrow: `${ticket.id} · ${ticket.project} · ${ticket.state}`, content, trigger: focusReturn, initialFocus: edit.elements.title });
}

function openDeviceManagement(trigger) {
  const panel = document.createElement('div'); panel.className = 'device-management';
  const pairing = document.createElement('form'); pairing.className = 'modal-form pairing-code-form'; pairing.innerHTML = '<h3>Issue one-time pairing code</h3><label>Actor<select name="actor" required></select></label><label>Device ID<input name="device_id" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*"></label><label>Device name<input name="device_name" required maxlength="200"></label><label>Device kind<select name="kind"><option value="coordinator">Coordinator</option><option value="worker">Worker</option></select></label><button>Issue code</button><div class="pairing-code-result" aria-live="polite"></div>';  pairing.elements.actor.replaceChildren(...state.actors.filter((actor) => actor.active).map((actor) => new Option(actor.name, actor.id)));
  pairing.addEventListener('submit', safely(async (event) => { event.preventDefault(); const result = pairing.querySelector('.pairing-code-result'); result.replaceChildren(); const issued = await request('/v1/pairing-codes', { method: 'POST', body: JSON.stringify({ intended_kind: pairing.elements.kind.value, actor_id: pairing.elements.actor.value, device_id: pairing.elements.device_id.value, device_name: pairing.elements.device_name.value }) }); const code = document.createElement('output'); code.className = 'one-time-code'; code.textContent = issued.code; const clear = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Clear code' }); clear.className = 'secondary'; clear.addEventListener('click', () => result.replaceChildren()); result.append(code, clear); }));
  const role = document.createElement('form'); role.className = 'modal-form role-create-form'; role.innerHTML = '<h3>Create assignment role</h3><label>Role ID<input name="id" required></label><label>Role name<input name="name" required></label><button>Create role</button>';
  role.addEventListener('submit', safely(async (event) => { event.preventDefault(); await request('/v1/roles', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(role))) }); role.reset(); modal.dismiss(); await refresh(); openDeviceManagement(trigger); $('#status').textContent = 'Role created'; }));
  const membership = document.createElement('form'); membership.className = 'modal-form role-membership-form'; membership.innerHTML = '<h3>Grant or revoke assignment role</h3><label>Paired device<select name="device" required></select></label><label>Role<select name="role" required></select></label><div class="form-actions"><button name="action" value="grant">Grant role</button><button name="action" value="revoke" class="secondary">Revoke role</button></div>';
  membership.elements.device.replaceChildren(new Option('Choose a device', ''), ...state.devices.filter((item) => item.status === 'active').map((item) => new Option(`${item.name} — ${item.kind}`, item.id))); membership.elements.role.replaceChildren(new Option('Choose a role', ''), ...state.roles.map((item) => new Option(item.name, item.id)));
  membership.addEventListener('submit', safely(async (event) => { event.preventDefault(); const action = event.submitter?.value; if (!['grant', 'revoke'].includes(action)) return; await request(`/v1/devices/${encodeURIComponent(membership.elements.device.value)}/roles/${encodeURIComponent(membership.elements.role.value)}`, { method: action === 'grant' ? 'PUT' : 'DELETE', body: '{}' }); modal.dismiss(); await refresh(); openDeviceManagement(trigger); $('#status').textContent = action === 'grant' ? 'Role granted' : 'Role revoked'; }));
  const actorCreate = document.createElement('form'); actorCreate.className = 'modal-form actor-create-form'; actorCreate.innerHTML = '<h3>Create actor</h3><label>ID<input name="id" required></label><label>Name<input name="name" required></label><label>Role<select name="role_id"><option value="">No role</option></select></label><label><input type="checkbox" name="admin"> Admin</label><button>Create actor</button>'; for (const item of state.roles) actorCreate.elements.role_id.append(new Option(item.name, item.id)); actorCreate.addEventListener('submit', safely(async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(actorCreate)); await request('/v1/actors', { method: 'POST', body: JSON.stringify({ ...data, admin: actorCreate.elements.admin.checked, kind: 'agent' }) }); modal.dismiss(); await refresh(); openDeviceManagement(trigger); }));
  const actors = document.createElement('section'); actors.className = 'admin-actors'; actors.innerHTML = '<h3>Actors</h3>'; for (const item of state.actors) { const form = document.createElement('form'); form.className = 'admin-row'; form.innerHTML = '<strong></strong><input name="name"><select name="role_id"><option value="">No role</option></select><label><input type="checkbox" name="admin"> Admin</label><label><input type="checkbox" name="active"> Active</label><button>Save</button>'; form.querySelector('strong').textContent = item.id; form.elements.name.value = item.name; for (const roleItem of state.roles) form.elements.role_id.append(new Option(roleItem.name, roleItem.id)); form.elements.role_id.value = item.role_id ?? ''; form.elements.admin.checked = item.admin; form.elements.active.checked = item.active; form.addEventListener('submit', safely(async (event) => { event.preventDefault(); await request(`/v1/actors/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ name: form.elements.name.value, role_id: form.elements.role_id.value || null, admin: form.elements.admin.checked, active: form.elements.active.checked }) }); modal.dismiss(); await refresh(); openDeviceManagement(trigger); })); actors.append(form); }
  const devices = document.createElement('section'); devices.className = 'admin-devices'; devices.innerHTML = '<h3>Devices</h3>'; for (const item of state.devices) { const form = document.createElement('form'); form.className = 'admin-row'; form.innerHTML = '<strong></strong><input name="name"><select name="actor_id"></select><span></span><button name="action" value="save">Save</button><button name="action" value="revoke" class="danger">Disconnect</button>'; form.querySelector('strong').textContent = item.id; form.querySelector('span').textContent = item.derived_role || 'No role'; for (const actor of state.actors.filter((actor) => actor.active)) form.elements.actor_id.append(new Option(actor.name, actor.id)); form.elements.actor_id.value = item.actor_id; form.elements.name.value = item.name; form.addEventListener('submit', safely(async (event) => { event.preventDefault(); if (event.submitter?.value === 'revoke') await request(`/v1/devices/${encodeURIComponent(item.id)}/revoke`, { method: 'POST', body: '{}' }); else await request(`/v1/devices/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ name: form.elements.name.value, actor_id: form.elements.actor_id.value }) }); modal.dismiss(); await refresh(); openDeviceManagement(trigger); })); devices.append(form); }
  const roleList = document.createElement('section'); roleList.innerHTML = '<h3>Roles</h3>'; for (const item of state.roles) { const button = Object.assign(document.createElement('button'), { type: 'button', textContent: `Delete ${item.name}` }); button.className = 'secondary'; button.addEventListener('click', safely(async () => { await request(`/v1/roles/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); modal.dismiss(); await refresh(); openDeviceManagement(trigger); })); roleList.append(button); }
  panel.append(pairing, actorCreate, actors, devices, role, roleList, membership); openModal({ title: 'Admin', content: panel, trigger, initialFocus: pairing.elements.actor });
}


function openProjectCreate(trigger) {
  const form = document.createElement('form'); form.className = 'modal-form'; form.innerHTML = '<label>Project key<input name="key" required pattern="[A-Za-z][A-Za-z0-9]{1,9}" autocomplete="off"></label><button>Create project</button>';
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const result = await request('/v1/projects', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); modal.dismiss(); await refresh(result.project.key); }));
  openModal({ title: 'Create project', content: form, trigger, initialFocus: form.elements.key });
}

function openTicketCreate(trigger) {
  const form = document.createElement('form'); form.className = 'modal-form'; form.innerHTML = '<label>Project<select name="project" required></select></label><label>Ticket title<input name="title" required></label><label>Description (optional)<textarea name="description" rows="4"></textarea></label><label>Assignment<select name="assignment"><option>Unassigned</option><option>Human</option><option>Agent</option></select></label><button>Create ticket</button>';
  form.elements.project.replaceChildren(new Option('Choose a project', ''), ...state.projects.map(({ key }) => new Option(key, key))); const selected = [...state.selectedProjects]; if (selected.length === 1) form.elements.project.value = selected[0];
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); const result = await request('/v1/tickets', { method: 'POST', body: JSON.stringify(data) }); modal.dismiss(); await refresh(result.ticket.id); }));
  $('#modal-title').textContent = 'Create ticket'; $('#modal-eyebrow').textContent = 'Quick capture'; $('#modal-content').replaceChildren(form); modal.open({ trigger, initialFocus: selected.length === 1 ? form.elements.title : form.elements.project });
}
$('#pairing-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; $('#pairing-status').textContent = 'Pairing…'; try { const response = await fetch('/v1/devices/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }); const body = await response.json(); if (!response.ok) throw new Error(body?.error?.message || 'Pairing failed'); localStorage.setItem(credentialKey, body.credential); const identity = await request('/v1/devices/me'); if (!identity.actor.admin) throw new Error('The board requires an admin actor.'); localStorage.setItem('viq.actor', identity.actor.id); $('#actor-select').replaceChildren(new Option(identity.actor.name, identity.actor.id)); showBoard(); await refresh(); } catch (error) { localStorage.removeItem(credentialKey); showPairing(error.message); } });
$('#disconnect-device').addEventListener('click', () => { localStorage.removeItem(credentialKey); showPairing('This browser is disconnected. The server-side device was not revoked.'); });
$('#refresh').addEventListener('click', safely(async () => refresh())); $('#close-modal').addEventListener('click', () => modal.close());
$('#actor-select').addEventListener('change', safely(async (event) => { localStorage.setItem('viq.actor', event.target.value); await refreshInbox(); }));
$('#open-device-management').addEventListener('click', (event) => openDeviceManagement(event.currentTarget)); $('#open-project-create').addEventListener('click', (event) => openProjectCreate(event.currentTarget)); $('#open-ticket-create').addEventListener('click', (event) => openTicketCreate(event.currentTarget));
$('#reset-filters').addEventListener('click', () => { state.allProjects = true; state.selectedProjects = new Set(state.projects.map(({ key }) => key)); state.selectedRoles.clear(); renderFilters(); renderBoard(); });
$('#state-tabs').addEventListener('click', (event) => { const tab = event.target.closest('[data-tab]'); if (!tab) return; state.active = tab.dataset.tab; renderBoard(); });
addEventListener('resize', () => { if (!$('#modal').open) renderBoard(document.activeElement?.closest?.('.ticket-card')?.dataset.id || null); }); addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.drag) { const previous = state.drag; state.drag = null; announce(`Move cancelled. ${previous.id} remains in ${previous.state}, position ${previous.index + 1}.`); renderBoard(previous.id); } });
(async () => { if (!localStorage.getItem(credentialKey)) return showPairing(); try { const identity = await request('/v1/devices/me'); if (!identity.actor.admin) throw new Error('The board requires an admin actor.'); $('#actor-select').replaceChildren(new Option(identity.actor.name, identity.actor.id)); showBoard(); await refresh(); } catch (error) { report(error); } })();
