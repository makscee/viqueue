#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'root required' >&2; exit 1; }
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=transaction-lib.sh
source "$SCRIPT_DIR/transaction-lib.sh"
# Rollback waits for the same boundary used by apply. A timer firing during apply
# remains queued instead of silently losing the automatic recovery attempt.
viq15_lock wait 8

CANDIDATE=__FINAL_COMMIT__
OLD_RELEASE=/opt/viqueue/releases/a0d80f15441b5b9b1e3d2c8a45ffa6460b7a5f3b
OLD_WORKER_COMMIT=1398284ed89a6cf9395f129483f709e63c009286
WORKER_ROOT=/opt/viq-worker
OLD_DB=/var/lib/viqueue/viqueue.sqlite
OLD_AUTH_DB=/var/lib/viqueue-phone-auth/phone-auth.sqlite
NEW_DB=/var/lib/viqueue-paired/viqueue.sqlite
STATE=/root/viq15-cutover-state-$CANDIDATE
EXPECTED_SCHEMA=d56e8da3e4ee72a2fa438156a1b967ba3cdf60ff13c6d0ee2f7d8048ce6ed1ae
EXPECTED_ROUTE=a9b93638e2aa7b08d0caed2b4c3e8d1110ef6824052f833fe5abaa839dda3937
STAGE=$STATE/viqueue-v0.4.1-rc
RESTORE_HELPER=$STATE/sqlite-family-restore.sh
[[ -d $STATE && -x $STAGE/sqlite-backup.js && -x $RESTORE_HELPER && -x $STATE/rollback-viq-worker.sh && -f $STATE/viqueue.service.before && -f $STATE/viqueue-phone-gateway.service.before ]] || { echo 'sealed rollback state missing' >&2; exit 1; }
route_hash(){ tailscale serve status --json | sha256sum | cut -d' ' -f1; }
check_route_target(){ tailscale serve status --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s),w=j.Web??{},h=Object.values(w)[0]?.Handlers??{};if(Object.keys(j.TCP??{}).length!==1||j.TCP?.['443']?.HTTPS!==true||Object.keys(w).length!==1||Object.keys(h).length!==1||h['/']?.Proxy!=='http://127.0.0.1:'+process.argv[1])process.exit(1)})" "$1"; }
check_auth_db(){ node --input-type=module - "$OLD_AUTH_DB" "$STATE/old-auth.sqlite" <<'NODE'
import{DatabaseSync}from'node:sqlite';import{existsSync}from'node:fs';const inspect=(f)=>{const d=new DatabaseSync(f,{readOnly:true});if(d.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')process.exit(1);const schema=d.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),counts={};for(const row of schema){const q='"'+row.name.replaceAll('"','""')+'"';counts[row.name]=Number(d.prepare(`SELECT COUNT(*) n FROM ${q}`).get().n)}d.close();return JSON.stringify({schema,counts})};const current=inspect(process.argv[2]);if(existsSync(process.argv[3])&&inspect(process.argv[3])!==current)process.exit(1);
NODE
}
check_old_db(){ node --input-type=module - "$OLD_DB" "$EXPECTED_SCHEMA" <<'NODE'
import{DatabaseSync}from'node:sqlite';import{createHash}from'node:crypto';const d=new DatabaseSync(process.argv[2],{readOnly:true});if(d.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')process.exit(1);const s=d.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();if(createHash('sha256').update(JSON.stringify(s)).digest('hex')!==process.argv[3])process.exit(1);const expected={actor_roles:8,actors:6,claims:18,events:172,execution_authorities:1,projects:5,questions:19,roles:4,ticket_blocks:1,tickets:25};for(const[name,count]of Object.entries(expected)){const q='"'+name.replaceAll('"','""')+'"';if(Number(d.prepare(`SELECT COUNT(*) n FROM ${q}`).get().n)!==count)process.exit(1)}d.close();
NODE
}

CAPTURED_ROUTE=$(sha256sum "$STATE/tailscale-serve.before.json" | cut -d' ' -f1)
[[ $CAPTURED_ROUTE == "$EXPECTED_ROUTE" ]] || { echo 'captured route CAS invalid' >&2; exit 1; }

# Stop every possible ingress/DB writer first. Any later failure therefore remains fail-closed.
systemctl stop viqueue-phone-gateway.service
[[ $(systemctl is-active viqueue-phone-gateway.service) == inactive ]] || { echo 'old gateway did not stop' >&2; exit 1; }
systemctl stop viqueue.service
[[ $(systemctl is-active viqueue.service) == inactive ]] || { echo 'old core did not stop' >&2; exit 1; }
if systemctl cat viqueue-paired.service >/dev/null 2>&1; then
  systemctl disable --now viqueue-paired.service >/dev/null
  [[ $(systemctl is-active viqueue-paired.service) == inactive && $(systemctl is-enabled viqueue-paired.service) == disabled ]] || { echo 'new core did not stop/disable' >&2; exit 1; }
fi
! fuser -s "$OLD_DB" || { echo 'old database holder remains' >&2; exit 1; }
! fuser -s "$OLD_AUTH_DB" || { echo 'old auth database holder remains' >&2; exit 1; }
[[ ! -f $NEW_DB ]] || ! fuser -s "$NEW_DB" || { echo 'new database holder remains' >&2; exit 1; }

# Reconstruct and verify the exact captured route while every backend remains stopped.
tailscale serve --bg --https=443 http://127.0.0.1:7443 >/dev/null
check_route_target 7443 || { echo 'route rollback shape failed' >&2; exit 1; }
[[ $(route_hash) == "$CAPTURED_ROUTE" ]] || { echo 'route rollback CAS failed' >&2; exit 1; }

# Preserve the candidate DB with SQLite semantics when healthy; the original path remains untouched even if backup cannot read corruption.
had_new_db=0; [[ ! -f $NEW_DB ]] || had_new_db=1
if [[ -f $NEW_DB && ! -e $STATE/postcandidate.sqlite ]]; then
  if node "$STAGE/sqlite-backup.js" "$NEW_DB" "$STATE/postcandidate.sqlite"; then chmod 600 "$STATE/postcandidate.sqlite"; else printf '%s\n' 'backup-failed-original-new-db-left-untouched' > "$STATE/postcandidate-backup.status"; fi
fi
[[ $had_new_db == 0 || -f $NEW_DB ]] || { echo 'candidate DB preservation path vanished' >&2; exit 1; }

# Restore exact old units and immutable release pointer lineage.
cp -a "$STATE/viqueue.service.before" /etc/systemd/system/viqueue.service
cp -a "$STATE/viqueue-phone-gateway.service.before" /etc/systemd/system/viqueue-phone-gateway.service
ln -sfn "$OLD_RELEASE" /opt/viqueue/current.rollback
mv -Tf /opt/viqueue/current.rollback /opt/viqueue/current
worker_current=$(readlink -f "$WORKER_ROOT/current")
if [[ $worker_current == "$WORKER_ROOT/releases/$CANDIDATE" ]]; then
  VIQ_WORKER_ROOT="$WORKER_ROOT" bash "$STATE/rollback-viq-worker.sh" "$CANDIDATE" "$OLD_WORKER_COMMIT" > "$STATE/worker-rollback.status"
elif [[ $worker_current != "$WORKER_ROOT/releases/$OLD_WORKER_COMMIT" ]]; then
  echo 'worker rollback pointer CAS failed' >&2; exit 1
fi
[[ $(readlink -f "$WORKER_ROOT/current") == "$WORKER_ROOT/releases/$OLD_WORKER_COMMIT" ]] || { echo 'worker rollback failed' >&2; exit 1; }
systemctl daemon-reload

# Restore from the sealed backup even when the unexpected old family is corrupt.
# Each family rename has a fixed restart-safe destination; preservation is best-effort.
if ! check_old_db; then
  [[ -f $STATE/precutover.sqlite ]] || { echo 'old database drifted before sealed backup existed' >&2; exit 1; }
  "$RESTORE_HELPER" "$STATE/precutover.sqlite" "$OLD_DB" "viq15-unexpected-$CANDIDATE"
  chown viqueue:viqueue "$OLD_DB"; chmod 640 "$OLD_DB"
fi
check_old_db || { echo 'old database restore failed' >&2; exit 1; }
check_auth_db || { echo 'old auth database CAS failed' >&2; exit 1; }

systemctl enable --now viqueue.service >/dev/null
for _ in {1..100}; do curl -fsS http://127.0.0.1:7373/health >/dev/null && break; sleep .1; done
curl -fsS http://127.0.0.1:7373/health >/dev/null || { echo 'old core health failed' >&2; exit 1; }
systemctl enable --now viqueue-phone-gateway.service >/dev/null
for _ in {1..100}; do ss -ltnH | grep -q '127.0.0.1:7443' && break; sleep .1; done
ss -ltnH | grep -q '127.0.0.1:7443' || { echo 'old gateway listener failed' >&2; exit 1; }
check_route_target 7443 || { echo 'final route shape failed' >&2; exit 1; }
[[ $(route_hash) == "$CAPTURED_ROUTE" ]] || { echo 'final route CAS failed' >&2; exit 1; }
[[ $(readlink -f /opt/viqueue/current) == "$OLD_RELEASE" ]] || { echo 'release rollback CAS failed' >&2; exit 1; }
[[ $(readlink -f "$WORKER_ROOT/current") == "$WORKER_ROOT/releases/$OLD_WORKER_COMMIT" ]] || { echo 'worker release rollback CAS failed' >&2; exit 1; }
systemctl disable --now viq15-auto-rollback.timer >/dev/null 2>&1 || true
printf '%s\n' rolled-back > "$STATE/phase"
echo 'ROLLBACK_COMPLETE'
