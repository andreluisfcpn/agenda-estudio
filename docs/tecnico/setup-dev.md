# Setup de desenvolvimento

## Pré-requisitos

- **Node.js 22+**
- **Docker** (para PostgreSQL e Redis) — ou instâncias locais equivalentes
- Opcional: **Stripe CLI** (para receber webhooks de cartão localmente)

## Passo a passo

```bash
# 1. Subir banco e cache
docker-compose up -d              # PostgreSQL :5432 e Redis :6379

# 2. Instalar dependências (raiz + workspaces)
npm install                        # roda postinstall: prisma generate (backend)

# 3. Criar o .env do backend (ver seção abaixo)

# 4. Aplicar o schema e popular dados
npm run db:migrate                 # prisma migrate dev
npm run db:seed                    # popula config do negócio + usuários de teste

# 5. Rodar em modo dev (backend + frontend juntos)
npm run dev
```

- Frontend (Vite): **http://localhost:5173**
- Backend (Express): **http://localhost:3001**
- O Vite faz **proxy** de `/api` e `/uploads` para `http://127.0.0.1:3001` (ver [`frontend/vite.config.ts`](../../frontend/vite.config.ts)), então o frontend chama caminhos relativos.

## Portas

| Serviço | Porta |
| --- | --- |
| Frontend (Vite dev) | 5173 |
| Backend (Express) | 3001 |
| PostgreSQL | 5432 |
| Redis | 6379 |

Credenciais do Postgres no `docker-compose.yml`: usuário `studio`, senha `studio_secret`, banco `studio_scheduler`.

## Variáveis de ambiente (backend)

Em desenvolvimento, o backend carrega `backend/.env` (em produção, as variáveis são injetadas pelo ambiente). Todas são lidas em [`backend/src/config/index.ts`](../../backend/src/config/index.ts).

| Variável | Obrigatória | Default (dev) | Descrição |
| --- | --- | --- | --- |
| `DATABASE_URL` | sim | — | String de conexão do PostgreSQL |
| `REDIS_URL` | não | `redis://localhost:6379` | String de conexão do Redis |
| `PORT` | não | `3001` | Porta da API |
| `NODE_ENV` | não | `development` | `development` ou `production` |
| `FRONTEND_URL` | não | `http://localhost:5173` | Origem permitida no CORS |
| `JWT_SECRET` | sim em prod | `dev-secret` | Assina o access token |
| `JWT_REFRESH_SECRET` | sim em prod | `dev-refresh-secret` | Assina o refresh token |
| `JWT_ACCESS_EXPIRY` | não | `1h` | Validade do access token |
| `JWT_REFRESH_EXPIRY` | não | `30d` | Validade do refresh token |
| `ENCRYPTION_KEY` | recomendada | `''` | Chave AES para criptografar credenciais de integração |
| `STRIPE_SECRET_KEY` | para cartão | `''` | Chave secreta da Stripe (também pode vir da config de integração) |
| `VAPID_PUBLIC_KEY` | para push | `''` | Chave pública VAPID (Web Push) |
| `VAPID_PRIVATE_KEY` | para push | `''` | Chave privada VAPID |
| `VAPID_SUBJECT` | não | `mailto:contato@buzios.digital` | Assunto VAPID |
| `ALLOW_OTP_BYPASS` | só dev | — | `true` aceita o código OTP `999999` (bloqueado em produção) |
| `ALLOW_UNVERIFIED_WEBHOOKS` | só dev | — | `true` aceita webhooks sem assinatura (bloqueado em produção) |

> A chave **VITE_GOOGLE_CLIENT_ID** é do **frontend** (embutida no bundle em build time pelo Vite). Em dev, defina em `frontend/.env`. Sem ela, o login Google usa um client id "mock".

> Constantes de negócio fixas (horário de funcionamento, duração do slot, dias de operação, TTL do hold) ficam em `config.studio` no mesmo arquivo de config: aberto 09:00–23:00, slots de 30 min, mínimo de 2h por pacote, segunda a sábado, hold de 600 s (10 min).

## Scripts npm

Raiz ([`package.json`](../../package.json)):

| Script | O que faz |
| --- | --- |
| `npm run dev` | Sobe backend e frontend em paralelo |
| `npm run dev:backend` / `npm run dev:frontend` | Um de cada vez |
| `npm run build` | Build do backend (tsc) e do frontend (vite) |
| `npm run db:migrate` | `prisma migrate dev` no backend |
| `npm run db:seed` | Popula o banco |

Backend ([`backend/package.json`](../../backend/package.json)):

| Script | O que faz |
| --- | --- |
| `npm run dev -w backend` | `tsx watch src/index.ts` |
| `npm run build -w backend` | `tsc` |
| `npm run start -w backend` | `node dist/index.js` |
| `npm run db:generate -w backend` | `prisma generate` (recria o cliente) |
| `npm run db:seed -w backend` | `tsx prisma/seed.ts` |
| `npm run test -w backend` | `vitest run` |
| `npm run stripe:listen -w backend` | Encaminha webhooks da Stripe para `localhost:3001/api/webhooks/stripe` |

Frontend ([`frontend/package.json`](../../frontend/package.json)): `dev` (vite), `build` (`tsc -b && vite build`), `preview`.

## Webhooks locais (Stripe)

Para testar pagamentos com cartão em dev, rode em um terminal separado:

```bash
npm run stripe:listen -w backend
```

Em desenvolvimento você também pode definir `ALLOW_UNVERIFIED_WEBHOOKS=true` para aceitar webhooks sem assinatura, e usar o endpoint de **simulação** de pagamento (ver [pagamentos.md](pagamentos.md) e [api.md](api.md), `POST /api/payments/:id/simulate`).

## Gotcha: Prisma no monorepo (Windows)

No Windows, rodar `npx prisma ...` a partir da raiz pode falhar com `MODULE_NOT_FOUND` por causa do symlink `node_modules/backend`. Rode o Prisma **dentro de `backend/`** ou aponte para o binário diretamente:

```bash
cd backend && node ../node_modules/prisma/build/index.js generate
# ou
cd backend && node ../node_modules/prisma/build/index.js db push
```

O cliente gerado fica em `backend/src/generated/prisma` e é **versionado** — regenere após qualquer mudança no [`schema.prisma`](../../backend/prisma/schema.prisma). Detalhes em [modelo-de-dados.md](modelo-de-dados.md).

## Relacionado

- [Arquitetura](arquitetura.md) · [Modelo de dados](modelo-de-dados.md) · [Deploy](deploy.md)
