# Estúdio Búzios Digital — Agendamento Inteligente

Plataforma de **agendamento, contratos e pagamentos** para estúdio de gravação de podcasts e vídeos. Clientes contratam planos (avulso, fixo, flex ou personalizado), agendam gravações, pagam por PIX/cartão/boleto e acompanham métricas de transmissão. Administradores gerenciam a agenda, finanças, contratos e configuração do negócio.

- **Produção:** https://app.buzios.digital
- **Stack:** React 19 + Vite 6 (PWA) · Express 4 + Prisma 7 · PostgreSQL · Redis · Stripe (cartão) · Cora (PIX/boleto)
- **Monorepo:** npm workspaces (`backend/`, `frontend/`)

## Início rápido (desenvolvimento local)

```bash
docker-compose up -d          # sobe PostgreSQL (5432) + Redis (6379)
npm install                   # instala dependências (raiz + workspaces)
npm run db:migrate            # aplica as migrations do Prisma
npm run db:seed               # popula dados de configuração e usuários de teste
npm run dev                   # backend (3001) + frontend (5173) em paralelo
```

O passo a passo completo (variáveis de ambiente, integrações, gotchas do Windows) está em **[docs/tecnico/setup-dev.md](docs/tecnico/setup-dev.md)**.

## 📚 Documentação

Toda a documentação fica em **[`docs/`](docs/README.md)**:

| Área | Para quem | Link |
| --- | --- | --- |
| **Guia do cliente** | Usuários finais do estúdio | [docs/guia-cliente/](docs/guia-cliente/README.md) |
| **Guia do admin** | Operação do estúdio | [docs/guia-admin/](docs/guia-admin/README.md) |
| **Documentação técnica** | Desenvolvedores | [docs/tecnico/](docs/tecnico/README.md) |

Comece pelo **[índice da documentação](docs/README.md)**.

## Estrutura do repositório

```
agenda/
├── backend/      # API Express + Prisma (ver docs/tecnico/arquitetura.md)
├── frontend/     # SPA/PWA React + Vite
├── docs/         # toda a documentação (este índice aponta para tudo)
├── docker-compose.yml   # PostgreSQL + Redis para dev
└── Dockerfile           # build de produção (multi-stage) usado no Railway
```
