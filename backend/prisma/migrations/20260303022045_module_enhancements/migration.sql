-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "contract_url" TEXT,
ADD COLUMN     "flex_weeks_compensated" INTEGER DEFAULT 0;

-- AlterTable
ALTER TABLE "pricing_config" ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "notes" TEXT;
