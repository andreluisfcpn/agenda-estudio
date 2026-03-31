/*
  Warnings:

  - A unique constraint covering the columns `[phone]` on the table `users` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[google_id]` on the table `users` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[cpf_cnpj]` on the table `users` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `name` to the `contracts` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ContractStatus" ADD VALUE 'PENDING_CANCELLATION';
ALTER TYPE "ContractStatus" ADD VALUE 'PAUSED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ContractType" ADD VALUE 'SERVICO';
ALTER TYPE "ContractType" ADD VALUE 'CUSTOM';

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "add_ons" TEXT[],
ADD COLUMN     "audience_origin" TEXT,
ADD COLUMN     "chat_messages" INTEGER,
ADD COLUMN     "duration_minutes" INTEGER,
ADD COLUMN     "peak_viewers" INTEGER;

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "access_mode" TEXT,
ADD COLUMN     "add_ons" TEXT[],
ADD COLUMN     "addon_credits" TEXT,
ADD COLUMN     "custom_credits_remaining" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "custom_schedule" TEXT,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "pause_reason" TEXT,
ADD COLUMN     "paused_at" TIMESTAMP(3),
ADD COLUMN     "renewed_from_id" TEXT,
ADD COLUMN     "resume_date" TIMESTAMP(3),
ADD COLUMN     "sessions_per_cycle" INTEGER,
ADD COLUMN     "sessions_per_week" INTEGER,
ADD COLUMN     "total_sessions" INTEGER;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "boleto_url" TEXT,
ADD COLUMN     "payment_url" TEXT,
ADD COLUMN     "pix_string" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "address" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "client_status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "cpf_cnpj" TEXT,
ADD COLUMN     "google_id" TEXT,
ADD COLUMN     "social_links" TEXT,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "addon_config" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "description" TEXT,
    "monthly" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "addon_config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "business_config" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "payment_method_config" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "short_label" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "access_mode" TEXT NOT NULL DEFAULT 'FULL',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_method_config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "changes" TEXT,
    "performed_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_configs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "config" TEXT NOT NULL,
    "webhook_url" TEXT,
    "last_tested_at" TIMESTAMP(3),
    "test_status" TEXT,
    "test_message" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_configs_provider_key" ON "integration_configs"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_cpf_cnpj_key" ON "users"("cpf_cnpj");

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_renewed_from_id_fkey" FOREIGN KEY ("renewed_from_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
