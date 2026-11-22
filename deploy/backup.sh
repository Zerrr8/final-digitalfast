#!/usr/bin/env bash
# Backup database SQLite + file produk (aman saat server berjalan).
# Pemakaian: sudo bash deploy/backup.sh   -> /var/backups/luthzzstore/store-TANGGAL.db & files-TANGGAL.tar.gz
set -euo pipefail
APP=${APP_DIR:-/opt/luthzzstore}; DEST=${BACKUP_DIR:-/var/backups/luthzzstore}; mkdir -p "$DEST"
STAMP="$(date +%F-%H%M)"; OUT="$DEST/store-$STAMP.db"
node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.argv[1],{readOnly:true});
db.exec("VACUUM INTO \x27"+process.argv[2].replace(/\x27/g,"")+"\x27");
' "$APP/data/store.db" "$OUT"
[ -d "$APP/data/files" ] && tar -czf "$DEST/files-$STAMP.tar.gz" -C "$APP/data" files
find "$DEST" \( -name 'store-*.db' -o -name 'files-*.tar.gz' \) -mtime +14 -delete
echo "Backup: $OUT (+ files-$STAMP.tar.gz)"
