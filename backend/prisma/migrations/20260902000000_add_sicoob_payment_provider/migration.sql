-- Add SICOOB to the PaymentProvider enum.
--
-- PIX migrated from Cora to Sicoob; the code persists Payment.provider = 'SICOOB'.
-- This value was applied to dev via `prisma db push` but never captured in a
-- migration, so production (which runs `prisma migrate deploy` on startup) would
-- reject 'SICOOB' as an invalid enum value and every Sicoob PIX charge would fail.
-- Adding it here keeps prod in sync. IF NOT EXISTS makes it idempotent/safe to
-- re-run against a database that already has the value.
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'SICOOB';
