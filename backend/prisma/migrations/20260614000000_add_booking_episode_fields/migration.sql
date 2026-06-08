-- Add episode metadata + cover image to bookings (idempotent for safe re-runs).
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "episode_title" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "episode_description" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "cover_image_url" TEXT;
