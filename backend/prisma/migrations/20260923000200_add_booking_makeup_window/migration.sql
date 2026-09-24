-- Janela de remarcação do avulso (FALTA justificada / NÃO REALIZADO).
--
--  • makeup_status   → OPEN (janela aberta) | USED (remarcou; remarcação única) | EXPIRED (prazo
--                      passou). NULL = sem janela (inclui FALTA sem justificativa e todo o legado).
--  • makeup_deadline → fim do dia D+7 no fuso de São Paulo (D = data da gravação perdida).
--  • missed_date     → D, a data da sessão perdida (histórico; o booking é reaberto na nova data).
--  • índice (makeup_status, makeup_deadline) → job que expira as janelas vencidas.
-- Aditiva, sem backfill. Idempotente para re-execução segura (CREATE TYPE não tem IF NOT EXISTS).
DO $$ BEGIN
    CREATE TYPE "MakeupStatus" AS ENUM ('OPEN', 'USED', 'EXPIRED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "makeup_status" "MakeupStatus";
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "makeup_deadline" TIMESTAMP(3);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "missed_date" DATE;

CREATE INDEX IF NOT EXISTS "bookings_makeup_status_makeup_deadline_idx"
    ON "bookings" ("makeup_status", "makeup_deadline");
