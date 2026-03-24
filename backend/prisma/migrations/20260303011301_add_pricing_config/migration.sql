-- CreateTable
CREATE TABLE "pricing_config" (
    "id" TEXT NOT NULL,
    "tier" "Tier" NOT NULL,
    "price" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pricing_config_tier_key" ON "pricing_config"("tier");
