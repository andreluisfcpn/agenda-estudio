-- Backfill de DADOS da D6 (status "Concluído"): avulsos já gravados ou perdidos passam a COMPLETED.
-- Separada de 20260923000000_add_contract_completed_status porque o Postgres não deixa usar um valor
-- de enum recém-criado na mesma transação. Mesma regra de lib/contractCompletion.ts (isContractFulfilled):
--   • só contratos AVULSO em ACTIVE (nunca toca PAUSED/PENDING_CANCELLATION/CANCELLED/AWAITING_PAYMENT/EXPIRED);
--   • houve consumo: alguma sessão COMPLETED, ou FALTA sem janela de remarcação aberta;
--   • nada pendente: nenhuma sessão HELD/RESERVED/CONFIRMED, nenhuma NAO_REALIZADO (D5: fica ACTIVE)
--     e nenhuma janela de remarcação OPEN.
-- Idempotente: re-executar não muda nada (o filtro exige status ACTIVE).
UPDATE "contracts" c
SET "status" = 'COMPLETED', "updated_at" = NOW()
WHERE c."type" = 'AVULSO'
  AND c."status" = 'ACTIVE'
  AND EXISTS (
      SELECT 1 FROM "bookings" b
      WHERE b."contract_id" = c."id"
        AND (b."status" = 'COMPLETED'
             OR (b."status" = 'FALTA' AND (b."makeup_status" IS NULL OR b."makeup_status" <> 'OPEN')))
  )
  AND NOT EXISTS (
      SELECT 1 FROM "bookings" b
      WHERE b."contract_id" = c."id"
        AND (b."status" IN ('HELD', 'RESERVED', 'CONFIRMED', 'NAO_REALIZADO')
             OR b."makeup_status" = 'OPEN')
  );
