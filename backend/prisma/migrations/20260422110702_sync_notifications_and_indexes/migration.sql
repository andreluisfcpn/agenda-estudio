-- CreateEnum (safe: skip if already exists)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NotificationType') THEN
        CREATE TYPE "NotificationType" AS ENUM (
            'CONTRACT_EXPIRING',
            'PAYMENT_OVERDUE',
            'PAYMENT_CONFIRMED',
            'PAYMENT_FAILED',
            'BOOKING_UNCONFIRMED',
            'BOOKING_REMINDER',
            'BOOKING_CONFIRMED',
            'BOOKING_CANCELLED',
            'CONTRACT_ACTIVATED',
            'CONTRACT_RENEWED',
            'CANCELLATION_PENDING',
            'FLEX_CREDITS_LOW',
            'CLIENT_INACTIVE',
            'CONTRACT_AWAITING_PAYMENT',
            'SYSTEM'
        );
    END IF;
END$$;

-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'HELD';

-- AlterEnum
ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'AWAITING_PAYMENT';

-- AlterEnum
ALTER TYPE "ContractType" ADD VALUE IF NOT EXISTS 'AVULSO';

-- AlterTable: bookings
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "hold_expires_at" TIMESTAMP(3);

-- AlterTable: contracts
ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "payment_deadline" TIMESTAMP(3);

-- AlterTable: payments
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMP(3);

-- CreateTable: push_subscriptions
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: notifications
CREATE TABLE IF NOT EXISTS "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "action_url" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "push_sent" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: push_subscriptions
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex: notifications
CREATE INDEX IF NOT EXISTS "notifications_user_id_read_idx" ON "notifications"("user_id", "read");
CREATE INDEX IF NOT EXISTS "notifications_created_at_idx" ON "notifications"("created_at");

-- CreateIndex: performance indexes
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs"("created_at");
CREATE INDEX IF NOT EXISTS "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "blocked_slots_date_idx" ON "blocked_slots"("date");
CREATE INDEX IF NOT EXISTS "bookings_contract_id_idx" ON "bookings"("contract_id");
CREATE INDEX IF NOT EXISTS "bookings_date_idx" ON "bookings"("date");
CREATE INDEX IF NOT EXISTS "bookings_status_idx" ON "bookings"("status");
CREATE INDEX IF NOT EXISTS "bookings_user_id_idx" ON "bookings"("user_id");
CREATE INDEX IF NOT EXISTS "payments_booking_id_idx" ON "payments"("booking_id");
CREATE INDEX IF NOT EXISTS "payments_contract_id_idx" ON "payments"("contract_id");
CREATE INDEX IF NOT EXISTS "payments_provider_ref_idx" ON "payments"("provider_ref");
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments"("status");
CREATE INDEX IF NOT EXISTS "payments_stripe_subscription_id_idx" ON "payments"("stripe_subscription_id");
CREATE INDEX IF NOT EXISTS "payments_user_id_idx" ON "payments"("user_id");
CREATE INDEX IF NOT EXISTS "saved_payment_methods_user_id_idx" ON "saved_payment_methods"("user_id");
CREATE INDEX IF NOT EXISTS "contracts_user_id_idx" ON "contracts"("user_id");

-- Drop old unique constraint on bookings (replace with index)
DROP INDEX IF EXISTS "bookings_date_start_time_status_key";
CREATE INDEX IF NOT EXISTS "bookings_date_start_time_status_idx" ON "bookings"("date", "start_time", "status");

-- Fix saved_payment_methods FK: drop RESTRICT, add CASCADE
ALTER TABLE "saved_payment_methods" DROP CONSTRAINT IF EXISTS "saved_payment_methods_user_id_fkey";
ALTER TABLE "saved_payment_methods" ADD CONSTRAINT "saved_payment_methods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: push_subscriptions (safe: skip if exists)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_user_id_fkey') THEN
        ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END$$;

-- AddForeignKey: notifications (safe: skip if exists)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_user_id_fkey') THEN
        ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END$$;
