#!/bin/bash
set -euo pipefail

if docker info >/dev/null 2>&1; then
  DOCKER="docker"
else
  DOCKER="sudo docker"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${SCRIPT_DIR%/scripts}/backups"
mkdir -p "$BACKUP_DIR"

BACKUP_FILE="$BACKUP_DIR/miu_db_$(date +%Y-%m-%d).dump"

echo "Creating backup at $BACKUP_FILE"
$DOCKER exec miu-postgres-1 env PGPASSWORD=miu pg_dump -U miu -d miu -Fc -Z 9 > "$BACKUP_FILE"

find "$BACKUP_DIR" -name "*.dump" -mtime +30 -delete
