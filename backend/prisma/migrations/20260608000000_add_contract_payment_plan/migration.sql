-- How a contract is paid: MONTHLY (1 now + rest monthly) or FULL (paid upfront).
-- Idempotent so it is safe to re-run on every deploy.
ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "payment_plan" TEXT NOT NULL DEFAULT 'MONTHLY';
