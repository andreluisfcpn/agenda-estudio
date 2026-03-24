/*
  Warnings:

  - The values [CLIENTE_PLANO,CLIENTE_AVULSO] on the enum `Role` will be removed. If these variants are still used in the database, this will fail.
  - Made the column `contract_id` on table `bookings` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('ADMIN', 'CLIENTE');
ALTER TABLE "public"."users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "public"."Role_old";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'CLIENTE';
COMMIT;

-- DropForeignKey
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_contract_id_fkey";

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "original_date" DATE,
ALTER COLUMN "contract_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'CLIENTE';

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
