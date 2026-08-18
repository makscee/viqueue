import { applyTicketFilters, createModalController, renderMarkdown, selectProject } from './ui-core.js';

const $ = (selector) => document.querySelector(selector);
const state = { projects: [], tickets: [], actors: [], roles: [], active: 'ready', inbox: [], selectedProjects: new Set(), selectedAssignees: new Set(), filtersReady: false };
const columns = [['ready', 'Ready'], ['working', 'Working'], ['review', 'Review'], ['done', 'Done']];
const modal = createModalController($('#modal'));

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
const projection = (ticket) => ticket.state === 'open' ? (ticket.claim ? 'working' : 'ready') : ticket.state;
const stateName = (ticket) => ({ ready: 'Ready', working: 'Working', review: 'Awaiting review', done: 'Done' })[projection(ticket)];
function report(error) { $('#status').textContent = `Something went wrong: ${error.message}`; }
function safely(handler) { return async (event) => { try { await handler(event); } catch (error) { report(error); } }; }
function markdownElement(tag, text, className = '') { const element = document.createElement(tag); element.className = className; element.innerHTML = renderMarkdown(text); return element; }
function openModal({ title, eyebrow = '', content, trigger, initialFocus }) {
  $('#modal-title').textContent = title;
  $('#modal-eyebrow').textContent = eyebrow;
  $('#modal-content').replaceChildren(content);
  modal.open({ trigger, initialFocus });
}

const visibleTickets = () => applyTicketFilters(state.tickets, state.selectedProjects, state.selectedAssignees);
function resetFilters() { state.selectedProjects = new Set(state.projects.map((project) => project.key)); state.selectedAssignees.clear(); renderFilters(); renderBoard(); }
function chip(label, pressed, action) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'filter-chip'; button.textContent = label; button.setAttribute('aria-pressed', String(pressed));
  button.addEventListener('click', action); return button;
}
function renderFilters() {
  const keys = state.projects.map((project) => project.key); const projects = $('#project-chips'); projects.replaceChildren();
  projects.append(chip('All', state.selectedProjects.size === keys.length, () => { state.selectedProjects = new Set(keys); renderFilters(); renderBoard(); }));
  for (const key of keys) {
    const button = chip(key, state.selectedProjects.has(key), () => { state.selectedProjects = selectProject(keys, state.selectedProjects, key, 'exclusive'); renderFilters(); renderBoard(); });
    button.classList.toggle('excluded', !state.selectedProjects.has(key));
    button.addEventListener('contextmenu', (event) => { event.preventDefault(); state.selectedProjects = selectProject(keys, state.selectedProjects, key, 'exclude'); renderFilters(); renderBoard(); });
    button.addEventListener('keydown', (event) => { if (event.shiftKey && ['Enter', ' '].includes(event.key)) { event.preventDefault(); state.selectedProjects = selectProject(keys, state.selectedProjects, key, 'exclude'); renderFilters(); renderBoard(); } });
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
      const card = document.createElement('button'); card.type = 'button'; card.className = 'ticket-card'; card.dataset.id = ticket.id;
      card.innerHTML = '<small></small><strong></strong><span></span>';
      card.children[0].textContent = ticket.id; card.children[1].textContent = ticket.title; card.children[2].textContent = `${assigneeName(ticket.assignee)} · ${stateName(ticket)}`;
      card.addEventListener('click', safely(async () => showDetail(ticket.id, card))); section.append(card);
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
    modal.close(); await refresh(); $('#status').textContent = decision === 'accept' ? 'Work accepted' : decision === 'request_changes' ? 'Changes requested' : 'Answer sent';
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
  if (!state.filtersReady) { state.selectedProjects = new Set(keys); state.filtersReady = true; }
  else state.selectedProjects = new Set([...state.selectedProjects].filter((key) => keys.includes(key)));
  if (preferred) state.selectedProjects = new Set([preferred]);
  state.tickets = (await Promise.all(state.projects.map((project) => request(`/v1/projects/${encodeURIComponent(project.key)}/tickets`)))).flatMap((body) => body.tickets);
  renderFilters(); renderBoard(); await refreshInbox(); $('#status').textContent = `${visibleTickets().length} tickets shown`;
}

async function showDetail(id, trigger) {
  const [{ ticket }, { questions }, { events }] = await Promise.all([request(`/v1/tickets/${id}`), request(`/v1/tickets/${id}/questions`), request(`/v1/events?ticket=${id}`)]);
  const content = document.createElement('div'); content.className = 'ticket-detail';
  content.append(markdownElement('div', ticket.body || 'No additional context.', 'detail-body markdown'));
  const facts = document.createElement('dl'); facts.className = 'ticket-facts';
  const fact = (term, value) => { const box = document.createElement('div'); const dt = document.createElement('dt'); const dd = document.createElement('dd'); dt.textContent = term; dd.textContent = value; box.append(dt, dd); return box; };
  if (ticket.assignee) facts.append(fact(ticket.assignee.type === 'role' ? 'Eligible group' : 'Assigned person', assigneeName(ticket.assignee)));
  if (ticket.claim) facts.append(fact('Worker', actorName(ticket.claim.actor)));
  facts.append(fact('Status', stateName(ticket))); content.append(facts);
  const timeline = document.createElement('section'); timeline.innerHTML = '<h3>History</h3>'; const list = document.createElement('ol'); list.className = 'detail-questions';
  const questionByEvent = new Map(questions.map((question) => [question.id, question]));
  for (const event of events) {
    const question = questionByEvent.get(event.metadata?.question_id);
    if (!question || event.type !== 'question_asked') continue;
    const item = document.createElement('li'); item.className = 'ticket-question'; item.tabIndex = question.status === 'open' ? 0 : -1;
    item.append(markdownElement('strong', question.text, 'markdown'));
    const answer = document.createElement('div'); answer.className = 'markdown muted';
    if (!question.answer) answer.textContent = 'Waiting for an answer'; else if (question.kind === 'approval') { try { const result = JSON.parse(question.answer); answer.innerHTML = renderMarkdown(`${result.decision === 'accept' ? 'Accepted' : 'Changes requested'}${result.note ? ` — ${result.note}` : ''}`); } catch { answer.innerHTML = renderMarkdown(question.answer); } } else answer.innerHTML = renderMarkdown(`Answered: ${question.answer}`);
    item.append(answer);
    if (question.status === 'open') { item.setAttribute('role', 'button'); item.addEventListener('click', () => openAnswer(question, item)); item.addEventListener('keydown', (event) => { if (['Enter', ' '].includes(event.key)) openAnswer(question, item); }); }
    list.append(item);
  }
  if (!list.children.length) list.append(Object.assign(document.createElement('li'), { textContent: 'No questions have been asked.' })); timeline.append(list); content.append(timeline);
  openModal({ title: ticket.title, eyebrow: ticket.id, content, trigger });
}

function openProjectCreate(trigger) {
  const form = document.createElement('form'); form.className = 'modal-form'; form.innerHTML = '<label>Project key<input name="key" required pattern="[A-Za-z][A-Za-z0-9]{1,9}" autocomplete="off"></label><button>Create project</button>';
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const result = await request('/v1/projects', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); modal.close(); await refresh(result.project.key); }));
  openModal({ title: 'Create project', content: form, trigger, initialFocus: form.elements.key });
}
function openTicketCreate(trigger) {
  const form = document.createElement('form'); form.className = 'modal-form'; form.innerHTML = '<label>Project<select name="project" required></select></label><label>Ticket title<input name="title" required></label><label>Context (Markdown)<textarea name="body" rows="5"></textarea></label><button>Create ticket</button>';
  form.elements.project.replaceChildren(new Option('Choose a project', ''), ...state.projects.map((project) => new Option(project.key, project.key))); const exclusive = [...state.selectedProjects]; form.elements.project.value = exclusive.length === 1 ? exclusive[0] : '';
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); await request('/v1/tickets', { method: 'POST', body: JSON.stringify(data) }); modal.close(); await refresh(data.project); }));
  openModal({ title: 'Create ticket', content: form, trigger, initialFocus: state.project ? form.elements.title : form.elements.project });
}

$('#close-modal').addEventListener('click', () => modal.close());
$('#refresh').addEventListener('click', safely(async () => refresh()));
$('#actor-select').addEventListener('change', safely(async (event) => { localStorage.setItem('viq.actor', event.target.value); await refreshInbox(); }));
$('#reset-filters').addEventListener('click', resetFilters);
$('#state-tabs').addEventListener('click', (event) => { const tab = event.target.closest('[data-tab]'); if (!tab) return; state.active = tab.dataset.tab; document.querySelectorAll('[role=tab]').forEach((item) => item.setAttribute('aria-selected', String(item === tab))); renderBoard(); });
$('#open-project-create').addEventListener('click', (event) => openProjectCreate(event.currentTarget));
$('#open-ticket-create').addEventListener('click', (event) => openTicketCreate(event.currentTarget));
refresh().catch(report);
