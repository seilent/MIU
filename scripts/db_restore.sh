#!/bin/bash
if [ -z "$1" ]; then
  echo "Usage: $0 <backup_file.dump>"
  exit 1
fi

BACKUP_FILE="/home/seilent/MIU/backups/$1"
if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup file not found: $BACKUP_FILE"
  exit 1
fi

read -p "WARNING: This will DROP and RECREATE the database. Continue? [y/N] " confirm
if [[ $confirm != [yY] ]]; then
  echo "Restore cancelled"
  exit 0
fi

echo "Restoring database from $BACKUP_FILE..."
docker exec -i miu_postgres_1 psql -U miu -c "DROP DATABASE IF EXISTS miu;"
docker exec -i miu_postgres_1 psql -U miu -c "CREATE DATABASE miu;"
docker exec -i miu_postgres_1 pg_restore -U miu -d miu -Fc < "$BACKUP_FILE"
echo "Restore complete"
