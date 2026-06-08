-- FLEX weekly-window engine: forfeited credits (monotonic) + grandfather floor.
-- Idempotent so it is safe to re-run on every deploy.
ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "flex_credits_forfeited" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "flex_forfeit_floor" INTEGER;
