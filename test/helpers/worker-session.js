export async function claimWithSession(store, ticketId, options = {}) {
  const device = options.device ?? options.actor;
  const session = await store.openWorkerSession(device);
  const claim = await store.claim(ticketId, { ...options, session_capability: session.session_capability });
  return { ...claim, session_capability: session.session_capability };
}

export async function claimNextWithSession(store, options = {}) {
  const device = options.device ?? options.actor;
  const session = await store.openWorkerSession(device);
  const claim = await store.claimNext({ ...options, session_capability: session.session_capability });
  return claim && { ...claim, session_capability: session.session_capability };
}
