const commands = new Set(['pair', 'status', 'poll', 'start', 'claim', 'continue', 'pause', 'resume', 'stop']);

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
  if (sub === 'claim' || sub === 'continue') out.ticket = words.shift();
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] === '--id' && words[i + 1]) out.id = words[++i];
    else if (words[i] === '--name' && words[i + 1]) out.name = words[++i];
    else if (words[i] === '--project' && words[i + 1]) out.project = words[++i];
    else throw new Error(`Unknown VIQ option “${words[i]}”. Run /viq for help.`);
  }
  return out;
}

export function viqHelp(status = {}) {
  const next = status.paired
    ? status.mode === 'stopped' ? 'Next: run /viq poll to start receiving work.' : 'VIQ is paired. Run /viq status to inspect this session.'
    : 'Next: generate a one-time code in Board → Machines, then pair this Pi.';
  return ['VIQ commands', '/viq pair <code>       Pair this Pi with a one-time code. Example: /viq pair <code>', '/viq status            Show pairing and worker state. Example: /viq status', '/viq poll              Claim eligible work in one project. Example: /viq poll --project VIQ', '/viq claim <ticket>    Claim that exact eligible Open ticket for initial or requested-change work.', '/viq continue <ticket> Continue only that exact ticket after an answered blocking question.', '/viq stop              Stop polling safely. Example: /viq stop', 'viq_submit records an outcome summary and backend-neutral immutable evidence references produced elsewhere; it never publishes artifacts.', next].join('\n');
}

export function viqStatus(status = {}, baseUrl = '') {
  return [`VIQ is ${status.paired ? 'paired' : 'not paired'}; worker is ${status.mode || 'stopped'}.`, status.device ? `Machine: ${status.device}.` : null, status.project ? `Project: ${status.project}.` : null, status.ticket ? `Current ticket: ${status.ticket}.` : null, status.last_error ? `Last error: ${status.last_error}.` : null, `Target: ${baseUrl || 'not configured'}.`, status.paired ? (status.mode === 'stopped' ? 'Next: /viq poll' : 'Next: /viq stop when you are done.') : 'Next: /viq pair <code>'].filter(Boolean).join(' ');
}

export function friendlyViqError(error, baseUrl = '') {
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'viq_transport_error') return `VIQ could not reach ${baseUrl || 'its configured target'}. Check VIQ_URL and that the coordinator is reachable, then retry. Run /viq for help.`;
  if (code === 'pairing_code_used_or_invalid') return 'That pairing code is invalid or already used. Generate a new code in Board → Machines. Run /viq for help.';
  if (code === 'device_not_paired') return 'This Pi is not paired. Run /viq pair <code>. Run /viq for help.';
  if (code.includes('already_paired')) return 'This Pi is already paired. Run /viq status, or revoke the old machine before pairing again.';
  return `${code}. Run /viq for help.`;
}
