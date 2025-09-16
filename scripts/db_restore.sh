#!/bin/bash
set -euo pipefail

if docker info >/dev/null 2>&1; then
  DOCKER="docker"
else
  DOCKER="sudo docker"
fi

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <backup_file.dump>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR%/scripts}/backups"
BACKUP_FILE="$BACKUP_DIR/$1"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup file not found: $BACKUP_FILE"
  exit 1
fi

read -r -p "WARNING: This will DROP and RECREATE the schema. Continue? [y/N] " confirm
if [[ $confirm != [yY] ]]; then
  echo "Restore cancelled"
  exit 0
fi

CONTAINER="miu-postgres-1"

echo "Dropping existing schema..."
$DOCKER exec "$CONTAINER" env PGPASSWORD=miu psql -U miu -d miu -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"

echo "Restoring database from $BACKUP_FILE..."
$DOCKER exec -i "$CONTAINER" env PGPASSWORD=miu pg_restore --no-owner --no-privileges -U miu -d miu < "$BACKUP_FILE"

echo "Restore complete"
