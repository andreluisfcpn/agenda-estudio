# ============================================================
# Studio Scheduler — Multi-stage Docker Build
# Backend (Express + Prisma) + Frontend (React/Vite static)
# ============================================================

# ─── Stage 1: Install ALL dependencies ──────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy root workspace config
COPY package.json package-lock.json ./

# Copy each workspace's package.json
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# Install all dependencies (including devDependencies for build)
RUN npm ci

# ─── Stage 2: Build Frontend (Vite) ─────────────────────────
FROM deps AS frontend-build

WORKDIR /app

# Copy frontend source
COPY frontend/ ./frontend/

# Build frontend → frontend/dist/
RUN npm run build -w frontend

# ─── Stage 3: Build Backend (TypeScript) ─────────────────────
FROM deps AS backend-build

WORKDIR /app

# Copy prisma schema first (needed for prisma generate)
COPY backend/prisma/ ./backend/prisma/

# Generate Prisma client
RUN cd backend && npx prisma generate

# Copy backend source
COPY backend/ ./backend/

# Build backend → backend/dist/
RUN npm run build -w backend

# ─── Stage 4: Production Image ──────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN npm ci --omit=dev --workspace=backend && \
    npm cache clean --force

# Copy Prisma schema + migrations (needed for migrate deploy)
COPY backend/prisma/ ./backend/prisma/

# Generate Prisma client in production image
RUN cd backend && npx prisma generate

# Copy compiled backend
COPY --from=backend-build /app/backend/dist/ ./backend/dist/

# Copy built frontend
COPY --from=frontend-build /app/frontend/dist/ ./frontend/dist/

# Create uploads directory
RUN mkdir -p /app/backend/uploads

# Environment defaults (overridden by Railway)
ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:3001/api/health || exit 1

# Start: run migrations then start server
CMD sh -c "cd backend && npx prisma migrate deploy && node dist/index.js"
