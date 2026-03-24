-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE 'COMPLETED';

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "platform_links" TEXT,
ADD COLUMN     "platforms" TEXT;
