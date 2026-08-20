#!/usr/bin/env bash
# Shared, cutover-specific transaction primitives. Callers use set -Eeuo pipefail.

VIQ15_LOCK_PATH=${VIQ15_LOCK_PATH:-/run/lock/viq15-paired-cutover.lock}

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
