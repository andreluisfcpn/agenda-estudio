-- Add COMPLETED to ContractStatus ("Concluído").
--
-- Contrato com todas as sessões consumidas e nada pendente: avulso gravado (ou FALTA sem
-- justificativa / janela de remarcação expirada) e FIXO/FLEX/CUSTOM sem sessão nem crédito
-- restante. Renovação e parcelas pendentes continuam valendo para COMPLETED.
-- Sozinha no arquivo: o Postgres não permite USAR um valor de enum na mesma transação em que
-- ele foi adicionado, então qualquer backfill de dados fica numa migration separada.
-- Idempotent: ADD VALUE IF NOT EXISTS is safe to re-run on every deploy.
ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'COMPLETED';
