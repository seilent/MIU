#!/bin/bash
BACKUP_DIR="/home/seilent/MIU/backups"
mkdir -p $BACKUP_DIR
docker exec -t miu-postgres-1 pg_dump -U miu -d miu -Fc -Z 9 > "$BACKUP_DIR/miu_db_$(date +%Y-%m-%d).dump"
find $BACKUP_DIR -name "*.dump" -mtime +30 -delete  # Keep 30 days of backups
