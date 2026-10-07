#!/usr/bin/env bash
# Backs up the Boycott Agent database to backups/ and keeps the last 7 days.
#
#   bash deploy/backup.sh
#
# Every night at 3:00 (crontab -e, one line, adjust the path):
#   0 3 * * * bash /path/to/boycott-agent/deploy/backup.sh >> /path/to/boycott-agent/backups/backup.log 2>&1

set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
DB_USER="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2)"
DB_NAME="$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2)"

mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/boycott-$(date +%F-%H%M).sql.gz"

# Write to a temporary name first, so a failed dump never looks like a good backup.
trap 'rm -f "$file.tmp"' EXIT
docker exec boycott-postgres pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$file.tmp"
mv "$file.tmp" "$file"

find "$BACKUP_DIR" -name 'boycott-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date '+%F %T') backup ok: $file ($(du -h "$file" | cut -f1))"
