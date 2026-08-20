import { applyTicketFilters, createModalController, reconcileProjectSelection, renderMarkdown, selectProject } from './ui-core.js';

const $ = (selector) => document.querySelector(selector);
const state = { projects: [], tickets: [], actors: [], roles: [], active: 'waiting', inbox: [], selectedProjects: new Set(), selectedAssignees: new Set(), allProjects: true };
const columns = [['waiting', 'Waiting'], ['ready', 'Ready for agent'], ['working', 'Working'], ['review', 'Review'], ['done', 'Done'], ['archived', 'Archived']];
const modalStack = [];
function restoreModal() {
  const previous = modalStack.pop(); if (!previous) return false;
  $('#modal-title').textContent = previous.title; $('#modal-eyebrow').textContent = previous.eyebrow; $('#modal-content').replaceChildren(...previous.content); previous.trigger?.focus(); return true;
}
const modal = createModalController($('#modal'), { requestClose: restoreModal });
$('#modal').addEventListener('close', () => { modalStack.length = 0; });

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body;
}
const actorId = () => $('#actor-select').value;
const actorName = (id) => state.actors.find((actor) => actor.id === id)?.name || id;
const roleName = (id) => state.roles.find((role) => role.id === id)?.name || 'Assigned group';
const assigneeName = (assignee) => assignee?.type === 'actor' ? actorName(assignee.id) : assignee?.type === 'role' ? roleName(assignee.id) : 'Unassigned';
const projection = (ticket) => ticket.archived_at !== null ? 'archived' : ticket.state === 'open' ? (ticket.claim ? 'working' : ticket.execution_authority && ticket.unresolved_blockers === 0 ? 'ready' : 'waiting') : ticket.state;
const stateName = (ticket) => ({ waiting: 'Waiting — assignment not authorized to launch', ready: 'Ready for agent', working: 'Working', review: 'Awaiting review', done: 'Done', archived: 'Archived' })[projection(ticket)];
function report(error) { $('#status').textContent = `Something went wrong: ${error.message}`; }
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
    const button = chip(key, state.selectedProjects.has(key), () => { state.selectedProjects = selectProject(keys, state.selectedProjects, key, 'exclusive'); state.allProjects = state.selectedProjects.size === keys.length; renderFilters(); renderBoard(); });
    button.classList.toggle('excluded', !state.selectedProjects.has(key));
    button.addEventListener('contextmenu', (event) => { event.preventDefault(); state.selectedProjects = selectProject(keys, state.selectedProjects, key, 'exclude'); state.allProjects = false; renderFilters(); renderBoard(); });
    button.addEventListener('keydown', (event) => { if (event.shiftKey && ['Enter', ' '].includes(event.key)) { event.preventDefault(); state.selectedProjects = selectProject(keys, state.selectedProjects, key, 'exclude'); state.allProjects = false; renderFilters(); renderBoard(); } });
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
      if (ticket.archived_at !== null) { const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'secondary card-action'; restore.textContent = 'Restore'; restore.addEventListener('click', safely(async () => { await ticketAction(ticket.id, 'restore'); })); card.append(restore); }
      else { const label = document.createElement('label'); label.textContent = 'State'; const select = document.createElement('select'); select.className = 'card-state'; for (const [value, text] of [['open', 'Open'], ['review', 'Review'], ['done', 'Done']]) select.append(new Option(text, value)); select.value = ticket.state; select.addEventListener('click', (event) => event.stopPropagation()); select.addEventListener('change', safely(async (event) => { event.stopPropagation(); await changeState(ticket.id, event.target.value); })); label.append(select); card.append(label); }
      section.append(card);
    }
    if (!tickets.length) section.insertAdjacentHTML('beforeend', '<p class="empty">Nothing here</p>');
    section.hidden = matchMedia('(max-width:600px)').matches && key !== state.active; board.append(section);
    document.querySelector(`[data-tab="${key}"] span`).textContent = tickets.length;
  }
}

function openAnswer(question, trigger) {
  if (!actorId()) throw new Error('Choose your name before answering');
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
  const actor = actorId(); state.inbox = actor ? (await request(`/v1/actors/${encodeURIComponent(actor)}/inbox?after=0`)).questions : [];
  const list = $('#inbox-list');
  if (!actor) { $('#inbox-count').textContent = ''; list.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Choose your name to see questions waiting for you.' })); }
  else if (!state.inbox.length) { $('#inbox-count').textContent = 'All clear'; list.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Nothing needs your answer. New questions will appear here.' })); }
  else { $('#inbox-count').textContent = `${state.inbox.length} ${state.inbox.length === 1 ? 'question needs' : 'questions need'} your answer`; list.replaceChildren(...state.inbox.map(answerCard)); }
}

async function refresh(preferred = null) {
  [state.actors, state.roles, state.projects] = await Promise.all([request('/v1/actors?active=true').then((body) => body.actors), request('/v1/roles').then((body) => body.roles), request('/v1/projects').then((body) => body.projects)]);
  const identity = actorId() || localStorage.getItem('viq.actor') || '';
  $('#actor-select').replaceChildren(new Option('Choose your name', ''), ...state.actors.filter((actor) => actor.kind === 'human').map((actor) => new Option(actor.name, actor.id)));
  $('#actor-select').value = state.actors.some((actor) => actor.id === identity && actor.kind === 'human') ? identity : '';
  const keys = state.projects.map((project) => project.key);
  state.selectedProjects = reconcileProjectSelection(keys, state.selectedProjects, state.allProjects);
  if (preferred && !state.allProjects) state.selectedProjects = new Set([preferred]);
  state.tickets = (await Promise.all(state.projects.map((project) => request(`/v1/projects/${encodeURIComponent(project.key)}/tickets?include_archived=true`)))).flatMap((body) => body.tickets);
  renderFilters(); renderBoard(); await refreshInbox(); $('#status').textContent = `${visibleTickets().length} tickets shown`;
}

function requireHuman() { const actor = actorId(); if (!actor) throw new Error('Choose your name first'); return actor; }
async function changeState(id, nextState) { await request(`/v1/tickets/${id}/state`, { method: 'POST', body: JSON.stringify({ actor: requireHuman(), state: nextState }) }); await refresh(); $('#status').textContent = `State changed to ${nextState}`; }
async function ticketAction(id, action) { await request(`/v1/tickets/${id}/${action}`, { method: 'POST', body: JSON.stringify({ actor: requireHuman() }) }); modal.dismiss(); await refresh(); $('#status').textContent = action === 'archive' ? 'Ticket archived' : 'Ticket restored'; }
function assignmentOptions(select, selected) {
  select.append(new Option('Unassigned', ''));
  const actors = document.createElement('optgroup'); actors.label = 'Actors / workers'; for (const actor of state.actors) actors.append(new Option(`Actor — ${actor.name}`, `actor:${actor.id}`)); select.append(actors);
  const roles = document.createElement('optgroup'); roles.label = 'Roles'; for (const role of state.roles) roles.append(new Option(`Role — ${role.name}`, `role:${role.id}`)); select.append(roles);
  select.value = selected ? `${selected.type}:${selected.id}` : '';
}
function openEditTicket(ticket, trigger) {
  const form = document.createElement('form'); form.className = 'modal-form edit-ticket-form'; form.innerHTML = '<label>Ticket title<input name="title" required></label><label>Description (Markdown)<textarea name="body" rows="7"></textarea></label><label>Project<select name="project" required></select></label><label>Assignee<select name="assignee"></select><small>Assignment controls eligibility; it does not grant or transfer a claim.</small></label><label>State<select name="state"><option value="open">Open</option><option value="review">Review</option><option value="done">Done</option></select></label><button>Save ticket</button>';
  form.elements.title.value = ticket.title; form.elements.body.value = ticket.body; form.elements.project.replaceChildren(...state.projects.map((project) => new Option(project.key, project.key))); form.elements.project.value = ticket.project; assignmentOptions(form.elements.assignee, ticket.assignee); form.elements.state.value = ticket.state;
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); const [type, id] = data.assignee.split(':'); await request(`/v1/tickets/${ticket.id}`, { method: 'PATCH', body: JSON.stringify({ actor: requireHuman(), title: data.title, body: data.body, project: data.project, assignee: data.assignee ? { type, id } : null }) }); if (data.state !== ticket.state) await request(`/v1/tickets/${ticket.id}/state`, { method: 'POST', body: JSON.stringify({ actor: requireHuman(), state: data.state }) }); modal.dismiss(); await refresh(data.project); $('#status').textContent = 'Ticket updated'; }));
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
  const [{ ticket }, { questions }, { events }] = await Promise.all([request(`/v1/tickets/${id}`), request(`/v1/tickets/${id}/questions`), request(`/v1/events?ticket=${id}`)]);
  const content = document.createElement('div'); content.className = 'ticket-detail';
  content.append(markdownElement('div', ticket.body || 'No additional context.', 'detail-body markdown'));
  const facts = document.createElement('dl'); facts.className = 'ticket-facts';
  const fact = (term, value) => { const box = document.createElement('div'); const dt = document.createElement('dt'); const dd = document.createElement('dd'); dt.textContent = term; dd.textContent = value; box.append(dt, dd); return box; };
  facts.append(fact('Project', ticket.project)); if (ticket.assignee) facts.append(fact(ticket.assignee.type === 'role' ? 'Eligible group' : 'Assigned person', assigneeName(ticket.assignee))); if (ticket.execution_authority) facts.append(fact('Launch authority', `Trusted assignment by ${actorName(ticket.execution_authority.granted_by)}`)); if (ticket.unresolved_blockers) facts.append(fact('Open blockers', String(ticket.unresolved_blockers))); if (ticket.claim) facts.append(fact('Worker', actorName(ticket.claim.actor))); facts.append(fact('Status', stateName(ticket))); content.append(facts);
  const controls = document.createElement('div'); controls.className = 'detail-actions';
  if (ticket.archived_at === null) {
    const edit = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Edit ticket' }); edit.addEventListener('click', () => openEditTicket(ticket, edit));
    const progress = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Add progress' }); progress.className = 'secondary'; progress.addEventListener('click', () => openProgress(ticket, progress));
    const question = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Ask question' }); question.className = 'secondary'; question.addEventListener('click', () => openQuestion(ticket, question));
    const archive = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Archive' }); archive.className = 'secondary'; archive.addEventListener('click', safely(async () => ticketAction(ticket.id, 'archive')));
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Delete ticket' }); remove.className = 'danger'; remove.addEventListener('click', () => openDelete(ticket, remove)); controls.append(edit, progress, question, archive, remove);
    const stateLabel = document.createElement('label'); stateLabel.textContent = 'State'; const stateSelect = document.createElement('select'); for (const [value, label] of [['open', 'Open'], ['review', 'Review'], ['done', 'Done']]) stateSelect.append(new Option(label, value)); stateSelect.value = ticket.state; stateSelect.addEventListener('change', safely(async () => { await changeState(ticket.id, stateSelect.value); modal.dismiss(); })); stateLabel.append(stateSelect); controls.append(stateLabel);
  } else { const restore = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Restore' }); restore.addEventListener('click', safely(async () => ticketAction(ticket.id, 'restore'))); controls.append(restore); }
  content.append(controls);
  const timeline = document.createElement('section'); timeline.innerHTML = '<h3>History</h3>'; const list = document.createElement('ol'); list.className = 'event-timeline';
  const questionById = new Map(questions.map((question) => [question.id, question])); const labels = { ticket_created: 'Ticket created', ticket_edited: 'Ticket edited', ticket_moved: 'Project changed', assigned: 'Assignment changed', execution_authority_granted: 'Trusted assignment authorized execution', execution_authority_revoked: 'Execution authority revoked', execution_authority_consumed: 'Execution authority consumed', blocked: 'Blocked', block_resolved: 'Block resolved', claimed: 'Work claimed', released: 'Claim released', progress: 'Progress', question_asked: 'Question asked', question_answered: 'Question answered', submitted: 'Submitted', accepted: 'Approved', changes_requested: 'Changes requested', reopened: 'Reopened', state_changed: 'State changed', archived: 'Archived', restored: 'Restored', deleted: 'Deleted' };
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

function openProjectCreate(trigger) {
  const form = document.createElement('form'); form.className = 'modal-form'; form.innerHTML = '<label>Project key<input name="key" required pattern="[A-Za-z][A-Za-z0-9]{1,9}" autocomplete="off"></label><button>Create project</button>';
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const result = await request('/v1/projects', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); modal.dismiss(); await refresh(result.project.key); }));
  openModal({ title: 'Create project', content: form, trigger, initialFocus: form.elements.key });
}
function openTicketCreate(trigger) {
  const form = document.createElement('form'); form.className = 'modal-form'; form.innerHTML = '<label>Project<select name="project" required></select></label><label>Ticket title<input name="title" required></label><label>Context (Markdown)<textarea name="body" rows="5"></textarea></label><button>Create ticket</button>';
  form.elements.project.replaceChildren(new Option('Choose a project', ''), ...state.projects.map((project) => new Option(project.key, project.key))); const exclusive = [...state.selectedProjects]; form.elements.project.value = exclusive.length === 1 ? exclusive[0] : '';
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); await request('/v1/tickets', { method: 'POST', body: JSON.stringify({ ...data, actor: requireHuman() }) }); modal.dismiss(); await refresh(data.project); }));
  openModal({ title: 'Create ticket', content: form, trigger, initialFocus: exclusive.length === 1 ? form.elements.title : form.elements.project });
}

$('#close-modal').addEventListener('click', () => modal.close());
$('#refresh').addEventListener('click', safely(async () => refresh()));
$('#actor-select').addEventListener('change', safely(async (event) => { localStorage.setItem('viq.actor', event.target.value); await refreshInbox(); }));
$('#reset-filters').addEventListener('click', resetFilters);
$('#state-tabs').addEventListener('click', (event) => { const tab = event.target.closest('[data-tab]'); if (!tab) return; state.active = tab.dataset.tab; document.querySelectorAll('[role=tab]').forEach((item) => item.setAttribute('aria-selected', String(item === tab))); renderBoard(); });
$('#open-project-create').addEventListener('click', (event) => openProjectCreate(event.currentTarget));
$('#open-ticket-create').addEventListener('click', (event) => openTicketCreate(event.currentTarget));
refresh().catch(report);
