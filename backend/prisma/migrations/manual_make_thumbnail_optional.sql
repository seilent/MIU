-- Make thumbnail field optional in Track model
ALTER TABLE "Track" ALTER COLUMN "thumbnail" DROP NOT NULL; 