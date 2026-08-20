#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SOURCE=${1:?sealed SQLite backup required}
TARGET=${2:?target SQLite path required}
TAG=${3:-viq15-unexpected}
STAGED=$TARGET.restore-staged
STATUS=$TARGET.$TAG-preservation.status

checkpoint() {
  [[ ${VIQ15_CRASH_AFTER:-} != "$1" ]] || exit 99
}

sqlite_ok() {
  node --input-type=module - "$1" <<'NODE'
import { DatabaseSync } from 'node:sqlite';
let db;
try {
  db = new DatabaseSync(process.argv[2], { readOnly: true });
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') process.exitCode = 1;
} catch { process.exitCode = 1; } finally { try { db?.close(); } catch {} }
NODE
}

stage_restore() {
  if sqlite_ok "$STAGED"; then return; fi
  rm -f "$STAGED" "$STAGED-wal" "$STAGED-shm"
  node --input-type=module - "$SOURCE" "$STAGED" <<'NODE'
import { backup, DatabaseSync } from 'node:sqlite';
const source = new DatabaseSync(process.argv[2], { readOnly: true });
try { await backup(source, process.argv[3]); } finally { source.close(); }
NODE
  sqlite_ok "$STAGED"
}

preserve_member() {
  local source=$1 destination=$2 boundary=$3
  [[ -e $source || -L $source ]] || return 0
  if [[ ! -e $destination && ! -L $destination ]] && mv -- "$source" "$destination"; then
    checkpoint "$boundary"
    return 0
  fi
  # Preservation is best-effort. Recovery must still remove the conflicting family member.
  printf 'preservation incomplete for %s\n' "$(basename "$source")" >> "$STATUS" 2>/dev/null || true
  rm -f -- "$source"
}

[[ -f $SOURCE && ! -L $SOURCE ]] || { echo 'sealed SQLite backup missing or unsafe' >&2; exit 1; }
sqlite_ok "$SOURCE" || { echo 'sealed SQLite backup failed integrity check' >&2; exit 1; }
stage_restore
preserve_member "$TARGET" "$TARGET.$TAG" preserve-main
preserve_member "$TARGET-wal" "$TARGET-wal.$TAG" preserve-wal
preserve_member "$TARGET-shm" "$TARGET-shm.$TAG" preserve-shm
mv -- "$STAGED" "$TARGET"
checkpoint install-main
sqlite_ok "$TARGET" || { echo 'restored SQLite database failed integrity check' >&2; exit 1; }
