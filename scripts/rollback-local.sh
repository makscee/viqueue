#!/usr/bin/env bash
set -euo pipefail
prefix="${VIQ_PREFIX:-$HOME/.local}"
root="$prefix/lib/viqueue"
current=$(readlink -f "$root/current")
previous=$(readlink -f "$root/previous")
[[ -d "$current" && -d "$previous" && "$current" != "$previous" ]] || { echo 'no previous release to restore' >&2; exit 1; }
if [[ "${VIQ_RESTORE_STORAGE:-}" == 1 ]]; then
  [[ -n "${VIQ_STORAGE:-}" && "${VIQ_SNAPSHOT_CONFIRMED_OFFLINE:-}" == 1 ]] || { echo 'database restore requires VIQ_STORAGE and VIQ_SNAPSHOT_CONFIRMED_OFFLINE=1' >&2; exit 1; }
  backup_file=$(cat "$current/DB_BACKUP")
  [[ -f "$backup_file" ]] || { echo 'recorded database backup is missing' >&2; exit 1; }
  node --input-type=module -e "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare('PRAGMA integrity_check').get();d.close();if(r.integrity_check!=='ok')process.exit(1)" "$backup_file"
  cp -a "$VIQ_STORAGE" "$VIQ_STORAGE.pre-rollback" 2>/dev/null || true
  cp -a "$backup_file" "$VIQ_STORAGE"
fi
ln -sfn "$previous" "$root/current.tmp"; mv -Tf "$root/current.tmp" "$root/current"
ln -sfn "$current" "$root/previous.tmp"; mv -Tf "$root/previous.tmp" "$root/previous"
printf 'restored viqueue release %s\n' "$(basename "$previous")"
