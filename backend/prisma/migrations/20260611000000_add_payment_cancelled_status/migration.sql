-- Add CANCELLED to PaymentStatus.
-- When a contract is cancelled, its still-PENDING installments are voided to this
-- status so they stop being "faturas abertas", are never auto-charged, and can't be
-- reconciled to PAID by a late Cora/Stripe webhook. Distinct from FAILED (a failed charge).
-- Idempotent: ADD VALUE IF NOT EXISTS is safe to re-run on every deploy.
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
