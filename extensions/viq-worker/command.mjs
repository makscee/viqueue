const commands = new Set(['pair', 'unpair', 'status', 'poll', 'start', 'once', 'claim', 'continue', 'pause', 'resume', 'stop']);

export function parseViqCommand(raw = '') {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { sub: 'help' };
  let first = words.shift();
  let sub;
  if (commands.has(first)) sub = first;
  else if (first.length >= 8 && !first.startsWith('-')) { sub = 'pair'; words.unshift(first); }
  else throw new Error(`Unknown VIQ command “${first}”. Run /viq for help.`);
  const out = { sub };
  if (sub === 'pair') out.code = words.shift();
  if (sub === 'claim' || sub === 'continue' || sub === 'once') out.ticket = words.shift();
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] === '--id' && words[i + 1]) out.id = words[++i];
    else if (words[i] === '--name' && words[i + 1]) out.name = words[++i];
    else if (words[i] === '--project' && words[i + 1] && (sub === 'poll' || sub === 'start')) out.project = words[++i];
    else throw new Error(`Unknown VIQ option “${words[i]}”. Run /viq for help.`);
  }
  return out;
}

export function viqHelp(status = {}) {
  const next = status.paired
    ? status.mode === 'stopped' ? 'Next: run /viq poll to start receiving work.' : 'VIQ is paired. Run /viq status to inspect this session.'
    : 'Next: generate a one-time code in Board → Machines, then pair this Pi.';
  return ['VIQ commands', '/viq pair <code>       Pair this Pi with a one-time code.', '/viq unpair            Remove this stopped Pi’s local pairing record.', '/viq status            Show machine, endpoint, mode, ticket, lifecycle, retry, and next action.', '/viq poll              Persistent lane: atomically claim generic Agent work across all projects and rotate context between tickets.', '/viq once [ticket]     One-shot claim-next, or claim one exact ticket.', '/viq claim <ticket>    Compatibility alias for exact one-shot claim.', '/viq continue <ticket> Continue only that exact ticket after an answered blocking question.', '/viq pause|resume     Pause/resume without releasing the active claim.', '/viq stop              Stop polling and explicitly release any active claim.', 'Control the persistent lane without abandoning claims silently.', 'Model tools: viq_progress, viq_question, viq_block, viq_submit, viq_release. Every tool returns a final result.', 'viq_submit records a structured backend-neutral Review Bundle; it never builds, publishes, merges, releases, or deploys.', next].join('\n');
}

export function viqStatus(status = {}, baseUrl = '') {
  const lifecycle=status.ticket?(status.mode.includes('paused')?'claim paused/blocked':'claim active'):(status.mode==='idle'?'eligible-work polling':status.mode==='paused'?'polling paused':'no active claim');return [`VIQ ${status.paired?'paired':'unpaired'} · worker ${status.device??'unknown'} · mode ${status.lane_mode??'stopped'} (${status.mode||'stopped'}) · lifecycle ${lifecycle}.`,status.ticket?`Ticket ${status.ticket}.`:'Ticket none.',status.project?`Compatibility filter ${status.project}.`:'Scope generic Agent work.',`Target: ${baseUrl||'not configured'}. Endpoint ${baseUrl||'not configured'}.`,status.next_retry_ms?`Idle retry/backoff ${status.next_retry_ms}ms.`:null,status.last_error?`Last error ${status.last_error}.`:null,status.paired?(status.ticket?'Next: use VIQ lifecycle tools; /viq stop releases explicitly.':status.mode==='paused'?'Next: /viq resume or /viq stop.':'Next: /viq poll, /viq once, or /viq stop.'):'Next: /viq pair <code>.'].filter(Boolean).join(' ');
}

export function friendlyViqError(error, baseUrl = '') {
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'viq_transport_error') return `VIQ could not reach ${baseUrl || 'its configured target'}. Check VIQ_URL and that the coordinator is reachable, then retry. Run /viq for help.`;
  if (code === 'pairing_code_used_or_invalid') return 'That pairing code is invalid or already used. Generate a new code in Board → Machines. Run /viq for help.';
  if (code === 'device_not_paired') return 'This Pi is not paired. Run /viq pair <code>. Run /viq for help.';
  if (code.includes('already_paired')) return 'This Pi is already paired. Run /viq status, or /viq unpair after stopping.';
  if(code.startsWith('orphan_claim_requires_operator:'))return `VIQ found an active orphan claim (${code.split(':')[1]}). Do not start work. Resolve or release that claim as an operator, then retry.`;
  if(code==='ticket_ineligible')return 'The ticket is not eligible (state, assignment, blocker, or another claim changed). Refresh the ticket and retry.';
  if(code==='stale_claim')return 'Claim authority is stale. Stop work, inspect /viq status, and have an operator resolve any orphan claim.';
  if(code==='rotation_required_start_fresh_session'||code==='viq_rotation_context_unavailable')return 'Fresh Pi session rotation is required but unavailable. Preserve the checkpoint, start a new saved Pi session, then run /viq poll.';
  if(code==='no_claimed_ticket')return 'No active claim. Run /viq status, then /viq poll or /viq once.';
  return `${code}. Recovery: run /viq status, check pairing and endpoint, then /viq for help.`;
}
