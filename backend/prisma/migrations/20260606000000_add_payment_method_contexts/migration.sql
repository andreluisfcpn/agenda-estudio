-- Per-context visibility for payment methods: which checkouts (avulso, contract,
-- invoice) show each method. Idempotent so it is safe to re-run.
ALTER TABLE "payment_method_config" ADD COLUMN IF NOT EXISTS "contexts" TEXT NOT NULL DEFAULT 'avulso,contract,invoice';
