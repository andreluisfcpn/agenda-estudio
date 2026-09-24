-- Soft delete de clientes (exclusão com anonimização).
--
-- Cliente SEM nenhum vínculo é apagado fisicamente; com QUALQUER vínculo (contratos, reservas,
-- pagamentos...) recebe deleted_at e tem os dados pessoais zerados (e-mail, CPF/CNPJ, telefone,
-- endereço, googleId, senha, foto, redes, notas), liberando e-mail/CPF para novo cadastro.
-- NULL = conta ativa. Aditiva, sem backfill. Idempotente para re-execução segura.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
