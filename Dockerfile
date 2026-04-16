# ============================================================
# Studio Scheduler — Production Docker Build
# Backend (Express + Prisma 7) + Frontend (React/Vite static)
# ============================================================

# ─── Stage 1: Install ALL dependencies ──────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy root workspace config
COPY package.json package-lock.json ./

# Copy each workspace's package.json
COPY backend/package.json  ./backend/
COPY frontend/package.json ./frontend/

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
COPY backend/prisma/         ./backend/prisma/
COPY backend/prisma.config.ts ./backend/

# Generate Prisma client (outputs to backend/src/generated/prisma/)
RUN cd backend && npx prisma generate

# Copy backend source and compile
COPY backend/ ./backend/
RUN npm run build -w backend

# ─── Stage 4: Production Image ──────────────────────────────
FROM node:20-alpine AS production

# Metadata
LABEL maintainer="Buzios Digital <contato@buzios.digital>"
LABEL description="Studio Scheduler — Booking & Payment Platform"

WORKDIR /app

# ── 4.1  Production dependencies ─────────────────────────────
COPY package.json package-lock.json ./
COPY backend/package.json  ./backend/
COPY frontend/package.json ./frontend/

RUN npm ci --omit=dev --workspace=backend && \
    npm cache clean --force

# ── 4.2  Install Prisma CLI (needed for migrate deploy at startup)
#    prisma is in devDeps, so we install it globally for the CLI only
RUN npm install -g prisma@7

# ── 4.3  Prisma schema, migrations & config ──────────────────
COPY backend/prisma/          ./backend/prisma/
COPY backend/prisma.config.ts ./backend/

# ── 4.4  Copy generated Prisma Client from build stage ───────
#    This avoids running prisma generate in production
COPY --from=backend-build /app/backend/src/generated/ ./backend/src/generated/

# ── 4.5  Copy compiled backend JS ────────────────────────────
COPY --from=backend-build /app/backend/dist/ ./backend/dist/

# ── 4.6  Copy built frontend static files ────────────────────
COPY --from=frontend-build /app/frontend/dist/ ./frontend/dist/

# ── 4.7  Create uploads directory for multer/sharp ───────────
RUN mkdir -p /app/backend/uploads

# ── 4.8  Security: Run as non-root user ──────────────────────
RUN addgroup -g 1001 -S appgroup && \
    adduser  -S appuser -u 1001 -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

# ── 4.9  Environment defaults (overridden by Railway) ────────
ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# ── 4.10 Health check ────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:3001/api/health || exit 1

# ── 4.11 Start: migrate then serve ──────────────────────────
CMD sh -c "cd backend && prisma migrate deploy && node dist/index.js"
