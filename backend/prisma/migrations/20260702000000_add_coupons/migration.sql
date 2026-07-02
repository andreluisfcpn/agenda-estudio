-- Coupon system: coupons, eligible users, redemptions + audit columns on payments.

-- CreateEnum
CREATE TYPE "CouponDiscountType" AS ENUM ('VALOR', 'PERCENTUAL');

-- CreateEnum
CREATE TYPE "CouponScope" AS ENUM ('FIRST_PAYMENT', 'ALL_INSTALLMENTS');

-- CreateEnum
CREATE TYPE "CouponRedemptionStatus" AS ENUM ('RESERVED', 'CONFIRMED', 'RELEASED');

-- CreateTable
CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discount_type" "CouponDiscountType" NOT NULL,
    "discount_value" INTEGER NOT NULL,
    "scope" "CouponScope" NOT NULL DEFAULT 'FIRST_PAYMENT',
    "expires_at" DATE,
    "max_uses" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "max_uses_per_user" INTEGER,
    "min_amount" INTEGER,
    "only_new_clients" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_eligible_users" (
    "coupon_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "coupon_eligible_users_pkey" PRIMARY KEY ("coupon_id","user_id")
);

-- CreateTable
CREATE TABLE "coupon_redemptions" (
    "id" TEXT NOT NULL,
    "coupon_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "status" "CouponRedemptionStatus" NOT NULL DEFAULT 'RESERVED',
    "original_amount" INTEGER NOT NULL,
    "discount_amount" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "coupon_id" TEXT,
ADD COLUMN "coupon_code" TEXT,
ADD COLUMN "discount_amount" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE INDEX "coupons_active_expires_at_idx" ON "coupons"("active", "expires_at");

-- CreateIndex
CREATE INDEX "coupon_eligible_users_user_id_idx" ON "coupon_eligible_users"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_redemptions_payment_id_key" ON "coupon_redemptions"("payment_id");

-- CreateIndex
CREATE INDEX "coupon_redemptions_coupon_id_status_idx" ON "coupon_redemptions"("coupon_id", "status");

-- CreateIndex
CREATE INDEX "coupon_redemptions_user_id_coupon_id_idx" ON "coupon_redemptions"("user_id", "coupon_id");

-- CreateIndex
CREATE INDEX "payments_coupon_id_idx" ON "payments"("coupon_id");

-- AddForeignKey
ALTER TABLE "coupon_eligible_users" ADD CONSTRAINT "coupon_eligible_users_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_eligible_users" ADD CONSTRAINT "coupon_eligible_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
