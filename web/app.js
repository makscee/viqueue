const $ = (selector) => document.querySelector(selector);
const state = { projects: [], selected: '', tickets: [], activeState: 'ready', refreshing: false };
const pollIntervalMs = 5_000;
const narrowBoard = matchMedia('(max-width: 560px)');
const columns = [
  ['ready', 'Ready'], ['claimed', 'Claimed'], ['stale', 'Stale / uncertain'], ['submitted', 'Submitted']
];

function status(message, error = false) {
  const target = $('#status'); target.textContent = message; target.classList.toggle('error', error);
}

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }, ...options });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  return body;
}

const formatTime = (value) => value ? new Date(value).toLocaleString() : '—';
const text = (tag, content, className) => {
  const element = document.createElement(tag); element.textContent = content;
  if (className) element.className = className;
  return element;
};

function card(ticket) {
  const button = text('button', '', `card state-${ticket.state}`); button.type = 'button';
  button.dataset.ticketId = ticket.id; button.setAttribute('aria-label', `Open ${ticket.id}: ${ticket.title}`);
  button.append(text('span', ticket.id, 'card-id'), text('span', ticket.title, 'card-title'));
  const meta = text('span', '', 'meta');
  if (ticket.claim) {
    meta.append(text('span', `Owner: ${ticket.claim.actor}`), text('span', `Generation ${ticket.claim.generation}`),
      text('span', `${ticket.state === 'stale' ? 'Expired' : 'Expires'}: ${formatTime(ticket.claim.expires_at)}`));
  }
  if (ticket.state === 'stale') meta.append(text('span', 'Unavailable — explicit takeover only'));
  if (ticket.state === 'submitted') meta.append(text('span', ticket.evidence == null ? 'No evidence' : 'Evidence attached'));
  button.append(meta); return button;
}

function selectState(key, { focus = false } = {}) {
  state.activeState = key;
  for (const tab of document.querySelectorAll('[data-state-tab]')) {
    const selected = tab.dataset.stateTab === key;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  for (const column of document.querySelectorAll('.column')) column.hidden = narrowBoard.matches && column.dataset.state !== key;
}

function render() {
  const board = $('#board'); board.replaceChildren();
  for (const [key, label] of columns) {
    const section = text('section', '', `column state-${key}`); section.dataset.state = key;
    const tickets = state.tickets.filter((ticket) => ticket.state === key);
    const heading = text('h2', ''); heading.append(text('span', label), text('span', String(tickets.length), 'count'));
    const cards = text('div', '', 'cards');
    if (!tickets.length) cards.append(text('p', 'No tickets', 'empty'));
    else for (const ticket of tickets) cards.append(card(ticket));
    section.setAttribute('role', 'tabpanel'); section.setAttribute('aria-label', `${label} tickets`);
    section.append(heading, cards); board.append(section);
    $(`[data-count="${key}"]`).textContent = String(tickets.length);
  }
  selectState(state.activeState);
}

async function loadProjects(preferred) {
  state.projects = (await request('/v1/projects')).projects;
  const select = $('#project-select'); select.replaceChildren();
  if (!state.projects.length) select.append(new Option('No projects yet', ''));
  else for (const project of state.projects) select.append(new Option(project.key, project.key));
  const candidate = preferred ?? state.selected;
  state.selected = state.projects.some(({ key }) => key === candidate) ? candidate : (state.projects[0]?.key ?? '');
  select.value = state.selected; $('#ticket-project').textContent = state.selected || 'no project';
  $('#create-ticket').disabled = !state.selected;
}

async function refresh(preferred, { quiet = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    await loadProjects(preferred);
    state.tickets = state.selected ? (await request(`/v1/projects/${encodeURIComponent(state.selected)}/tickets`)).tickets : [];
    render();
    $('#freshness').textContent = `Updated ${new Date().toLocaleTimeString()} · auto-refresh 5s`;
    if (!quiet) status(state.selected ? `${state.selected} refreshed` : 'Create a project to begin');
  } catch (error) { status(error.message, true); }
  finally { state.refreshing = false; }
}

function showDetail(ticket) {
  $('#detail-title').textContent = `${ticket.id} · ${ticket.state}`;
  const body = $('#detail-body'); body.replaceChildren();
  const list = text('dl', '', 'detail-grid');
  const rows = [['Title', ticket.title], ['Project', ticket.project], ['State', ticket.state],
    ['Actor', ticket.claim?.actor ?? '—'], ['Generation', ticket.claim?.generation ?? '—'],
    ['Expiry', formatTime(ticket.claim?.expires_at)]];
  for (const [key, value] of rows) list.append(text('dt', key), text('dd', String(value)));
  body.append(list);
  if (ticket.evidence != null) body.append(text('h3', 'Evidence'), text('pre', typeof ticket.evidence === 'string' ? ticket.evidence : JSON.stringify(ticket.evidence, null, 2), 'evidence'));
  if (ticket.state === 'stale') {
    const takeover = text('button', 'Take over stale claim', 'danger'); takeover.type = 'button'; takeover.dataset.takeoverId = ticket.id;
    body.append(takeover);
  }
  $('#detail').showModal();
}

$('#board').addEventListener('click', (event) => {
  const target = event.target.closest('[data-ticket-id]');
  if (target) showDetail(state.tickets.find(({ id }) => id === target.dataset.ticketId));
});

document.addEventListener('click', (event) => {
  if (event.target.matches('[data-close]')) event.target.closest('dialog').close();
  const takeover = event.target.closest('[data-takeover-id]');
  if (takeover) {
    $('#detail').close(); $('#takeover-form').elements.id.value = takeover.dataset.takeoverId;
    $('#takeover-id').textContent = takeover.dataset.takeoverId; $('#takeover').showModal();
  }
});

narrowBoard.addEventListener('change', () => selectState(state.activeState));
$('#state-tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-state-tab]'); if (tab) selectState(tab.dataset.stateTab);
});
$('#state-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('[data-state-tab]')]; let index = tabs.indexOf(document.activeElement);
  if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = tabs.length - 1;
  else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault(); selectState(tabs[index].dataset.stateTab, { focus: true });
});
$('#refresh').addEventListener('click', () => refresh());
$('#project-select').addEventListener('change', (event) => refresh(event.target.value));
$('#project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { const body = await request('/v1/projects', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); event.target.reset(); await refresh(body.project.key); }
  catch (error) { status(error.message, true); }
});
$('#ticket-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await request('/v1/tickets', { method: 'POST', body: JSON.stringify({ project: state.selected, title: new FormData(event.target).get('title') }) }); event.target.reset(); await refresh(); }
  catch (error) { status(error.message, true); }
});
$('#takeover-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
  try {
    await request(`/v1/tickets/${encodeURIComponent(data.id)}/takeover`, {
      method: 'POST', headers: { authorization: `Bearer ${data.authorization}` },
      body: JSON.stringify({ actor: data.actor, ttl_ms: Number(data.ttl_ms) })
    });
    event.target.reset(); $('#takeover').close(); await refresh();
  } catch (error) { status(error.message, true); }
});

refresh();
setInterval(() => {
  const editing = document.activeElement?.matches('input, select, textarea') || document.querySelector('dialog[open]');
  if (!editing && document.visibilityState === 'visible') refresh(undefined, { quiet: true });
}, pollIntervalMs);
