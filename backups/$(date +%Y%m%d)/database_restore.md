# Database Backup and Restoration Guide

## Backup Information

This backup was created on $(date +"%Y-%m-%d %H:%M:%S") and contains a full dump of the MIU database before schema changes to use `youtubeId` as the primary key for the `YoutubeRecommendation` model instead of an additional CUID.

## How to Restore the Backup

### Method 1: Using Docker (Recommended)

If the application is running in Docker, you can restore the database with the following steps:

1. Stop the application containers:
   ```bash
   docker-compose down
   ```

2. Start only the database container:
   ```bash
   docker-compose up -d postgres
   ```

3. Restore the database:
   ```bash
   cat miu_db_backup.sql | docker-compose exec -T postgres psql -U miu -d miu
   ```

4. Restart all containers:
   ```bash
   docker-compose up -d
   ```

### Method 2: Direct PostgreSQL Restoration

If PostgreSQL is installed directly on the host:

1. Stop the application.

2. Restore the database:
   ```bash
   psql -h localhost -U miu -d miu < miu_db_backup.sql
   ```

3. Restart the application.

## Verification

To verify the restoration was successful, you can check if the database contains the expected data:

```bash
docker-compose exec postgres psql -U miu -d miu -c "SELECT COUNT(*) FROM \"Track\";"
```

## Troubleshooting

If you encounter any issues during restoration:

1. Make sure the database is running and accessible.
2. Check that you have the correct permissions to access the database.
3. If you get errors about relations already existing, you might need to drop the database first:
   ```bash
   docker-compose exec postgres psql -U miu -c "DROP DATABASE miu;"
   docker-compose exec postgres psql -U miu -c "CREATE DATABASE miu;"
   ```
   Then proceed with the restoration. 