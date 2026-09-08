-- Add `charged_amount` to payments.
--
-- `amount` remains the immutable BASE (no card interest). `charged_amount` holds the
-- total actually charged on a card (base + installment surcharge). This prevents the
-- card interest from (a) compounding on each retry and (b) leaking into PIX/boleto,
-- which charge `amount`. Card amount-parity checks compare against COALESCE(charged_amount, amount).
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "charged_amount" INTEGER;
