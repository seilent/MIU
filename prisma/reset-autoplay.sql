-- Reset autoplay-related data
UPDATE "Request" SET "status" = 'completed' WHERE "status" = 'playing';
DELETE FROM "Request" WHERE "isAutoplay" = true;
UPDATE "DefaultPlaylist" SET "active" = true; 