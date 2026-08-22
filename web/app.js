import { applyTicketFilters, createModalController, reconcileProjectSelection } from './ui-core.js';

const $ = (selector) => document.querySelector(selector);
const credentialKey = 'viq.deviceCredential';
const lanes = ['Open', 'Working', 'Waiting', 'Done'];
const state = { projects: [], tickets: [], events: [], selectedProjects: new Set(), selectedRoles: new Set(), allProjects: true, active: 'Activity', drag: null };
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
function filteredEvents(visible) { const ids = new Set(visible.map(({ id }) => id)); return state.events.filter((event) => !event.ticket_id || ids.has(event.ticket_id)).toReversed(); }
function announce(message) { $('#status').textContent = message; }
function openTicket(ticket, trigger) {
  const content = document.createElement('div'); content.className = 'ticket-summary';
  const description = document.createElement('p'); description.textContent = ticket.description || 'No description.';
  const facts = document.createElement('dl'); facts.innerHTML = `<div><dt>Project</dt><dd>${ticket.project}</dd></div><div><dt>Assignment</dt><dd>${ticket.assignment}</dd></div><div><dt>State</dt><dd>${ticket.state}</dd></div>`;
  content.append(description, facts); $('#modal-title').textContent = ticket.title; $('#modal-eyebrow').textContent = ticket.id; $('#modal-content').replaceChildren(content); modal.open({ trigger });
}
function cardFor(ticket, laneTickets, index) {
  const card = document.createElement('article'); card.className = 'ticket-card'; card.dataset.id = ticket.id; card.draggable = ticket.assignment === 'Human'; card.tabIndex = 0;
  card.setAttribute('aria-label', `${ticket.id}, ${ticket.title}, ${ticket.assignment}, ${ticket.state}, position ${index + 1} of ${laneTickets.length}`);
  card.innerHTML = '<small></small><strong></strong><span class="card-meta"></span>';
  card.children[0].textContent = ticket.id; card.children[1].textContent = ticket.title;
  card.children[2].textContent = `${ticket.assignment}${ticket.open_questions ? ` · ${ticket.open_questions} open question${ticket.open_questions === 1 ? '' : 's'}` : ''}${ticket.claim?.device_id ? ` · active on ${ticket.claim.device_id}` : ''}`;
  card.addEventListener('click', () => openTicket(ticket, card));
  card.addEventListener('dragstart', (event) => { state.drag = { id: ticket.id, state: ticket.state, index }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', ticket.id); card.classList.add('dragging'); announce(`Moving ${ticket.id}. Drop in a lane, or press Escape to cancel.`); });
  card.addEventListener('dragend', () => { card.classList.remove('dragging'); if (state.drag) announce(`Move cancelled. ${ticket.id} remains in ${state.drag.state}, position ${state.drag.index + 1}.`); state.drag = null; document.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target')); });
  card.addEventListener('keydown', safely(async (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTicket(ticket, card); return; }
    if (event.key === 'Escape' && state.drag) { event.preventDefault(); state.drag = null; announce(`Move cancelled. ${ticket.id} remains in ${ticket.state}, position ${index + 1}.`); return; }
    if (ticket.assignment !== 'Human' || !event.altKey || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
    event.preventDefault(); let nextState = ticket.state; let nextIndex = index;
    if (event.key === 'ArrowUp') nextIndex = Math.max(0, index - 1); if (event.key === 'ArrowDown') nextIndex = Math.min(laneTickets.length - 1, index + 1);
    if (event.key === 'ArrowLeft') { nextState = lanes[Math.max(0, lanes.indexOf(ticket.state) - 1)]; nextIndex = 0; }
    if (event.key === 'ArrowRight') { nextState = lanes[Math.min(lanes.length - 1, lanes.indexOf(ticket.state) + 1)]; nextIndex = 0; }
    if (nextState === ticket.state && nextIndex === index) return;
    await moveTicket(ticket.id, nextState, nextIndex);
  }));
  return card;
}
async function moveTicket(id, lane, index) {
  await request(`/v1/tickets/${encodeURIComponent(id)}/board-position`, { method: 'POST', body: JSON.stringify({ state: lane, index }) });
  state.drag = null; await refresh(id); const laneTickets = visibleTickets().filter((ticket) => ticket.state === lane); const position = laneTickets.findIndex((ticket) => ticket.id === id) + 1; announce(`${id} moved to ${lane}, position ${position} of ${laneTickets.length}.`);
}
function laneSurface(name, tickets) {
  const section = document.createElement('section'); section.className = 'surface lane'; section.dataset.surface = name; section.setAttribute('aria-label', `${name} lane`);
  const heading = document.createElement('h2'); heading.innerHTML = `${name} <span>${tickets.length}</span>`; section.append(heading);
  const stack = document.createElement('div'); stack.className = 'card-stack';
  tickets.forEach((ticket, index) => stack.append(cardFor(ticket, tickets, index)));
  if (!tickets.length) stack.innerHTML = '<p class="empty">Nothing here</p>';
  stack.addEventListener('dragover', (event) => { if (!state.drag) return; event.preventDefault(); stack.classList.add('drop-target'); });
  stack.addEventListener('dragleave', () => stack.classList.remove('drop-target'));
  stack.addEventListener('drop', safely(async (event) => { event.preventDefault(); stack.classList.remove('drop-target'); if (!state.drag) return; const cards = [...stack.querySelectorAll('.ticket-card:not(.dragging)')]; const target = event.target.closest('.ticket-card'); const index = target ? cards.indexOf(target) : cards.length; await moveTicket(state.drag.id, name, Math.max(0, index)); }));
  section.append(stack); return section;
}
function activitySurface(events) {
  const section = document.createElement('section'); section.className = 'surface activity'; section.dataset.surface = 'Activity'; section.setAttribute('aria-label', 'Activity'); section.innerHTML = `<h2>Activity <span>${events.length}</span></h2>`;
  const list = document.createElement('ol'); list.className = 'activity-list';
  for (const event of events) { const item = document.createElement('li'); const ticket = state.tickets.find(({ id }) => id === event.ticket_id); item.innerHTML = '<strong></strong><p></p><small></small>'; item.children[0].textContent = `${event.ticket_id || 'System'} · ${event.type.replaceAll('_', ' ')}`; item.children[1].textContent = event.message || ticket?.title || 'Recorded'; item.children[2].textContent = new Date(event.created_at).toLocaleString(); list.append(item); }
  if (!events.length) list.innerHTML = '<li class="empty">No matching activity yet.</li>'; section.append(list); return section;
}
function renderBoard(focusId = null) {
  const visible = visibleTickets(); const board = $('#board'); board.replaceChildren(); const events = filteredEvents(visible);
  board.append(activitySurface(events)); for (const lane of lanes) board.append(laneSurface(lane, visible.filter((ticket) => ticket.state === lane)));
  $('#filter-empty').hidden = visible.length !== 0; document.querySelectorAll('[data-tab]').forEach((tab) => { const name = tab.dataset.tab; tab.querySelector('span').textContent = name === 'Activity' ? events.length : visible.filter((ticket) => ticket.state === name).length; tab.setAttribute('aria-selected', String(name === state.active)); });
  const narrow = matchMedia('(max-width:600px)').matches; board.querySelectorAll('.surface').forEach((surface) => { surface.hidden = narrow && surface.dataset.surface !== state.active; });
  if (focusId) board.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus();
}
async function refresh(focusId = null) {
  const previous = state.projects.map(({ key }) => key); const [projects, board, activity] = await Promise.all([request('/v1/projects'), request('/v1/board'), request('/v1/events?after=0')]);
  state.projects = projects.projects; state.tickets = board.tickets; state.events = activity.events;
  state.selectedProjects = reconcileProjectSelection(previous, state.projects.map(({ key }) => key), state.selectedProjects, null); if (!previous.length) { state.selectedProjects = new Set(state.projects.map(({ key }) => key)); state.allProjects = true; }
  renderFilters(); renderBoard(focusId); announce(`${visibleTickets().length} tickets shown`);
}
function openTicketCreate(trigger) {
  const form = document.createElement('form'); form.className = 'modal-form'; form.innerHTML = '<label>Project<select name="project" required></select></label><label>Ticket title<input name="title" required></label><label>Description (optional)<textarea name="description" rows="4"></textarea></label><label>Assignment<select name="assignment"><option>Unassigned</option><option>Human</option><option>Agent</option></select></label><button>Create ticket</button>';
  form.elements.project.replaceChildren(new Option('Choose a project', ''), ...state.projects.map(({ key }) => new Option(key, key))); const selected = [...state.selectedProjects]; if (selected.length === 1) form.elements.project.value = selected[0];
  form.addEventListener('submit', safely(async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); const result = await request('/v1/tickets', { method: 'POST', body: JSON.stringify(data) }); modal.dismiss(); await refresh(result.ticket.id); }));
  $('#modal-title').textContent = 'Create ticket'; $('#modal-eyebrow').textContent = 'Quick capture'; $('#modal-content').replaceChildren(form); modal.open({ trigger, initialFocus: selected.length === 1 ? form.elements.title : form.elements.project });
}
$('#pairing-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; $('#pairing-status').textContent = 'Pairing…'; try { const response = await fetch('/v1/devices/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }); const body = await response.json(); if (!response.ok) throw new Error(body?.error?.message || 'Pairing failed'); localStorage.setItem(credentialKey, body.credential); const identity = await request('/v1/devices/me'); if (!identity.actor.admin) throw new Error('The board requires an admin actor.'); localStorage.setItem('viq.actor', identity.actor.id); $('#actor-select').replaceChildren(new Option(identity.actor.name, identity.actor.id)); showBoard(); await refresh(); } catch (error) { localStorage.removeItem(credentialKey); showPairing(error.message); } });
$('#disconnect-device').addEventListener('click', () => { localStorage.removeItem(credentialKey); showPairing('This browser is disconnected. The server-side device was not revoked.'); });
$('#refresh').addEventListener('click', safely(async () => refresh())); $('#close-modal').addEventListener('click', () => modal.close()); $('#open-ticket-create').addEventListener('click', (event) => openTicketCreate(event.currentTarget));
$('#reset-filters').addEventListener('click', () => { state.allProjects = true; state.selectedProjects = new Set(state.projects.map(({ key }) => key)); state.selectedRoles.clear(); renderFilters(); renderBoard(); });
$('#state-tabs').addEventListener('click', (event) => { const tab = event.target.closest('[data-tab]'); if (!tab) return; state.active = tab.dataset.tab; renderBoard(); });
addEventListener('resize', () => renderBoard()); addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.drag) { const previous = state.drag; state.drag = null; announce(`Move cancelled. ${previous.id} remains in ${previous.state}, position ${previous.index + 1}.`); renderBoard(previous.id); } });
(async () => { if (!localStorage.getItem(credentialKey)) return showPairing(); try { const identity = await request('/v1/devices/me'); if (!identity.actor.admin) throw new Error('The board requires an admin actor.'); $('#actor-select').replaceChildren(new Option(identity.actor.name, identity.actor.id)); showBoard(); await refresh(); } catch (error) { report(error); } })();
