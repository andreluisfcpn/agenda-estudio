-- Indexes for frequent range/ordering queries:
--  - payments.due_date: financial summaries, overdue/upcoming filters, monthly breakdown window
--  - contracts.end_date: expiration sweeps and renewal eligibility checks
-- Idempotent (IF NOT EXISTS) so it is safe to re-run on every deploy. Tables are small, so a
-- plain (non-concurrent) CREATE INDEX is fine and keeps the statement inside the migration tx.
CREATE INDEX IF NOT EXISTS "payments_due_date_idx" ON "payments"("due_date");
CREATE INDEX IF NOT EXISTS "contracts_end_date_idx" ON "contracts"("end_date");
