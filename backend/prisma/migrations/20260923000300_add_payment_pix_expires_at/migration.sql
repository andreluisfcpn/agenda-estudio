-- Validade da cobrança PIX (QR Code) atual do pagamento.
--
-- issuePixCharge só reusa a cobrança se ela estiver viva, não expirada (pix_expires_at > agora)
-- e com o mesmo valor; senão concilia/cancela a antiga e emite uma nova. O front usa o valor para
-- a contagem regressiva e o "QR expirado → Gerar novo QR". NULL = legado/sem PIX (conferir no
-- provedor ou tratar como expirado). Aditiva, sem backfill. Idempotente para re-execução segura.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "pix_expires_at" TIMESTAMP(3);
