#!/usr/bin/env bash
set -euo pipefail

DB=/opt/fin-bot/data/finance.db
DEST=/opt/fin-bot/backups
STAMP=$(date +%Y%m%d-%H%M)

[ -f "$DB" ] || { echo "Базы ещё нет: $DB"; exit 0; }
mkdir -p "$DEST"

# .backup корректно снимает копию при включённом WAL, в отличие от cp:
# обычное копирование файла может застать базу в несогласованном виде.
sqlite3 "$DB" ".backup '$DEST/finance-$STAMP.db'"
gzip -f "$DEST/finance-$STAMP.db"

# Держим 30 последних копий.
ls -1t "$DEST"/finance-*.db.gz 2>/dev/null | tail -n +31 | xargs -r rm --

echo "Бэкап готов: $DEST/finance-$STAMP.db.gz"
