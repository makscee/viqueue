const text = (value, name, max = 8000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`invalid_${name}`);
  return value.trim();
};
const list = (value, name, { min = 0, max = 100, item = (entry) => text(entry, name, 2000) } = {}) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`invalid_${name}`);
  return value.map(item);
};
const safeUri = (raw, name = 'evidence_uri') => {
  const value = text(raw, name, 2000); let url;
  try { url = new URL(value); } catch { throw new Error(`invalid_${name}`); }
  if (!['https:', 'http:', 'urn:', 'file:'].includes(url.protocol) || url.username || url.password) throw new Error(`invalid_${name}`);
  return value;
};
const optionalUri = (value, name) => value == null || value === '' ? null : safeUri(value, name);
const clickableUri = (raw, name) => { const value = safeUri(raw, name); if (!['https:', 'http:'].includes(new URL(value).protocol)) throw new Error(`invalid_${name}`); return value; };
const sourceCommit = (value) => { const commit = text(value, 'commit', 200); return /^[a-z][a-z0-9+.-]*:/i.test(commit) ? safeUri(commit, 'commit_uri') : commit; };
const sourceFact = (value, name, absent, present) => {
  value ??= { status: absent };
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![absent, present].includes(value.status)) throw new Error(`invalid_${name}_status`);
  return { status: value.status, ...(value.reference ? { reference: safeUri(value.reference, `${name}_reference`) } : {}) };
};

export function normalizeReviewBundle(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== 1) throw new Error('invalid_review_bundle');
  const evidence = list(input.evidence, 'evidence', { min: 1, item: (entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid_evidence');
    const kind = text(entry.kind, 'evidence_kind', 40), label = text(entry.label, 'evidence_label', 200), uri = safeUri(entry.uri);
    if (!['preview', 'pr', 'commit', 'screenshot', 'test', 'log', 'build', 'asset', 'other'].includes(kind)) throw new Error('invalid_evidence_kind');
    const digest = entry.digest == null ? null : text(entry.digest, 'evidence_digest', 200);
    if (uri.startsWith('file:') && !digest) throw new Error('file_evidence_requires_digest');
    return { kind, label, uri, ...(digest ? { digest } : {}) };
  } });
  const tests = list(input.tests, 'tests', { min: 1, item: (entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid_tests');
    if (!['passed', 'failed', 'not-run'].includes(entry.status)) throw new Error('invalid_test_status');
    return { name: text(entry.name, 'test_name', 200), status: entry.status, ...(entry.uri ? { uri: safeUri(entry.uri, 'test_uri') } : {}) };
  } });
  const screenshots = list(input.screenshots ?? [], 'screenshots', { item: (entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid_screenshots');
    return { label: text(entry.label, 'screenshot_label', 200), uri: safeUri(entry.uri, 'screenshot_uri'), ...(entry.digest ? { digest: text(entry.digest, 'screenshot_digest', 200) } : {}) };
  } });
  const release = input.release;
  if (!release || typeof release !== 'object' || !['not-released', 'released', 'production-verified'].includes(release.status)) throw new Error('invalid_release_status');
  const source = input.source ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) throw new Error('invalid_source');
  return {
    version: 1, summary: text(input.summary, 'summary'), evidence,
    verification_steps: list(input.verification_steps, 'verification_steps', { min: 1 }), tests,
    caveats: list(input.caveats ?? [], 'caveats'), ui_change: Boolean(input.ui_change),
    preview_url: optionalUri(input.preview_url, 'preview_url'), screenshots,
    source: { ...(source.commit ? { commit: sourceCommit(source.commit) } : {}), ...(source.pr ? { pr: clickableUri(source.pr, 'pr_uri') } : {}), review: sourceFact(source.review, 'review', 'not-reviewed', 'reviewed'), merge: sourceFact(source.merge, 'merge', 'not-merged', 'merged') },
    release: { status: release.status, ...(release.build_id ? { build_id: text(release.build_id, 'build_id', 200) } : {}), ...(release.reference ? { reference: safeUri(release.reference, 'release_reference') } : {}) }
  };
}

export function legacyReviewBundle({ summary, evidence }) {
  return normalizeReviewBundle({
    version: 1, summary,
    evidence: evidence.map((uri, index) => ({ kind: 'other', label: `Evidence ${index + 1}`, uri: /^(https?|urn|file):/i.test(uri) ? uri : `urn:viq:legacy:${encodeURIComponent(uri)}` })),
    verification_steps: ['Follow the submitted evidence reference and inspect the result.'],
    tests: [{ name: 'Legacy submission (test details not structured)', status: 'not-run' }],
    caveats: ['Migrated legacy submission; structured fields were not supplied.'], ui_change: false, source: { review: { status: 'not-reviewed' }, merge: { status: 'not-merged' } }, release: { status: 'not-released' }
  });
}
