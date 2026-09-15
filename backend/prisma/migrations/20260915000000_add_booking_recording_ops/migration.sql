-- Operação da gravação (área admin), idempotente para re-execução segura:
--  • recording_started_at / _by_id / _by_name → quem iniciou a gravação e quando (marca que houve
--    um operador presente; exigido antes de finalizar).
--  • status_reason → motivo informado ao marcar FALTA ou NÃO REALIZADO.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "recording_started_at" TIMESTAMP(3);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "recording_started_by_id" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "recording_started_by_name" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "status_reason" TEXT;
