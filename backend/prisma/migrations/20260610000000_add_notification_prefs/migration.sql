-- Client notification preference: deliver only critical notifications when on.
-- Idempotent so it is safe to re-run on every deploy.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "essential_notifications_only" BOOLEAN NOT NULL DEFAULT false;
