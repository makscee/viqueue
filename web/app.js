import { applyTicketFilters, boardColumns, boardProjection, createModalController, dedupeTickets, reconcileProjectSelection, renderMarkdown, selectProject } from './ui-core.js';

const $ = (selector) => document.querySelector(selector);
const state = { projects: [], tickets: [], archived: [], actors: [], devices: [], roles: [], active: 'todo', inbox: [], selectedProjects: new Set(), selectedAssignees: new Set(), allProjects: true };
const columns = boardColumns;
const modalStack = [];
function restoreModal() {
  const previous = modalStack.pop(); if (!previous) return false;
  $('#modal-title').textContent = previous.title; $('#modal-eyebrow').textContent = previous.eyebrow; $('#modal-content').replaceChildren(...previous.content); previous.trigger?.focus(); return true;
}
const modal = createModalController($('#modal'), { requestClose: restoreModal });
$('#modal').addEventListener('close', () => { modalStack.length = 0; });

const credentialKey = 'viq.deviceCredential';
function showPairing(message = '') {
  if ($('#modal').open) modal.dismiss();
  $('#app-shell').hidden = true; $('#refresh').hidden = true; $('#disconnect-device').hidden = true; $('#pairing').hidden = false;
  $('#pairing-form').reset(); $('#pairing-status').textContent = message; $('#pairing-form').elements.code.focus();
}
function showBoard() { $('#pairing').hidden = true; $('#app-shell').hidden = false; $('#refresh').hidden = false; $('#disconnect-device').hidden = false; }
function authenticationError(message) { localStorage.removeItem(credentialKey); showPairing(message); const error = new Error(message); error.authentication = true; return error; }
async function request(path, options = {}) {
  const credential = localStorage.getItem(credentialKey);
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(options.headers || {}) }, ...options });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    if (response.status === 401) throw authenticationError('This device pairing is no longer valid. Pair this browser again.');
    const error = new Error(body?.error?.message || `Request failed (${response.status})`); error.status = response.status; throw error;
  }
  return body;
}
const actorId = () => $('#actor-select').value;
const actorName = (id) => state.actors.find((actor) => actor.id === id)?.name || id;
const roleName = (id) => state.roles.find((role) => role.id === id)?.name || 'Assigned group';
const assigneeName = (assignee) => assignee?.type === 'actor' ? actorName(assignee.id) : assignee?.type === 'role' ? roleName(assignee.id) : 'Unassigned';
const projection = boardProjection;
const stateName = (ticket) => ({ todo: 'To do', working: 'Working', review: 'Review', done: 'Done' })[projection(ticket)];
function report(error) { if (!error.authentication) $('#status').textContent = `Something went wrong: ${error.message}`; }
function safely(handler) { return async (event) => { try { await handler(event); } catch (error) { report(error); } }; }
function markdownElement(tag, text, className = '') { const element = document.createElement(tag); element.className = className; element.innerHTML = renderMarkdown(text); return element; }
function openModal({ title, eyebrow = '', content, trigger, initialFocus }) {
  if ($('#modal').open && trigger?.isConnected) modalStack.push({ title: $('#modal-title').textContent, eyebrow: $('#modal-eyebrow').textContent, content: [...$('#modal-content').childNodes], trigger });
  $('#modal-title').textContent = title; $('#modal-eyebrow').textContent = eyebrow; $('#modal-content').replaceChildren(content);
  modal.open({ trigger, initialFocus });
}

const visibleTickets = () => applyTicketFilters(state.tickets, state.selectedProjects, state.selectedAssignees);
function resetFilters() { state.allProjects = true; state.selectedProjects = new Set(state.projects.map((project) => project.key)); state.selectedAssignees.clear(); renderFilters(); renderBoard(); }
function chip(label, pressed, action) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'filter-chip'; button.textContent = label; button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', action); return button;
}
function renderFilters() {
  const keys = state.projects.map((project) => project.key); const projects = $('#project-chips'); projects.replaceChildren();
  projects.append(chip('All', state.allProjects, () => { state.allProjects = true; state.selectedProjects = new Set(keys); renderFilters(); renderBoard(); }));
  for (const key of keys) {
    const button = chip(key, state.selectedProjects.has(key), () => { state.selectedProjects = selectProject(keys, state.selectedProjects, key); state.allProjects = state.selectedProjects.size === keys.length; renderFilters(); renderBoard(); });
    projects.append(button);
  }
  const assignees = new Map(state.tickets.map((ticket) => [ticket.assignee ? `${ticket.assignee.type}:${ticket.assignee.id}` : 'none', assigneeName(ticket.assignee)]));
  const row = $('#assignee-chips'); row.replaceChildren(chip('All assignees', state.selectedAssignees.size === 0, () => { state.selectedAssignees.clear(); renderFilters(); renderBoard(); }));
  for (const [key, label] of [...assignees].sort((a, b) => a[1].localeCompare(b[1]))) row.append(chip(label, state.selectedAssignees.has(key), () => { state.selectedAssignees.has(key) ? state.selectedAssignees.delete(key) : state.selectedAssignees.add(key); renderFilters(); renderBoard(); }));
}
function renderBoard() {
  const visible = visibleTickets(); const board = $('#board'); board.replaceChildren();
  $('#filter-empty').hidden = visible.length !== 0; $('#status').textContent = `${visible.length} tickets shown`;
  for (const [key, label] of columns) {
    const section = document.createElement('section'); section.className = 'column'; section.dataset.column = key;
    const tickets = visible.filter((ticket) => projection(ticket) === key);
    section.innerHTML = `<h3>${label} <span>${tickets.length}</span></h3>`;
    for (const ticket of tickets) {
      const card = document.createElement('article'); card.className = 'ticket-card'; card.dataset.id = ticket.id; card.tabIndex = 0;
      const summary = document.createElement('button'); summary.type = 'button'; summary.className = 'ticket-open'; summary.innerHTML = '<small></small><strong></strong><span></span>';
      summary.children[0].textContent = ticket.id; summary.children[1].textContent = ticket.title; summary.children[2].textContent = `${assigneeName(ticket.assignee)} · ${stateName(ticket)}`;
      summary.addEventListener('click', safely(async () => showDetail(ticket.id, summary)));
      card.addEventListener('click', safely(async (event) => { if (event.target === card) await showDetail(ticket.id, card); }));
      card.addEventListener('keydown', safely(async (event) => { if (event.target === card && ['Enter', ' '].includes(event.key)) { event.preventDefault(); await showDetail(ticket.id, card); } }));
      card.append(summary);
      { const label = document.createElement('label'); label.textContent = 'State'; const select = document.createElement('select'); select.className = 'card-state'; for (const [value, text] of [['open', 'Open'], ['review', 'Review'], ['done', 'Done']]) select.append(new Option(text, value)); select.value = ticket.state; select.addEventListener('click', (event) => event.stopPropagation()); select.addEventListener('change', safely(async (event) => { event.stopPropagation(); await changeState(ticket.id, event.target.value); })); label.append(select); card.append(label); }
      section.append(card);
    }
    if (!tickets.length) section.insertAdjacentHTML('beforeend', '<p class="empty">Nothing here</p>');
    section.hidden = matchMedia('(max-width:600px)').matches && key !== state.active; board.append(section);
    const tab = document.querySelector(`[data-tab="${key}"] span`); if (tab) tab.textContent = tickets.length;
  }
}

function openAnswer(question, trigger) {
  if (!actorId()) throw new Error('Choose your coordinator device before answering');
  const form = document.createElement('form'); form.className = 'modal-form answer-form'; form.dataset.ticket = question.ticket_id; form.dataset.question = question.id;
  form.append(markdownElement('div', question.text, 'markdown question-markdown'));
  if (question.kind === 'text') form.insertAdjacentHTML('beforeend', '<label>Your answer (Markdown)<textarea name="answer" required rows="5"></textarea></label><button>Send answer</button>');
  else form.insertAdjacentHTML('beforeend', '<label>Note (optional, Markdown)<textarea name="note" rows="4"></textarea></label><div class="form-actions"><button name="decision" value="accept">Accept work</button><button class="secondary" name="decision" value="request_changes">Request changes</button></div>');
  form.addEventListener('submit', safely(async (event) => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(form)); const decision = event.submitter?.value;
    await request(`/v1/tickets/${question.ticket_id}/questions/${question.id}/answer`, { method: 'POST', body: JSON.stringify({ actor: actorId(), ...(decision ? { decision, note: data.note } : { answer: data.answer }) }) });
    modal.dismiss(); await refresh(); $('#status').textContent = decision === 'accept' ? 'Work accepted' : decision === 'request_changes' ? 'Changes requested' : 'Answer sent';
  }));
  openModal({ title: question.kind === 'approval' ? 'Review request' : 'Answer question', eyebrow: question.ticket_id, content: form, trigger, initialFocus: form.querySelector('textarea') });
}

function answerCard(question) {
  const ticket = state.tickets.find((item) => item.id === question.ticket_id);
  const article = document.createElement('article'); article.className = 'question-card'; article.tabIndex = 0; article.setAttribute('role', 'button');
  article.innerHTML = '<small></small><h3></h3><div class="markdown"></div>';
  article.querySelector('small').textContent = question.kind === 'approval' ? 'Review requested' : `Question · ${question.ticket_id}`;
  article.querySelector('h3').textContent = ticket?.title || question.ticket_id; article.querySelector('.markdown').innerHTML = renderMarkdown(question.text);
  article.addEventListener('click', () => openAnswer(question, article));
  article.addEventListener('keydown', (event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); openAnswer(question, article); } });
  return article;
}

async function refreshInbox() {
  const actor = actorId(); state.inbox = actor ? (await request(`/v1/devices/${encodeURIComponent(actor)}/inbox?after=0`)).questions : [];
  const list = $('#inbox-list');
  if (!actor) { $('#inbox-count').textContent = ''; list.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Choose your name to see questions waiting for you.' })); }
  else if (!state.inbox.length) { $('#inbox-count').textContent = 'All clear'; list.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Nothing needs your answer. New questions will appear here.' })); }
  else { $('#inbox-count').textContent = `${state.inbox.length} ${state.inbox.length === 1 ? 'question needs' : 'questions need'} your answer`; list.replaceChildren(...state.inbox.map(answerCard)); }
}

async function refresh(preferred = null) {
  [state.actors, state.devices, state.roles, state.projects] = await Promise.all([request('/v1/actors').then((body) => body.actors), request('/v1/devices').then((body) => body.devices), request('/v1/roles').then((body) => body.roles), request('/v1/projects').then((body) => body.projects)]);
  const identity = actorId() || localStorage.getItem('viq.actor') || '';
  $('#actor-select').replaceChildren(new Option('Actor', ''), ...state.actors.map((actor) => new Option(actor.name, actor.id)));
  $('#actor-select').value = state.actors.some((actor) => actor.id === identity) ? identity : '';
  const keys = state.projects.map((project) => project.key);
  state.selectedProjects = reconcileProjectSelection(keys, state.selectedProjects, state.allProjects);
  if (preferred && !state.allProjects) state.selectedProjects = new Set([preferred]);
  state.tickets = dedupeTickets((await Promise.all(state.projects.map((project) => request(`/v1/projects/${encodeURIComponent(project.key)}/tickets`)))).flatMap((body) => body.tickets));
  state.archived = dedupeTickets((await Promise.all(state.projects.map((project) => request(`/v1/projects/${encodeURIComponent(project.key)}/tickets?include_archived=true`)))).flatMap((body) => body.tickets)).filter((ticket) => ticket.archived_at !== null);
  renderFilters(); renderBoard(); await refreshInbox(); $('#status').textContent = `${visibleTickets().length} tickets shown`;
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
  const form = document.createElement('form'); form.className = 'modal-form'; form.innerHTML = '<label>Question (Markdown)<textarea name="text" rows="6" required></textarea></label><label>Ask<select name="target" required></select></label><button>Ask question</button>';
  const actors = document.createElement('optgroup'); actors.label = 'People and actors'; for (const actor of state.actors) actors.append(new Option(actor.name, `actor:${actor.id}`)); form.elements.target.append(actors); const roles = document.createElement('optgroup'); roles.label = 'Roles'; for (const role of state.roles) roles.append(new Option(role.name, `role:${role.id}`)); form.elements.target.append(roles);
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const [type, id] = form.elements.target.value.split(':'); await request(`/v1/tickets/${ticket.id}/human-questions`, { method: 'POST', body: JSON.stringify({ actor: requireHuman(), responder: { type, id }, text: form.elements.text.value }) }); modal.dismiss(); await refresh(); $('#status').textContent = 'Question asked'; }));
  openModal({ title: 'Ask question', eyebrow: ticket.id, content: form, trigger, initialFocus: form.elements.text });
}
function openDelete(ticket, trigger) {
  const form = document.createElement('form'); form.className = 'modal-form danger-zone'; form.innerHTML = '<p>Delete removes this ticket from normal views. Its event history remains as a tombstone.</p><label><input type="checkbox" name="confirm" required> Confirm delete</label><button class="danger">Confirm delete</button>';
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); await request(`/v1/tickets/${ticket.id}/delete`, { method: 'POST', body: JSON.stringify({ actor: requireHuman(), confirmed: form.elements.confirm.checked }) }); modal.dismiss(); await refresh(); $('#status').textContent = 'Ticket deleted'; }));
  openModal({ title: 'Delete ticket', eyebrow: ticket.id, content: form, trigger, initialFocus: form.elements.confirm });
}

async function showDetail(id, trigger) {
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
  const timeline = document.createElement('section'); timeline.innerHTML = '<h3>History</h3>'; const list = document.createElement('ol'); list.className = 'event-timeline';
  const questionById = new Map(questions.map((question) => [question.id, question])); const labels = { ticket_created: 'Ticket created', ticket_edited: 'Ticket edited', ticket_moved: 'Project changed', assigned: 'Assignment changed', blocked: 'Blocked', block_resolved: 'Block resolved', claimed: 'Work claimed', released: 'Claim released', progress: 'Progress', question_asked: 'Question asked', question_answered: 'Question answered', submitted: 'Submitted', accepted: 'Approved', changes_requested: 'Changes requested', reopened: 'Reopened', state_changed: 'State changed', archived: 'Archived', restored: 'Restored', deleted: 'Deleted' };
  for (const event of events) {
    const item = document.createElement('li'); item.className = `event event-${event.type}`; const question = questionById.get(event.metadata?.question_id); if (event.type === 'question_asked') item.classList.add('ticket-question');
    const header = document.createElement('div'); header.className = 'event-head'; const name = document.createElement('strong'); name.textContent = labels[event.type] || event.type.replaceAll('_', ' '); const byline = document.createElement('span'); const author = event.actor ? actorName(event.actor) : 'System'; const time = document.createElement('time'); time.dateTime = new Date(event.created_at).toISOString(); time.textContent = new Date(event.created_at).toLocaleString(); byline.textContent = `${author} · `; byline.append(time); header.append(name, byline); item.append(header);
    if (event.message) item.append(markdownElement('div', event.message, 'markdown event-message'));
    if (event.type === 'question_asked' && question?.status === 'open') { item.tabIndex = 0; item.setAttribute('role', 'button'); item.addEventListener('click', () => openAnswer(question, item)); item.addEventListener('keydown', (keyEvent) => { if (['Enter', ' '].includes(keyEvent.key)) { keyEvent.preventDefault(); openAnswer(question, item); } }); }
    if (event.type === 'question_answered' && event.metadata?.question_event_id) item.dataset.questionEvent = String(event.metadata.question_event_id);
    list.append(item);
  }
  timeline.append(list); content.append(timeline); openModal({ title: ticket.title, eyebrow: ticket.id, content, trigger });
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
  const form = document.createElement('form'); form.className = 'modal-form'; form.innerHTML = '<label>Primary project<select name="project" required></select></label><label>Ticket title<input name="title" required></label><label>Context (Markdown)<textarea name="body" rows="5"></textarea></label><label>Assignee<select name="assignee"></select><small>Assignment is created atomically with the ticket.</small></label><button>Create ticket</button>'; form.prepend(projectToggleField([...state.selectedProjects]));
  form.elements.project.replaceChildren(new Option('Choose a project', ''), ...state.projects.map((project) => new Option(project.key, project.key))); const exclusive = [...state.selectedProjects]; form.elements.project.value = exclusive.length === 1 ? exclusive[0] : ''; assignmentOptions(form.elements.assignee, null);
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); const [type, id] = data.assignee.split(':'); await request('/v1/tickets', { method: 'POST', body: JSON.stringify({ ...data, projects: selectedProjectKeys(form), actor: requireHuman(), assignee: data.assignee ? { type, id } : null }) }); modal.dismiss(); await refresh(data.project); }));
  openModal({ title: 'Create ticket', content: form, trigger, initialFocus: exclusive.length === 1 ? form.elements.title : form.elements.project });
}

$('#pairing-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; $('#pairing-status').textContent = 'Pairing…';
  try {
    const response = await fetch('/v1/devices/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const text = await response.text(); const body = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(body?.error?.message || `Pairing failed (${response.status})`);
    if (typeof body?.credential !== 'string') throw new Error('Pairing response was incomplete.');
    localStorage.setItem(credentialKey, body.credential); form.reset();
    const { device, actor } = await request('/v1/devices/me');
    if (!actor.admin) throw new Error('The board requires an admin actor.'); localStorage.setItem('viq.actor', actor.id);
    showBoard(); await refresh();
  } catch (error) {
    if (!error.authentication) { localStorage.removeItem(credentialKey); showPairing(error.message); }
  }
});
$('#disconnect-device').addEventListener('click', () => { localStorage.removeItem(credentialKey); showPairing('This browser is disconnected. The server-side device was not revoked.'); });
$('#close-modal').addEventListener('click', () => modal.close());
$('#refresh').addEventListener('click', safely(async () => refresh()));
$('#actor-select').addEventListener('change', safely(async (event) => { localStorage.setItem('viq.actor', event.target.value); await refreshInbox(); }));
$('#reset-filters').addEventListener('click', resetFilters);
$('#state-tabs').addEventListener('click', (event) => { const tab = event.target.closest('[data-tab]'); if (!tab) return; state.active = tab.dataset.tab; document.querySelectorAll('[role=tab]').forEach((item) => item.setAttribute('aria-selected', String(item === tab))); renderBoard(); });
$('#open-questions').addEventListener('click', safely(async (event) => { await refreshInbox(); const panel = document.createElement('div'); panel.className = 'questions-popup'; panel.replaceChildren(...(state.inbox.length ? state.inbox.map(answerCard) : [Object.assign(document.createElement('p'), { textContent: 'No open questions.' })])); openModal({ title: 'Questions', content: panel, trigger: event.currentTarget }); }));
$('#open-archive').addEventListener('click', (event) => { const panel = document.createElement('div'); panel.className = 'archive-popup'; for (const ticket of state.archived) { const row = document.createElement('p'); row.textContent = `${ticket.id} — ${ticket.title} `; const restore = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Restore' }); restore.addEventListener('click', safely(async () => ticketAction(ticket.id, 'restore'))); row.append(restore); panel.append(row); } if (!state.archived.length) panel.textContent = 'Archive is empty.'; openModal({ title: 'Archive', content: panel, trigger: event.currentTarget }); });
$('#open-device-management').addEventListener('click', (event) => openDeviceManagement(event.currentTarget));
$('#open-project-create').addEventListener('click', (event) => openProjectCreate(event.currentTarget));
$('#open-ticket-create').addEventListener('click', (event) => openTicketCreate(event.currentTarget));
(async () => {
  if (!localStorage.getItem(credentialKey)) return showPairing();
  try {
    const { actor } = await request('/v1/devices/me');
    if (!actor.admin) throw authenticationError('The board requires an admin actor.'); localStorage.setItem('viq.actor', actor.id);
    showBoard(); await refresh();
  } catch (error) { if (!error.authentication) report(error); }
})();
