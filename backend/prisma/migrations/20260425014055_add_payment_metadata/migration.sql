-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "metadata" JSONB;

-- AlterTable
ALTER TABLE "push_subscriptions" ADD COLUMN     "user_agent" TEXT;

-- RenameIndex
ALTER INDEX "bookings_date_start_time_status_idx" RENAME TO "idx_booking_date_time_status";
