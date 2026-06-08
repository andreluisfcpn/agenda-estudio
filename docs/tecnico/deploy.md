# Deploy

Produção no **Railway**, em um único serviço de aplicação que roda o backend (que também serve o frontend estático). Banco PostgreSQL e Redis são plugins/serviços do próprio Railway.

- **URL de produção:** https://app.buzios.digital
- **Build:** [`Dockerfile`](../../Dockerfile) multi-stage (Node 22 Alpine).

## Build Docker (multi-stage)

O [`Dockerfile`](../../Dockerfile) tem 4 estágios:

1. **deps** — copia os `package.json` (raiz + workspaces) e o schema/config do Prisma e roda `npm ci` (inclui devDependencies). O `postinstall` do backend roda `prisma generate`.
2. **frontend-build** — `npm run build -w frontend` → `frontend/dist/`. Recebe `VITE_GOOGLE_CLIENT_ID` como **build arg** (embutido no bundle pelo Vite). `ARG CACHEBUST` invalida o cache quando o conteúdo muda.
3. **backend-build** — `prisma generate` + `npm run build -w backend` → `backend/dist/`. Em seguida reescreve imports `.ts`→`.js` no cliente gerado compilado.
4. **production** — imagem enxuta: instala só dependências de produção (`npm ci --omit=dev`), copia o CLI do Prisma do estágio `deps`, o schema/migrations, o **cliente Prisma gerado** e os `dist/` de back e front. Cria `backend/uploads`, roda como usuário **não-root** (`appuser`), expõe a porta **3001** e define um `HEALTHCHECK` em `/api/health`.

### Start do container

O `CMD` faz, em sequência:

1. Diagnóstico (loga se `DATABASE_URL`/`REDIS_URL`/`JWT_SECRET` estão setados — sem expor valores).
2. `prisma migrate resolve` (idempotente, destrava migration específica se necessário) → `prisma migrate deploy` (aplica migrations pendentes).
3. `node dist/index.js` (inicia o servidor, que serve a API e os estáticos do frontend).

## Variáveis de ambiente (produção)

Defina no painel/CLI do Railway (nunca commitar valores). Nomes (ver [setup-dev.md](setup-dev.md) para a descrição):

- **Obrigatórias:** `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `NODE_ENV=production`, `PORT=3001`, `FRONTEND_URL` (domínio público).
- **Recomendadas:** `ENCRYPTION_KEY` (criptografia das credenciais de integração), `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` (push).
- **Pagamentos:** `STRIPE_SECRET_KEY` (ou via `IntegrationConfig`); credenciais da Cora via `IntegrationConfig`.
- **Build arg:** `VITE_GOOGLE_CLIENT_ID` (precisa estar disponível no build do frontend).
- **Nunca em produção:** `ALLOW_OTP_BYPASS`, `ALLOW_UNVERIFIED_WEBHOOKS` (são bloqueados/avisados quando `NODE_ENV=production`).

## Deploy pela CLI

```bash
railway up --service agenda-app --ci
```

> A CLI já está autenticada no ambiente; **não** passe token na linha de comando. Prefira deploys com `--ci` e acompanhe os logs no painel.

## Migrations em produção

São aplicadas automaticamente no start (`prisma migrate deploy`). Para inspeções/manutenção pontual contra o banco de produção sem expor a URL localmente, use o serviço **Postgres** do Railway (que expõe `DATABASE_PUBLIC_URL`):

```bash
railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx prisma migrate status'
```

> No Windows/monorepo, lembre do gotcha do Prisma (ver [setup-dev.md](setup-dev.md)).

## Limpeza de dados de teste

O script [`backend/src/scripts/cleanupTestData.ts`](../../backend/src/scripts/cleanupTestData.ts) apaga dados **transacionais** (payments, bookings, contracts, notifications e audit logs relacionados) **preservando** usuários e toda a configuração (preços, add-ons, business config, métodos de pagamento, integrações, cartões salvos, push subscriptions).

- **Dry-run por padrão** (só conta o que apagaria).
- `--apply` executa, gravando antes um **backup JSON** em `backend/backups/cleanup-<runId>.json` e deletando em uma única transação (tudo-ou-nada, em ordem segura de FK).

Contra produção (via URL pública do Postgres):

```bash
# Dry-run (apenas contagens)
railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx backend/src/scripts/cleanupTestData.ts'

# Aplicar de fato
railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx backend/src/scripts/cleanupTestData.ts --apply'
```

## Seed de configuração

[`backend/src/scripts/seedBusinessConfig.ts`](../../backend/src/scripts/seedBusinessConfig.ts) popula a `BusinessConfig`. O seed geral é `backend/prisma/seed.ts` (`npm run db:seed`).

## Checklist de release

1. `npm run build` local passa (back + front).
2. Migrations criadas e revisadas (`prisma migrate dev` em dev).
3. Variáveis novas configuradas no Railway.
4. `railway up --service agenda-app --ci`.
5. Conferir `GET /api/health` e os logs de start (migrations aplicadas).
6. Smoke test do fluxo crítico (login, agendar, pagar em sandbox).

## Relacionado

- [Arquitetura](arquitetura.md) · [Setup de desenvolvimento](setup-dev.md) · [Pagamentos](pagamentos.md)
