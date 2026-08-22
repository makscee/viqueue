#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
prefix="${VIQ_PREFIX:-$HOME/.local}"
root="$prefix/lib/viqueue"
current=$(readlink -f "$root/current")
previous=$(readlink -f "$root/previous")
[[ -d "$current" && -d "$previous" && "$current" != "$previous" ]] || { echo 'no previous release to restore' >&2; exit 1; }
if [[ "${VIQ_RESTORE_STORAGE:-}" == 1 ]]; then
  [[ -n "${VIQ_STORAGE:-}" && -f "$VIQ_STORAGE" && "${VIQ_SNAPSHOT_CONFIRMED_OFFLINE:-}" == 1 ]] || { echo 'database restore requires existing VIQ_STORAGE and VIQ_SNAPSHOT_CONFIRMED_OFFLINE=1' >&2; exit 1; }
  backup_file=$(cat "$current/DB_BACKUP")
  [[ -f "$backup_file" ]] || { echo 'recorded database backup is missing' >&2; exit 1; }
  preserved="$VIQ_STORAGE.pre-rollback"
  restored="$VIQ_STORAGE.restore.tmp.$$"
  [[ ! -e "$preserved" && ! -e "$preserved-wal" && ! -e "$preserved-shm" ]] || { echo 'post-candidate preservation target already exists' >&2; exit 1; }
  rm -f "$restored" "$restored-wal" "$restored-shm"
  node "$script_dir/sqlite-backup.js" "$VIQ_STORAGE" "$preserved"
  if ! node "$script_dir/sqlite-backup.js" "$backup_file" "$restored"; then rm -f "$preserved" "$preserved-wal" "$preserved-shm" "$restored" "$restored-wal" "$restored-shm"; exit 1; fi
fi
ln -sfn "$previous" "$root/current.tmp"
ln -sfn "$current" "$root/previous.tmp"
if [[ "${VIQ_RESTORE_STORAGE:-}" == 1 ]]; then
  main_hold="$VIQ_STORAGE.main.hold.$$"; wal_hold="$VIQ_STORAGE.wal.hold.$$"; shm_hold="$VIQ_STORAGE.shm.hold.$$"
  moved_main=0; moved_wal=0; moved_shm=0
  restore_original(){
    rm -f "$VIQ_STORAGE" "$VIQ_STORAGE-wal" "$VIQ_STORAGE-shm"
    [[ "$moved_main" == 0 ]] || mv "$main_hold" "$VIQ_STORAGE"
    [[ "$moved_wal" == 0 ]] || mv "$wal_hold" "$VIQ_STORAGE-wal"
    [[ "$moved_shm" == 0 ]] || mv "$shm_hold" "$VIQ_STORAGE-shm"
    rm -f "$restored" "$root/current.tmp" "$root/previous.tmp"
  }
  trap restore_original ERR
  mv "$VIQ_STORAGE" "$main_hold"; moved_main=1
  if [[ -e "$VIQ_STORAGE-wal" ]]; then mv "$VIQ_STORAGE-wal" "$wal_hold"; moved_wal=1; fi
  if [[ -e "$VIQ_STORAGE-shm" ]]; then mv "$VIQ_STORAGE-shm" "$shm_hold"; moved_shm=1; fi
  mv "$restored" "$VIQ_STORAGE"
  node --input-type=module -e "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare('PRAGMA integrity_check').get();d.close();if(r.integrity_check!=='ok')process.exit(1)" "$VIQ_STORAGE"
  rm -f "$VIQ_STORAGE-wal" "$VIQ_STORAGE-shm"
  rm -f "$main_hold" "$wal_hold" "$shm_hold"
  moved_main=0; moved_wal=0; moved_shm=0
  trap - ERR
fi
mv -Tf "$root/current.tmp" "$root/current"
mv -Tf "$root/previous.tmp" "$root/previous"
printf 'restored viqueue release %s\n' "$(basename "$previous")"
