-- E3 (lote 2, 30/09/2026) — migração SÓ DE DADOS: a chave-mestra "Aceitar pagamento por boleto" nasce DESLIGADA.
-- A coluna payment_method_config.active da linha BOLETO passou a ser a chave-mestra do boleto (boleto
-- efetivo = chave ligada E integração Cora habilitada). Os seeds antigos (seed.prod.ts, seed_pm.sql,
-- scripts/seedPaymentMethods.ts) gravavam BOLETO com active = true: num banco semeado por eles a chave já
-- viria LIGADA, e ativar a Cora por qualquer motivo (ex.: contingência de PIX) liberaria o boleto para
-- todos os contratos sem o dono ter ligado o switch.
--   • Desliga a chave só onde o boleto NÃO está em operação (Cora desabilitada ou sem linha de integração).
--   • Quem já opera boleto (Cora habilitada) NÃO é tocado: o NOT EXISTS preserva a chave ligada.
--   • Sem mudança de schema. Idempotente: re-executar não muda nada (depois da 1ª vez a linha já está false;
--     banco sem a linha BOLETO → 0 linhas afetadas).
-- Depois desta migração o dono liga o boleto em Configurações → Pagamentos (o switch só liga com a Cora ativa).
UPDATE "payment_method_config"
SET "active" = false, "updated_at" = NOW()
WHERE "key" = 'BOLETO'
  AND "active" = true
  AND NOT EXISTS (
      SELECT 1 FROM "integration_configs" ic
      WHERE ic."provider" = 'CORA' AND ic."enabled" = true
  );
