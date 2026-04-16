import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

export default defineConfig({
  earlyAccess: true,
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  datasource: {
    // Use process.env directly — env() from prisma/config throws if missing.
    // In Docker build stage (prisma generate), DATABASE_URL is not set and that's OK.
    // In production (prisma migrate deploy), Railway injects it.
    url: process.env.DATABASE_URL ?? "",
  },
});
