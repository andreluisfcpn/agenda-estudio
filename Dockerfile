# ============================================================
# Studio Scheduler — Production Docker Build
# Backend (Express + Prisma 7) + Frontend (React/Vite static)
# ============================================================

# ─── Stage 1: Install ALL dependencies ──────────────────────
FROM node:22-alpine AS deps

WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Copy root workspace config
COPY package.json package-lock.json ./

# Copy each workspace's package.json
COPY backend/package.json  ./backend/
COPY frontend/package.json ./frontend/

# Copy Prisma schema + config (needed for postinstall: prisma generate)
COPY backend/prisma/          ./backend/prisma/
COPY backend/prisma.config.ts ./backend/

# Install all dependencies (including devDependencies for build)
RUN npm ci

# ─── Stage 2: Build Frontend (Vite) ─────────────────────────
FROM deps AS frontend-build

WORKDIR /app

# Copy frontend source (CACHEBUST invalidates cache when content changes)
ARG CACHEBUST=1
COPY frontend/ ./frontend/

# Build frontend → frontend/dist/
RUN npm run build -w frontend

# ─── Stage 3: Build Backend (TypeScript → JS) ───────────────
FROM deps AS backend-build

WORKDIR /app

# Copy Prisma schema + config first (needed for prisma generate)
COPY backend/prisma/          ./backend/prisma/
COPY backend/prisma.config.ts ./backend/

# Generate Prisma client (outputs to backend/src/generated/prisma/)
RUN cd backend && npx prisma generate

# Copy backend source and compile
COPY backend/ ./backend/
RUN npm run build -w backend
# Fix Prisma generated imports: TSC preserves .ts extensions in output,
# but compiled files have .js extension. Rewrite .ts -> .js in generated dist.
RUN find /app/backend/dist/generated -name '*.js' -exec sed -i "s/\.ts'/\.js'/g; s/\.ts\"/\.js\"/g" {} +

# ─── Stage 4: Production Image ──────────────────────────────
FROM node:22-alpine AS production

# Metadata
LABEL maintainer="Buzios Digital <contato@buzios.digital>"
LABEL description="Studio Scheduler — Booking & Payment Platform"

WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# ── 4.1  Production dependencies ─────────────────────────────
COPY package.json package-lock.json ./
COPY backend/package.json  ./backend/
COPY frontend/package.json ./frontend/

RUN npm ci --omit=dev --ignore-scripts --workspace=backend && \
    npm cache clean --force

# ── 4.2  Prisma CLI — copy from build stage (avoids 1GB+ global install)
#    prisma is a devDep so it's not installed by --omit=dev.
#    We copy only the prisma CLI + its @prisma/* peer packages from deps.
COPY --from=deps /app/node_modules/prisma/   ./node_modules/prisma/
COPY --from=deps /app/node_modules/.package-lock.json ./node_modules/.package-lock.json

# Copy all @prisma scoped packages that prisma CLI needs
# (engines, config, internals, etc. — package names vary by version)
RUN mkdir -p ./node_modules/@prisma
COPY --from=deps /app/node_modules/@prisma/ ./node_modules/@prisma/

# ── 4.3  Prisma schema, migrations & config ──────────────────
COPY backend/prisma/          ./backend/prisma/
COPY backend/prisma.config.ts ./backend/

# ── 4.4  Copy generated Prisma Client from build stage ───────
COPY --from=backend-build /app/backend/src/generated/ ./backend/src/generated/

# ── 4.5  Copy compiled backend JS ────────────────────────────
COPY --from=backend-build /app/backend/dist/ ./backend/dist/

# ── 4.6  Copy built frontend static files ────────────────────
COPY --from=frontend-build /app/frontend/dist/ ./frontend/dist/

# ── 4.7  Create uploads directory for multer/sharp ───────────
# Also symlink node_modules so backend/dist can resolve hoisted packages
RUN mkdir -p /app/backend/uploads && \
    ln -s /app/node_modules /app/backend/node_modules

# ── 4.8  Security: Run as non-root user ──────────────────────
RUN addgroup -g 1001 -S appgroup && \
    adduser  -S appuser -u 1001 -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

# ── 4.9  Environment defaults (overridden by Railway) ────────
ENV NODE_ENV=production
ENV PORT=3001
ENV NODE_PATH=/app/node_modules

EXPOSE 3001

# ── 4.10 Health check ────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:3001/api/health || exit 1

# ── 4.11 Start: migrate then serve ──────────────────────────
CMD ["sh", "-c", "\
  echo '=== Startup Diagnostics ===' && \
  echo \"DATABASE_URL set: $([ -n \"$DATABASE_URL\" ] && echo YES || echo NO)\" && \
  echo \"REDIS_URL set: $([ -n \"$REDIS_URL\" ] && echo YES || echo NO)\" && \
  cd backend && \
  if [ -n \"$DATABASE_URL\" ]; then \
    echo 'Running prisma migrate deploy...' && \
    npx prisma migrate deploy && \
    echo 'Migrations applied successfully.' || \
    echo 'WARNING: Migration failed, starting anyway (migrations may already be applied).'; \
  else \
    echo 'WARNING: DATABASE_URL not set, skipping migrations.'; \
  fi && \
  echo 'Starting server...' && \
  node dist/index.js \
"]

