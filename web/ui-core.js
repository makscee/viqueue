const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

const inlineMarkdown = (value) => escapeHtml(value)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\*([^*]+)\*/g, '<em>$1</em>')
  .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer noopener" target="_blank">$1</a>');

export function applyTicketFilters(tickets, selectedProjects, selectedRoles) {
  return tickets.filter((ticket) => selectedProjects.has(ticket.project) && (
    selectedRoles.size === 0 || selectedRoles.has(ticket.assignment)
  ));
}

export function applyActivityFilters(events, visibleTickets, selectedProjects, selectedRoles, allProjectKeys) {
  const scoped = selectedRoles.size > 0 || selectedProjects.size !== allProjectKeys.length || allProjectKeys.some((key) => !selectedProjects.has(key));
  if (!scoped) return events;
  const visibleIds = new Set(visibleTickets.map(({ id }) => id));
  return events.filter((event) => event.ticket_id === null || visibleIds.has(event.ticket_id));
}

export function activityFact(event) {
  const subject = event.ticket_id || (event.project ? `Project ${event.project}` : 'System');
  const action = ({ role_created: 'assignment group created', role_granted: 'role membership added', role_revoked: 'role membership removed' })[event.type] || String(event.type).replaceAll('_', ' ');
  return { heading: `${subject} · ${action}`, detail: event.actor ? `Actor: ${event.actor}` : 'Actor: system' };
}

export function selectProject(projects, selected, project) {
  const next = new Set(selected); next.has(project) ? next.delete(project) : next.add(project); return next;
}

export const boardProjection = (ticket) => {
  const state = ticket.state.toLowerCase();
  return state === 'open' ? (ticket.claim ? 'working' : 'todo') : state === 'waiting' ? 'review' : state;
};
export const boardColumns = [['open', 'Open'], ['working', 'Working'], ['waiting', 'Waiting'], ['done', 'Done'], ['activity', 'Activity']];
export function dedupeTickets(tickets) { return [...new Map(tickets.map((ticket) => [ticket.id, ticket])).values()]; }

export function reconcileProjectSelection(projectsOrPrevious, projectsOrSelected, selectedOrAll, preferred = null) {
  if (projectsOrSelected instanceof Set) {
    const projects = projectsOrPrevious; const selected = projectsOrSelected; const allProjects = selectedOrAll;
    return allProjects ? new Set(projects) : new Set([...selected].filter((key) => projects.includes(key)));
  }
  const previousProjects = projectsOrPrevious; const projects = projectsOrSelected; const selected = selectedOrAll;
  const wasAll = previousProjects.length === selected.size && previousProjects.every((key) => selected.has(key));
  if (wasAll) return new Set(projects);
  if (preferred && projects.includes(preferred)) return new Set([preferred]);
  return new Set([...selected].filter((key) => projects.includes(key)));
}

export function createModalController(dialog, { requestClose } = {}) {
  let trigger = null; let generation = 0;
  const invalidate = () => ++generation;
  const close = () => { if (dialog.open && !requestClose?.()) dialog.close(); };
  dialog.addEventListener('click', (event) => { if (event.target === event.currentTarget) close(); });
  dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  dialog.addEventListener('close', () => { invalidate(); const previous = trigger; trigger = null; previous?.focus(); });
  return {
    begin: invalidate,
    isActive(intent) { return intent === generation; },
    open({ trigger: nextTrigger = null, initialFocus = null, intent = invalidate() } = {}) {
      if (intent !== generation) return false;
      if (!dialog.open) { trigger = nextTrigger; dialog.showModal(); }
      initialFocus?.focus(); return true;
    },
    close,
    dismiss() { if (dialog.open) dialog.close(); else invalidate(); }
  };
}

export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r/g, '').split('\n');
  const html = [];
  let paragraph = [];
  let list = [];
  const flushParagraph = () => { if (paragraph.length) html.push(`<p>${inlineMarkdown(paragraph.join('\n')).replaceAll('\n', '<br>')}</p>`); paragraph = []; };
  const flushList = () => { if (list.length) html.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`); list = []; };
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (heading) { flushParagraph(); flushList(); const level = heading[1].length; html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); }
    else if (bullet) { flushParagraph(); list.push(bullet[1]); }
    else if (!line.trim()) { flushParagraph(); flushList(); }
    else { flushList(); paragraph.push(line); }
  }
  flushParagraph(); flushList();
  return html.join('');
}
