#!/usr/bin/env bash
# Shared, cutover-specific transaction primitives. Callers use set -Eeuo pipefail.

VIQ15_LOCK_PATH=${VIQ15_LOCK_PATH:-/run/lock/viq15-paired-cutover.lock}

viq15_manifest_seal() {
  local state=${1:?state directory required}; shift
  local manifest=$state/rollback-manifest.sha256 temporary=$state/.rollback-manifest.$$
  [[ -d $state && ! -L $state ]] || { echo 'trusted rollback state missing or unsafe' >&2; return 1; }
  (( $# > 0 )) || { echo 'rollback manifest cannot be empty' >&2; return 1; }
  local item
  for item in "$@"; do
    [[ $item != /* && $item != *'..'* && -f $state/$item && ! -L $state/$item ]] || {
      echo "unsafe rollback manifest member: $item" >&2; return 1;
    }
  done
  (
    cd "$state"
    printf '%s\n' "$@" | LC_ALL=C sort -u | while IFS= read -r item; do sha256sum -- "$item"; done
  ) > "$temporary"
  chmod 600 "$temporary"
  sync -f "$temporary"
  mv -Tf "$temporary" "$manifest"
  sync -f "$state"
}

viq15_manifest_verify() {
  local state=${1:?state directory required}
  local manifest=$state/rollback-manifest.sha256
  [[ -d $state && ! -L $state && -f $manifest && ! -L $manifest ]] || {
    echo 'trusted rollback manifest missing or unsafe' >&2; return 1;
  }
  awk 'NF!=2 || $1!~/^[0-9a-f]{64}$/ || $2~/^\// || $2~/(^|\/)\.\.(\/|$)/ {exit 1} END {if(NR==0)exit 1}' "$manifest" || {
    echo 'rollback manifest format invalid' >&2; return 1;
  }
  (cd "$state" && sha256sum --check --strict --quiet rollback-manifest.sha256) || {
    echo 'rollback manifest authentication failed' >&2; return 1;
  }
}

viq15_manifest_has() {
  local state=${1:?state directory required} item=${2:?manifest member required}
  awk -v item="$item" '$2==item{found=1} END{exit !found}' "$state/rollback-manifest.sha256"
}

# Unit files are staged beside their destination, fsynced, atomically renamed on
# the same device, then followed by a directory fsync. This requires a local
# filesystem that supports atomic rename and fsync; every capability is exercised
# before success is reported.
viq15_atomic_install_file() {
  local source=${1:?source required} target=${2:?target required} mode=${3:?mode required}
  local directory base temporary
  directory=$(dirname -- "$target"); base=$(basename -- "$target")
  [[ -f $source && ! -L $source && -d $directory && ! -L $directory ]] || {
    echo 'atomic install source or destination directory unsafe' >&2; return 1;
  }
  [[ ! -e $target || ( -f $target && ! -L $target ) ]] || {
    echo 'atomic install target unsafe' >&2; return 1;
  }
  temporary=$(mktemp "$directory/.${base}.viq15.XXXXXX") || return
  if ! install -m "$mode" -- "$source" "$temporary" ||
     [[ $(stat -c %d "$temporary") != $(stat -c %d "$directory") ]] ||
     ! sync -f "$temporary" || ! mv -Tf -- "$temporary" "$target" || ! sync -f "$directory"; then
    rm -f -- "$temporary"
    echo 'same-device atomic install or fsync failed' >&2
    return 1
  fi
}

viq15_lock() {
  local mode=${1:?lock mode required} fd=${2:?lock fd required}
  local inherited=${VIQ15_INHERITED_LOCK_FD:-}
  if [[ $inherited =~ ^[0-9]+$ && -e /proc/self/fd/$inherited &&
        $(readlink -f "/proc/self/fd/$inherited") == $(readlink -f "$VIQ15_LOCK_PATH") ]]; then
    return 0
  fi
  eval "exec ${fd}>\"\$VIQ15_LOCK_PATH\""
  case "$mode" in
    exclusive) flock -n "$fd" || { echo 'cutover transaction lock held' >&2; return 75; } ;;
    wait) flock "$fd" ;;
    *) echo "invalid lock mode: $mode" >&2; return 2 ;;
  esac
}

viq15_deadline_create() {
  local state=${1:?state directory required} now=${VIQ15_NOW_UTC:-$(date -u '+%Y-%m-%d %H:%M:%S UTC')}
  local deadline_file=$state/rollback-deadline.utc temporary=$state/.rollback-deadline.$$
  if [[ -e $deadline_file ]]; then
    viq15_deadline_read "$state"
    return
  fi
  local deadline
  deadline=$(date -u -d "$now + 20 minutes" '+%Y-%m-%d %H:%M:%S UTC') || return
  printf '%s\n' "$deadline" > "$temporary"
  chmod 600 "$temporary"
  mv -n "$temporary" "$deadline_file"
  rm -f "$temporary"
  viq15_deadline_read "$state"
}

viq15_deadline_read() {
  local file=${1:?state directory required}/rollback-deadline.utc value canonical
  [[ -f $file && ! -L $file ]] || { echo 'sealed rollback deadline missing or unsafe' >&2; return 1; }
  IFS= read -r value < "$file"
  [[ $value =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}\ UTC$ ]] || {
    echo 'sealed rollback deadline is not absolute UTC' >&2; return 1;
  }
  canonical=$(date -u -d "$value" '+%Y-%m-%d %H:%M:%S UTC') || return
  [[ $canonical == "$value" ]] || { echo 'sealed rollback deadline is not canonical' >&2; return 1; }
  printf '%s\n' "$value"
}

viq15_timer_write() {
  local timer=${1:?timer path required} deadline=${2:?deadline required} service=${3:-viq15-auto-rollback.service}
  cat > "$timer" <<EOF_TIMER
[Unit]
Description=VIQ-15 automatic rollback deadline
[Timer]
OnCalendar=$deadline
Persistent=true
Unit=$service
[Install]
WantedBy=timers.target
EOF_TIMER
}

viq15_timer_verify() {
  local timer=${1:?timer path required} expected=${2:?deadline required}
  local on_calendar persistent unit
  on_calendar=$(awk -F= '$1=="OnCalendar"{n++;v=$2} END{if(n==1)print v}' "$timer")
  persistent=$(awk -F= '$1=="Persistent"{n++;v=$2} END{if(n==1)print v}' "$timer")
  unit=$(awk -F= '$1=="Unit"{n++;v=$2} END{if(n==1)print v}' "$timer")
  [[ $on_calendar == "$expected" && $persistent == true && $unit == viq15-auto-rollback.service ]] || {
    echo 'rollback timer readback mismatch' >&2; return 1;
  }
  command -v systemd-analyze >/dev/null && systemd-analyze calendar --iterations=1 "$on_calendar" >/dev/null
}
