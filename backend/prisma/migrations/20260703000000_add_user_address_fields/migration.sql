-- Structured address fields on users (CEP / número / bairro / complemento).
-- Existing `address` is repurposed as the street (logradouro); `city`/`state` already exist.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "address_number" TEXT,
ADD COLUMN     "complement" TEXT,
ADD COLUMN     "neighborhood" TEXT,
ADD COLUMN     "zip_code" TEXT;
