const $ = (selector) => document.querySelector(selector);
const state = { projects: [], project: '', tickets: [], actors: [], roles: [], active: 'ready', inbox: [] };
const columns = [['ready', 'Ready'], ['working', 'Working'], ['review', 'Review'], ['done', 'Done']];

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

function renderBoard() {
  const board = $('#board');
  board.replaceChildren();
  for (const [key, label] of columns) {
    const section = document.createElement('section');
    section.className = 'column';
    section.dataset.column = key;
    const tickets = state.tickets.filter((ticket) => projection(ticket) === key);
    section.innerHTML = `<h3>${label} <span>${tickets.length}</span></h3>`;
    for (const ticket of tickets) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'ticket-card';
      card.dataset.id = ticket.id;
      const person = assigneeName(ticket.assignee);
      card.innerHTML = '<small></small><strong></strong><span></span>';
      card.children[0].textContent = ticket.id;
      card.children[1].textContent = ticket.title;
      card.children[2].textContent = `${person} · ${stateName(ticket)}`;
      card.addEventListener('click', safely(async () => showDetail(ticket.id)));
      section.append(card);
    }
    if (!tickets.length) section.insertAdjacentHTML('beforeend', '<p class="empty">Nothing here</p>');
    section.hidden = matchMedia('(max-width:600px)').matches && key !== state.active;
    board.append(section);
    document.querySelector(`[data-tab="${key}"] span`).textContent = tickets.length;
  }
}

function answerCard(question) {
  const ticket = state.tickets.find((item) => item.id === question.ticket_id);
  const article = document.createElement('article');
  article.className = 'question-card';
  article.innerHTML = '<small></small><h3></h3><p></p>';
  article.querySelector('small').textContent = question.kind === 'approval' ? 'Review requested' : `Question · ${question.ticket_id}`;
  article.querySelector('h3').textContent = ticket?.title || question.ticket_id;
  article.querySelector('p').textContent = question.text;
  const form = document.createElement('form');
  form.className = 'inline-answer';
  form.dataset.ticket = question.ticket_id;
  form.dataset.question = question.id;
  if (question.kind === 'text') form.innerHTML = '<label>Your answer<textarea name="answer" required rows="2"></textarea></label><button>Send answer</button>';
  else form.innerHTML = '<label>Note (optional)<textarea name="note" rows="2"></textarea></label><div><button name="decision" value="accept">Accept work</button><button class="secondary" name="decision" value="request_changes">Request changes</button></div>';
  article.append(form);
  return article;
}

async function refreshInbox() {
  const actor = actorId();
  state.inbox = actor ? (await request(`/v1/actors/${encodeURIComponent(actor)}/inbox?after=0`)).questions : [];
  const list = $('#inbox-list');
  if (!actor) {
    $('#inbox-count').textContent = '';
    list.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Choose your name to see questions waiting for you.' }));
  } else if (!state.inbox.length) {
    $('#inbox-count').textContent = 'All clear';
    list.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Nothing needs your answer. New questions will appear here.' }));
  } else {
    $('#inbox-count').textContent = `${state.inbox.length} ${state.inbox.length === 1 ? 'question needs' : 'questions need'} your answer`;
    list.replaceChildren(...state.inbox.map(answerCard));
  }
}

async function refresh(preferred = state.project) {
  [state.actors, state.roles, state.projects] = await Promise.all([
    request('/v1/actors?active=true').then((body) => body.actors),
    request('/v1/roles').then((body) => body.roles),
    request('/v1/projects').then((body) => body.projects)
  ]);
  const identity = actorId() || localStorage.getItem('viq.actor') || '';
  $('#actor-select').replaceChildren(new Option('Choose your name', ''), ...state.actors.filter((actor) => actor.kind === 'human').map((actor) => new Option(actor.name, actor.id)));
  $('#actor-select').value = state.actors.some((actor) => actor.id === identity && actor.kind === 'human') ? identity : '';
  state.project = preferred || '';
  $('#project-select').replaceChildren(new Option('All projects', ''), ...state.projects.map((project) => new Option(project.key, project.key)));
  $('#project-select').value = state.project;
  if (state.project) state.tickets = (await request(`/v1/projects/${encodeURIComponent(state.project)}/tickets`)).tickets;
  else state.tickets = (await Promise.all(state.projects.map((project) => request(`/v1/projects/${encodeURIComponent(project.key)}/tickets`)))).flatMap((body) => body.tickets);
  renderBoard();
  await refreshInbox();
  $('#status').textContent = `${state.tickets.length} tickets shown`;
}

async function showDetail(id) {
  const [{ ticket }, { questions }, { events }] = await Promise.all([
    request(`/v1/tickets/${id}`), request(`/v1/tickets/${id}/questions`), request(`/v1/events?ticket=${id}`)
  ]);
  $('#detail-id').textContent = ticket.id;
  $('#detail-title').textContent = ticket.title;
  $('#detail-body').textContent = ticket.body || 'No additional context.';
  const assignmentFact = $('#detail-assignment-fact');
  const workerFact = $('#detail-worker-fact');
  const sameActor = ticket.assignee?.type === 'actor' && ticket.claim?.actor === ticket.assignee.id;
  assignmentFact.hidden = sameActor || !ticket.assignee;
  workerFact.hidden = !ticket.claim;
  $('#detail-assignment-label').textContent = ticket.assignee?.type === 'role' ? 'Eligible group' : 'Assigned person';
  $('#detail-assignee').textContent = sameActor ? '' : assigneeName(ticket.assignee);
  $('#detail-worker').textContent = ticket.claim ? actorName(ticket.claim.actor) : '';
  $('#detail-state').textContent = stateName(ticket);
  const meaningful = [...events].reverse().find((event) => event.type === 'progress' && event.message);
  $('#detail-progress').textContent = meaningful?.message || 'No progress update yet.';
  $('#question-note').textContent = ticket.claim && questions.some((question) => question.status === 'open') ? 'Worker continues while questions wait.' : '';
  $('#questions').replaceChildren(...questions.map((question) => {
    const item = document.createElement('li');
    item.className = 'ticket-question';
    const prompt = document.createElement('strong');
    prompt.textContent = question.text;
    const answer = document.createElement('p');
    if (!question.answer) answer.textContent = 'Waiting for an answer';
    else if (question.kind === 'approval') {
      try { const result = JSON.parse(question.answer); answer.textContent = `${result.decision === 'accept' ? 'Accepted' : 'Changes requested'}${result.note ? ` — ${result.note}` : ''}`; }
      catch { answer.textContent = question.answer; }
    } else answer.textContent = `Answered: ${question.answer}`;
    item.append(prompt, answer);
    return item;
  }));
  if (!questions.length) $('#questions').append(Object.assign(document.createElement('li'), { textContent: 'No questions have been asked.' }));
  if (!$('#detail').open) $('#detail').showModal();
}

$('#close-detail').addEventListener('click', () => $('#detail').close());
$('#refresh').addEventListener('click', safely(async () => refresh()));
$('#actor-select').addEventListener('change', safely(async (event) => { localStorage.setItem('viq.actor', event.target.value); await refreshInbox(); }));
$('#project-select').addEventListener('change', safely(async (event) => refresh(event.target.value)));
$('#state-tabs').addEventListener('click', (event) => { const tab = event.target.closest('[data-tab]'); if (!tab) return; state.active = tab.dataset.tab; document.querySelectorAll('[role=tab]').forEach((item) => item.setAttribute('aria-selected', String(item === tab))); renderBoard(); });
$('#inbox-list').addEventListener('submit', safely(async (event) => {
  event.preventDefault(); const form = event.target.closest('.inline-answer'); if (!form) return;
  const data = Object.fromEntries(new FormData(form)); const decision = event.submitter?.value;
  await request(`/v1/tickets/${form.dataset.ticket}/questions/${form.dataset.question}/answer`, { method: 'POST', body: JSON.stringify({ actor: actorId(), ...(decision ? { decision, note: data.note } : { answer: data.answer }) }) });
  await refresh(); $('#status').textContent = decision === 'accept' ? 'Work accepted' : decision === 'request_changes' ? 'Changes requested' : 'Answer sent';
}));
$('#project-form').addEventListener('submit', safely(async (event) => { event.preventDefault(); const result = await request('/v1/projects', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); event.target.reset(); await refresh(result.project.key); }));
$('#ticket-form').addEventListener('submit', safely(async (event) => { event.preventDefault(); if (!state.project) throw new Error('Choose a project before creating a ticket'); await request('/v1/tickets', { method: 'POST', body: JSON.stringify({ project: state.project, title: new FormData(event.target).get('title') }) }); event.target.reset(); await refresh(); }));
refresh().catch(report);
