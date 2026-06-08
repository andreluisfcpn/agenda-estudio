-- Admin can release boleto for a specific contract (off by default).
-- Idempotent so it is safe to re-run on every deploy.
ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "boleto_allowed" BOOLEAN NOT NULL DEFAULT false;
