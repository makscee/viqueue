#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'root required' >&2; exit 1; }
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=transaction-lib.sh
source "$SCRIPT_DIR/transaction-lib.sh"
viq15_lock exclusive 9

# These four markers are replaced only when the immutable review bundle is sealed.
CANDIDATE=__FINAL_COMMIT__
TREE=__FINAL_TREE__
BUNDLE_SHA=__FINAL_BUNDLE_SHA256__
WORKER_BUNDLE_SHA=__FINAL_WORKER_BUNDLE_SHA256__
BUNDLE=/root/work/viq15-cutover-final-repair-output/viqueue-final.tar.gz
WORKER_BUNDLE=/root/work/viq15-cutover-final-repair-output/viq-worker-final.tar.gz
OLD_RELEASE=/opt/viqueue/releases/a0d80f15441b5b9b1e3d2c8a45ffa6460b7a5f3b
OLD_WORKER_COMMIT=1398284ed89a6cf9395f129483f709e63c009286
WORKER_ROOT=/opt/viq-worker
OLD_DB=/var/lib/viqueue/viqueue.sqlite
OLD_AUTH_DB=/var/lib/viqueue-phone-auth/phone-auth.sqlite
NEW_PREFIX=/opt/viqueue-paired
NEW_STATE=/var/lib/viqueue-paired
NEW_DB=$NEW_STATE/viqueue.sqlite
NEW_UNIT=/etc/systemd/system/viqueue-paired.service
STATE=/root/viq15-cutover-state-$CANDIDATE
EXPECTED_CORE_UNIT=95b29abf037b8e20bd8865f311ec45f9e86ccf8bf4bbc272aa2dec8aaa5d2245
EXPECTED_GATEWAY_UNIT=d86b71519b32f004242ff85006407e38462227f70bc17c595a47c8ccd4e61745
EXPECTED_ROUTE=a9b93638e2aa7b08d0caed2b4c3e8d1110ef6824052f833fe5abaa839dda3937
EXPECTED_SCHEMA=d56e8da3e4ee72a2fa438156a1b967ba3cdf60ff13c6d0ee2f7d8048ce6ed1ae
MUTATION_STARTED=0
fail(){ echo "cutover blocked: $*" >&2; trap - ERR; if [[ $MUTATION_STARTED == 1 && -x ${STATE:-/nonexistent}/rollback.sh ]]; then VIQ15_INHERITED_LOCK_FD=9 /bin/bash "$STATE/rollback.sh" explicit-failure || true; fi; exit 1; }
sha(){ sha256sum "$1" | cut -d' ' -f1; }
route_hash(){ tailscale serve status --json | sha256sum | cut -d' ' -f1; }
check_route_target(){ tailscale serve status --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s),w=j.Web??{},h=Object.values(w)[0]?.Handlers??{};if(Object.keys(j.TCP??{}).length!==1||j.TCP?.['443']?.HTTPS!==true||Object.keys(w).length!==1||Object.keys(h).length!==1||h['/']?.Proxy!=='http://127.0.0.1:'+process.argv[1])process.exit(1)})" "$1"; }
check_db_cas(){ node --input-type=module - "$1" "$EXPECTED_SCHEMA" <<'NODE'
import{DatabaseSync}from'node:sqlite';import{createHash}from'node:crypto';const d=new DatabaseSync(process.argv[2],{readOnly:true});if(d.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')process.exit(1);const s=d.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();if(createHash('sha256').update(JSON.stringify(s)).digest('hex')!==process.argv[3])process.exit(1);d.close();
NODE
}
seal_generic_sqlite(){ node --input-type=module - "$1" "$2" <<'NODE'
import{backup,DatabaseSync}from'node:sqlite';import{chmodSync}from'node:fs';const inspect=(f)=>{const d=new DatabaseSync(f,{readOnly:true});if(d.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')process.exit(1);const schema=d.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),counts={};for(const row of schema){const q='"'+row.name.replaceAll('"','""')+'"';counts[row.name]=Number(d.prepare(`SELECT COUNT(*) n FROM ${q}`).get().n)}d.close();return JSON.stringify({schema,counts})};const source=process.argv[2],dest=process.argv[3],expected=inspect(source),db=new DatabaseSync(source,{readOnly:true});await backup(db,dest);db.close();chmodSync(dest,0o600);if(inspect(dest)!==expected)process.exit(1);
NODE
}
rollback_on_error(){ local rc=$?; trap - ERR; if [[ $MUTATION_STARTED == 1 && -x $STATE/rollback.sh ]]; then VIQ15_INHERITED_LOCK_FD=9 /bin/bash "$STATE/rollback.sh" automatic-failure || true; fi; exit "$rc"; }
trap rollback_on_error ERR

# Exact read-only preflight CAS.
[[ $(sha "$BUNDLE") == "$BUNDLE_SHA" ]] || fail 'bundle hash drift'
[[ $(sha "$WORKER_BUNDLE") == "$WORKER_BUNDLE_SHA" ]] || fail 'worker bundle hash drift'
[[ $(readlink -f /opt/viqueue/current) == "$OLD_RELEASE" ]] || fail 'release pointer drift'
[[ $(readlink -f "$WORKER_ROOT/current") == "$WORKER_ROOT/releases/$OLD_WORKER_COMMIT" ]] || fail 'worker release pointer drift'
[[ $(cat "$WORKER_ROOT/current/SOURCE_COMMIT") == "$OLD_WORKER_COMMIT" ]] || fail 'worker source identity drift'
[[ $(sha /etc/systemd/system/viqueue.service) == "$EXPECTED_CORE_UNIT" ]] || fail 'core unit drift'
[[ $(sha /etc/systemd/system/viqueue-phone-gateway.service) == "$EXPECTED_GATEWAY_UNIT" ]] || fail 'gateway unit drift'
[[ $(systemctl is-active viqueue.service) == active && $(systemctl is-enabled viqueue.service) == enabled ]] || fail 'core state drift'
[[ $(systemctl is-active viqueue-phone-gateway.service) == active && $(systemctl is-enabled viqueue-phone-gateway.service) == enabled ]] || fail 'gateway state drift'
[[ $(systemctl is-active viq-lane.service) == inactive && $(systemctl is-enabled viq-lane.service) == masked ]] || fail 'lane safety drift'
listeners=$(ss -ltnH | awk '$4 ~ /:(7373|7443|17373)$/ {print $4}' | sort)
[[ $listeners == $'127.0.0.1:7373\n127.0.0.1:7443' ]] || fail 'listener drift'
[[ $(route_hash) == "$EXPECTED_ROUTE" ]] || fail 'Tailscale Serve drift'
check_route_target 7443 || fail 'Tailscale Serve shape drift'
check_db_cas "$OLD_DB" || fail 'database integrity/schema drift'
node "$SCRIPT_DIR/viq15-reconcile.js" inspect "$OLD_DB" > /dev/null || fail 'exact unsettled-state reconciliation drift'
[[ -f $OLD_AUTH_DB && ! -L $OLD_AUTH_DB ]] || fail 'old auth DB missing or unsafe'
[[ $(df -B1 --output=avail /opt | tail -1) -ge 2147483648 && $(df -B1 --output=avail /var/lib | tail -1) -ge 2147483648 ]] || fail 'insufficient disk headroom'
[[ ! -e $STATE && ! -e $NEW_PREFIX && ! -e $NEW_STATE && ! -e $NEW_UNIT && ! -e /etc/systemd/system/viq15-auto-rollback.service && ! -e /etc/systemd/system/viq15-auto-rollback.timer ]] || fail 'new deployment/rollback path already exists'

install -d -m 700 "$STATE"
cp "$SCRIPT_DIR/rollback.sh" "$STATE/rollback.sh"
cp "$SCRIPT_DIR/transaction-lib.sh" "$STATE/transaction-lib.sh"
cp "$SCRIPT_DIR/sqlite-family-restore.sh" "$STATE/sqlite-family-restore.sh"
cp "$SCRIPT_DIR/install-viq-worker.sh" "$STATE/install-viq-worker.sh"
cp "$SCRIPT_DIR/rollback-viq-worker.sh" "$STATE/rollback-viq-worker.sh"
cp "$SCRIPT_DIR/viq15-reconcile.js" "$STATE/viq15-reconcile.js"
chmod 700 "$STATE/rollback.sh" "$STATE/transaction-lib.sh" "$STATE/sqlite-family-restore.sh" "$STATE/install-viq-worker.sh" "$STATE/rollback-viq-worker.sh" "$STATE/viq15-reconcile.js"
tailscale serve status --json > "$STATE/tailscale-serve.before.json"; chmod 600 "$STATE/tailscale-serve.before.json"
cp -a /etc/systemd/system/viqueue.service "$STATE/viqueue.service.before"
cp -a /etc/systemd/system/viqueue-phone-gateway.service "$STATE/viqueue-phone-gateway.service.before"
printf '%s\n' "$OLD_RELEASE" > "$STATE/old-release"
printf '%s\n' "$OLD_WORKER_COMMIT" > "$STATE/old-worker-commit"
chmod 600 "$STATE/old-release" "$STATE/old-worker-commit"
tar -xzf "$BUNDLE" -C "$STATE"
STAGE=$STATE/viqueue-v0.4.1-rc
[[ $(cat "$STAGE/SOURCE_COMMIT") == "$CANDIDATE" && $(cat "$STAGE/SOURCE_TREE") == "$TREE" ]] || fail 'embedded source identity mismatch'
ROLLBACK_MANIFEST_MEMBERS=(
  rollback.sh transaction-lib.sh sqlite-family-restore.sh install-viq-worker.sh
  rollback-viq-worker.sh viq15-reconcile.js tailscale-serve.before.json
  viqueue.service.before viqueue-phone-gateway.service.before old-release
  old-worker-commit viqueue-v0.4.1-rc/sqlite-backup.js
)
# The root-owned mode-0700 STATE directory is the local trust root. The threat
# model covers accidental/non-root artifact tampering, not a hostile root that
# can replace both artifacts and this mode-0600 manifest.
viq15_manifest_seal "$STATE" "${ROLLBACK_MANIFEST_MEMBERS[@]}" || fail 'initial rollback manifest seal failed'
MUTATION_STARTED=1

# Quiesce writers: ingress first, then core, then prove no DB holder remains.
systemctl stop viqueue-phone-gateway.service
[[ $(systemctl is-active viqueue-phone-gateway.service) == inactive ]] || fail 'gateway did not stop'
systemctl stop viqueue.service
[[ $(systemctl is-active viqueue.service) == inactive ]] || fail 'core did not stop'
! fuser -s "$OLD_DB" || fail 'database writer/holder remains'
! fuser -s "$OLD_AUTH_DB" || fail 'old auth database holder remains'
seal_generic_sqlite "$OLD_AUTH_DB" "$STATE/old-auth.sqlite"

# Offline sealed backup and a separate new database; old DB remains rollback lineage.
node "$STAGE/sqlite-backup.js" "$OLD_DB" "$STATE/precutover.sqlite"
chmod 600 "$STATE/precutover.sqlite"
check_db_cas "$STATE/precutover.sqlite" || fail 'offline backup verification failed'
[[ $(stat -c %a "$STATE/precutover.sqlite") == 600 ]] || fail 'offline backup permissions failed'
viq15_manifest_seal "$STATE" "${ROLLBACK_MANIFEST_MEMBERS[@]}" old-auth.sqlite precutover.sqlite || fail 'database rollback manifest seal failed'
install -d -o viqueue -g viqueue -m 750 "$NEW_STATE"
node "$STAGE/sqlite-backup.js" "$STATE/precutover.sqlite" "$NEW_DB.staged"
check_db_cas "$NEW_DB.staged" || fail 'staged candidate DB verification failed'
mv "$NEW_DB.staged" "$NEW_DB"; chown viqueue:viqueue "$NEW_DB"; chmod 640 "$NEW_DB"

# Exact candidate install under a new prefix; /opt/viqueue is untouched.
VIQ_PREFIX="$NEW_PREFIX" VIQ_STORAGE="$NEW_DB" VIQ_SNAPSHOT_CONFIRMED_OFFLINE=1 bash "$STAGE/install-local.sh" >/dev/null
[[ $(cat "$NEW_PREFIX/lib/viqueue/current/SOURCE_COMMIT") == "$CANDIDATE" ]] || fail 'installed source mismatch'

# Reconcile only the stopped sealed candidate copy. The authoritative old DB is forbidden by the helper.
VIQ15_RECONCILE_CONFIRM=SEALED-CANDIDATE-COPY node "$STATE/viq15-reconcile.js" apply "$NEW_DB" > "$STATE/reconciliation-applied.json"
chmod 600 "$STATE/reconciliation-applied.json"

# Install the exact compatible Pi worker package with an atomic pointer switch.
VIQ_WORKER_ROOT="$WORKER_ROOT" bash "$STATE/install-viq-worker.sh" "$WORKER_BUNDLE" "$CANDIDATE" "$OLD_WORKER_COMMIT" > "$STATE/worker-install.status"
chmod 600 "$STATE/worker-install.status"
[[ $(readlink -f "$WORKER_ROOT/current") == "$WORKER_ROOT/releases/$CANDIDATE" ]] || fail 'worker pointer switch failed'
[[ $(cat "$WORKER_ROOT/current/SOURCE_COMMIT") == "$CANDIDATE" ]] || fail 'installed worker source mismatch'

# Bootstrap credential moves only through a pipe into a root-owned file; never stdout or argv.
install -d -m 700 "$STATE/credentials"
"$NEW_PREFIX/bin/viq-bootstrap" --storage "$NEW_DB" --id cutover-coordinator --name 'Cutover Coordinator' |
  node -e "const fs=require('fs'),file=process.argv[1];let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s).credential;if(typeof c!=='string'||c.length<32)process.exit(1);fs.writeFileSync(file,c+'\\n',{mode:0o600,flag:'wx'})})" "$STATE/credentials/bootstrap.credential"
chmod 600 "$STATE/credentials/bootstrap.credential"; chown -R viqueue:viqueue "$NEW_STATE"; chmod 640 "$NEW_DB"

NEW_UNIT_SOURCE=$STATE/viqueue-paired.service.new
cat > "$NEW_UNIT_SOURCE" <<EOF
[Unit]
Description=viqueue paired-device candidate
After=network.target
[Service]
Type=simple
User=viqueue
Group=viqueue
ExecStart=$NEW_PREFIX/bin/viqueue-server --host=127.0.0.1 --port=17373 --storage=$NEW_DB
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$NEW_STATE
[Install]
WantedBy=multi-user.target
EOF
viq15_atomic_install_file "$NEW_UNIT_SOURCE" "$NEW_UNIT" 0644 || fail 'candidate unit atomic install failed'
systemctl daemon-reload
systemctl enable --now viqueue-paired.service >/dev/null
for _ in {1..100}; do curl -fsS http://127.0.0.1:17373/health >/dev/null && break; sleep .1; done
curl -fsS http://127.0.0.1:17373/health >/dev/null || fail 'new core health failed'

# Issue short-lived codes into root-only files without printing the bootstrap credential.
node --input-type=module - "$STATE/credentials/bootstrap.credential" "$STATE/credentials/browser.code" "$STATE/credentials/worker.code" <<'NODE'
import{readFileSync,writeFileSync}from'node:fs';const [credFile,browserFile,workerFile]=process.argv.slice(2),credential=readFileSync(credFile,'utf8').trim();for(const[kind,file]of[['coordinator',browserFile],['worker',workerFile]]){const r=await fetch('http://127.0.0.1:17373/v1/pairing-codes',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${credential}`},body:JSON.stringify({intended_kind:kind,ttl_ms:900000})});if(!r.ok)process.exit(1);const code=(await r.json()).code;writeFileSync(file,code+'\n',{mode:0o600,flag:'wx'})}
NODE

# Seal one absolute UTC deadline. Persistent calendar timers catch up after reboot.
ROLLBACK_DEADLINE=$(viq15_deadline_create "$STATE")
ROLLBACK_SERVICE_SOURCE=$STATE/viq15-auto-rollback.service.new
ROLLBACK_TIMER_SOURCE=$STATE/viq15-auto-rollback.timer.new
cat > "$ROLLBACK_SERVICE_SOURCE" <<EOF
[Unit]
Description=VIQ-15 automatic cutover rollback
[Service]
Type=oneshot
# A deadline firing during apply must remain queued on the shared lock, not time out.
TimeoutStartSec=infinity
ExecStart=/bin/bash $STATE/rollback.sh automatic-timeout
EOF
viq15_timer_write "$ROLLBACK_TIMER_SOURCE" "$ROLLBACK_DEADLINE"
viq15_timer_verify "$ROLLBACK_TIMER_SOURCE" "$ROLLBACK_DEADLINE" || fail 'rollback timer file semantics invalid'
viq15_atomic_install_file "$ROLLBACK_SERVICE_SOURCE" /etc/systemd/system/viq15-auto-rollback.service 0644 || fail 'rollback service atomic install failed'
viq15_atomic_install_file "$ROLLBACK_TIMER_SOURCE" /etc/systemd/system/viq15-auto-rollback.timer 0644 || fail 'rollback timer atomic install failed'
systemctl daemon-reload
systemctl enable --now viq15-auto-rollback.timer >/dev/null
[[ $(systemctl is-active viq15-auto-rollback.timer) == active ]] || fail 'rollback timer did not arm'
TIMER_READBACK=$(systemctl show -P NextElapseUSecRealtime viq15-auto-rollback.timer)
[[ $(date -u -d "$TIMER_READBACK" '+%Y-%m-%d %H:%M:%S UTC') == "$ROLLBACK_DEADLINE" ]] || fail 'rollback timer deadline readback mismatch'
[[ $(route_hash) == "$EXPECTED_ROUTE" ]] || fail 'route changed before CAS'
tailscale serve --bg --https=443 http://127.0.0.1:17373 >/dev/null
check_route_target 17373 || fail 'new route shape not exact'
systemctl disable viqueue.service viqueue-phone-gateway.service >/dev/null
[[ $(systemctl is-active viqueue-phone-gateway.service) == inactive && $(systemctl is-enabled viqueue-phone-gateway.service) == disabled ]] || fail 'old gateway remains authoritative'
! ss -ltnH | grep -q '127.0.0.1:7443' || fail 'old gateway listener remains'
printf '%s\n' route-changed > "$STATE/phase"

echo 'CUTOVER_ACCEPTANCE_REQUIRED'
echo "Secure pairing material is root-only under $STATE/credentials; do not copy it into tickets, logs, argv, or evidence."
echo 'Do not cancel viq15-auto-rollback.timer until the runbook sustained-acceptance gate passes.'
