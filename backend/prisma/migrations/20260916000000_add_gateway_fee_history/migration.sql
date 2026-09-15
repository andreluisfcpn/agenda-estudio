-- Histórico temporal das taxas de gateway (Stripe/Cora/Sicoob). Cada linha = taxa vigente de um
-- provider a partir de `effective_from`. O relatório financeiro resolve a taxa de cada pagamento
-- pela data em que foi pago, então mudar a taxa no painel não reescreve o líquido do passado.
-- Idempotente para re-execução segura.
CREATE TABLE IF NOT EXISTS "gateway_fee_history" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "fee_pct" DOUBLE PRECISION NOT NULL,
    "fee_fixed_cents" INTEGER NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gateway_fee_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gateway_fee_history_provider_effective_from_idx"
    ON "gateway_fee_history" ("provider", "effective_from");
