# Viq documentation authority

For any question about Viq's purpose, responsibilities, worker/runtime boundary, or artifact ownership, start with **[ADR 0013: product charter](adr-0013-product-charter.md)**.

## Current authorities

- [ADR 0013 — Product charter and responsibility boundary](adr-0013-product-charter.md): product purpose, kernel scope, authority boundaries, external adapters, and decision lineage.
- [README](../README.md): current private-PoC usage and repository entry point, subordinate to ADR 0013 on product boundaries.
- [Live-agent dogfood runbook](live-agent-dogfood-runbook.md): bounded worker canary lifecycle, evidence, and safe-stop checklist.
- [CONTEXT](../CONTEXT.md): current product vocabulary and domain/UI language.
- [DESIGN](../DESIGN.md): accepted VIQ-S1 interface composition, subordinate to ADR 0013.
- [ADR 0012 — Pairing PoC](adr-0012-pairing-poc.md): private-PoC authentication and claim eligibility; its original unassigned-work prohibition is preserved historically but superseded by the current eligible unassigned free-pool rule proven at public commit [`5a68920`](https://github.com/makscee/viqueue/commit/5a68920).

## Historical and bounded records

ADRs 0001–0012 retain the decisions and context stated in each file, subject to their status lines and ADR 0013. [`MVP-DESIGN.md`](../MVP-DESIGN.md) is a superseded implementation-candidate record. Release, staging, recovery, and threat-model documents describe bounded operational history; they do not expand the product kernel.

- [Historical records](history/README.md) are non-operational and cannot override ADR 0013 or current deployment authority.
- [Retired phone-auth staging record](history/phone-auth-staging-retirement-record.md) preserves former commands and endpoints as evidence only; it is not an active runbook.
