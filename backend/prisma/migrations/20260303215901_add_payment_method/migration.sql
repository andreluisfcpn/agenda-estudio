-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARTAO', 'PIX', 'BOLETO');

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "payment_method" "PaymentMethod";
