# ADR 0009: Daily Alpha actors, roles, assignment, and questions

Status: accepted for private alpha

The HTTP API remains the sole state machine. Stable actors have a human/agent kind, optional machine placement metadata, active flag, and many roles. Machine is descriptive, never liveness. Unassigned work is claimable by any active agent; actor assignment requires that active actor; role assignment and question/review targeting require at least one active role holder. Claim authority, generation fencing, and explicit release/takeover remain unchanged.

A current claim owner may ask any number of `text` questions with fenced credentials and keep working. Asking changes neither claim nor ticket state. The server computes inbox authorization from the active selected actor and current role memberships. First answer wins atomically. Submission requires an explicit actor or role target and atomically releases the claim, enters review, creates one approval, and appends submitted/question events. Approval accepts exactly `accept` or `request_changes`; the latter returns the ticket open without a claim. Generic text answers cannot answer approvals. Pending approval forbids operator reopen; compatibility accept resolves exactly one current approval, so no parallel lifecycle can disagree.

SQLite initialization migrates accepted v0.3 in place inside `BEGIN IMMEDIATE`. Every distinct legacy assignment and claim string becomes an active agent whose ID is the exact legacy string, so existing claim identities remain valid and no normalization can alias two actors. New registrations use compact normalized IDs. Existing projects, ticket IDs/numbers, claims/tokens/generations, and event cursor rows are retained. Migration DDL/data steps are idempotent and restart-tested. The JSON importer likewise registers mapped legacy actors.

Event metadata is optional object JSON and returns parsed. The browser actor selector is persisted local workflow context, not authentication. Actor identity remains private-network workflow integrity; operator administration and fenced claim credentials retain existing boundaries. Actor tokens are a proposed future gate, not part of this slice.
