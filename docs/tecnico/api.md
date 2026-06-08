# Referência da API

API REST sob o prefixo **`/api`**, registrada em [`backend/src/index.ts`](../../backend/src/index.ts). Respostas em JSON. Autenticação por **cookies httpOnly** (`accessToken`/`refreshToken`) — ver [autenticacao.md](autenticacao.md).

**Níveis de acesso** (a fonte autoritativa é o middleware `authenticate`/`authorize('ADMIN')` em cada rota):
- **Público** — sem autenticação.
- **Autenticado** — qualquer usuário logado (cliente ou admin); respeita a posse do recurso.
- **Admin** — exige `role = ADMIN`.

> `GET /api/health` (fora de `/api/*` de negócio) retorna `{ status: "ok" }` para health check.

## auth — `/api/auth` ([routes](../../backend/src/modules/auth/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| POST | `/register/send-code` | Público | Envia código (OTP) para cadastro |
| POST | `/register` | Público | Cria conta validando o OTP |
| POST | `/login` | Público | Login por e-mail + senha |
| POST | `/google` | Público | Login com Google (ID token / access token) |
| POST | `/otp/send` | Público | Solicita OTP |
| POST | `/otp/verify` | Público | Verifica OTP e cria/entra na conta |
| POST | `/refresh` | Cookie | Renova o par de tokens a partir do refresh cookie |
| POST | `/logout` | Público | Limpa os cookies |
| GET | `/me` | Autenticado | Dados do usuário atual |
| PATCH | `/profile` | Autenticado | Atualiza nome, telefone, CPF/CNPJ, endereço, preferências |
| POST | `/profile/photo` | Autenticado | Envia foto (redimensionada para 256×256) |

## bookings — `/api/bookings` ([routes](../../backend/src/modules/bookings/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/public-availability` | Público | Disponibilidade de horários (landing) |
| GET | `/availability` | Autenticado | Disponibilidade para o usuário |
| POST | `/` | Autenticado | Cria um agendamento |
| POST | `/bulk` | Autenticado | Cria vários agendamentos (Flex) |
| POST | `/admin` | Admin | Cria agendamento sem cobrança |
| GET | `/my` | Autenticado | Lista os agendamentos do usuário |
| GET | `/` | Autenticado | Lista agendamentos (admin vê todos) |
| PATCH | `/:id` | Autenticado | Atualiza (remarcar, notas) |
| PATCH | `/:id/client-update` | Autenticado | Atualizações do cliente (plataformas, notas) |
| PATCH | `/:id/reschedule` | Autenticado | Remarcação (janela de 7 dias) |
| POST | `/:id/addons` | Autenticado | Adiciona serviços ao agendamento |
| POST | `/:id/complete-payment` | Autenticado | Conclui o pagamento de avulso |
| DELETE | `/:id` | Autenticado | Cancela (soft delete) |
| DELETE | `/:id/hard-delete` | Admin | Remoção definitiva (devolve crédito Flex) |
| POST | `/cleanup-orphan-addons` | Admin | Limpeza de add-ons órfãos |
| PATCH | `/:id/confirm` | Admin | Confirma a sessão (RESERVED→CONFIRMED) |
| PUT | `/:id/client-cancel` | Autenticado | Cliente cancela a própria sessão |
| PUT | `/:id/check-in` | Admin | Check-in da sessão |
| PUT | `/:id/complete` | Admin | Conclui a sessão (registra métricas) |
| PUT | `/:id/mark-falta` | Admin | Marca falta (devolve crédito Flex) |

## contracts — `/api/contracts` ([routes](../../backend/src/modules/contracts/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| POST | `/check-fixo` | Autenticado | Pré-valida dia/horário de contrato FIXO |
| POST | `/custom/check` | Autenticado | Pré-valida agenda personalizada |
| POST | `/` | Autenticado | Cria contrato (FIXO/FLEX/CUSTOM/AVULSO) |
| POST | `/self` | Autenticado | Renovação usando o contrato anterior como base |
| POST | `/custom` | Autenticado | Cria contrato personalizado |
| POST | `/service` | Admin | Cria contrato de serviço (offline) |
| GET | `/` | Autenticado | Lista contratos (admin vê todos) |
| GET | `/my` | Autenticado | Contratos do usuário (paginado) |
| GET | `/:id` | Autenticado | Detalhe do contrato |
| PATCH | `/:id` | Autenticado | Atualiza contrato |
| DELETE | `/:id` | Autenticado | Cancela contrato |
| POST | `/:id/request-cancellation` | Autenticado | Solicita cancelamento antecipado |
| POST | `/:id/resolve-cancellation` | Admin | Resolve o cancelamento (multa/isenção) |
| POST | `/:id/renew` | Autenticado | Renova (mesmos termos) |
| PATCH | `/:id/pause` | Admin | Pausa o contrato |
| PATCH | `/:id/resume` | Admin | Retoma o contrato |
| POST | `/:id/pay` | Autenticado | Gera o pagamento da 1ª parcela |
| POST | `/:id/confirm-payment` | Admin | Confirma pagamento recebido |
| POST | `/:id/subscribe` | Autenticado | Cria assinatura (plano MENSAL) |
| POST | `/:id/client-renew` | Autenticado | Cliente inicia a renovação |

## users — `/api/users` ([routes](../../backend/src/modules/users/routes.ts)) · Admin

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/` | Lista usuários |
| GET | `/:id` | Detalhe do usuário |
| POST | `/` | Cria usuário |
| PATCH | `/:id` | Atualiza usuário |
| DELETE | `/:id` | Desativa/remove usuário |
| GET | `/:id/payment-overview` | Resumo financeiro do cliente |
| PATCH | `/:id/auto-charge` | Liga/desliga cobrança automática |

## pricing — `/api/pricing` ([routes](../../backend/src/modules/pricing/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/` | Público | Lista os tiers e preços |
| PUT | `/` | Admin | Atualiza preços dos tiers |
| GET | `/addons` | Público | Lista serviços (add-ons) |
| PUT | `/addons` | Admin | Atualiza serviços |
| GET | `/payment-methods` | Público | Métodos de pagamento ativos |
| GET | `/payment-methods/all` | Admin | Todos os métodos (inclui inativos) |
| PUT | `/payment-methods` | Admin | Atualiza configuração dos métodos |
| GET | `/business-config/public` | Público | Configuração pública do negócio |
| GET | `/business-config` | Admin | Configuração completa |
| PUT | `/business-config` | Admin | Atualiza configuração |
| POST | `/checkout-quote` | Autenticado | Cotação autoritativa (valor + parcelas) |

## payments — `/api/payments` ([routes](../../backend/src/modules/payments/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/` | Admin | Lista pagamentos |
| GET | `/summary` | Admin | Resumo financeiro |
| PATCH | `/:id` | Admin | Atualiza um pagamento |
| GET | `/sandbox-mode` | Autenticado | Indica se o gateway está em sandbox |
| GET | `/:id/status` | Autenticado | Status de um pagamento |
| POST | `/:id/simulate` | Dev | Simula confirmação (apenas sandbox/dev) |

## stripe — `/api/stripe` ([routes](../../backend/src/modules/stripe/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/publishable-key` | Autenticado | Chave pública da Stripe |
| POST | `/setup-intent` | Autenticado | Cria SetupIntent (salvar cartão) |
| GET | `/payment-methods` | Autenticado | Lista cartões salvos |
| DELETE | `/payment-methods/:pmId` | Autenticado | Remove cartão |
| PUT | `/payment-methods/:pmId/default` | Autenticado | Define cartão padrão |
| POST | `/create-payment` | Autenticado | Cria PaymentIntent (cartão/PIX/boleto) |
| POST | `/installment-plans` | Autenticado | Planos de parcelamento (1–12x com taxas) |
| PUT | `/auto-charge` | Autenticado | Liga/desliga cobrança automática |
| POST | `/verify-payment` | Autenticado | Recuperação manual de webhook (verifica PI) |

## webhooks — `/api/webhooks` ([routes](../../backend/src/modules/webhooks/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| POST | `/cora` | Assinatura | Webhook da Cora (PIX/boleto) |
| POST | `/stripe` | Assinatura | Webhook da Stripe (precisa do corpo bruto) |

## notifications — `/api/notifications` ([routes](../../backend/src/modules/notifications/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/` | Autenticado | Notificações (computadas + persistidas) |
| PATCH | `/read-all` | Autenticado | Marca todas como lidas |
| PATCH | `/:id/read` | Autenticado | Marca uma como lida |
| DELETE | `/:id` | Autenticado | Remove uma notificação |

## reports — `/api/reports` ([routes](../../backend/src/modules/reports/routes.ts)) · Admin

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/summary` | KPIs (sessões, concluídas, faltas, receita, taxas) |
| GET | `/occupancy` | Ocupação por horário e por dia da semana |
| GET | `/tiers` | Distribuição por tier (quantidade + receita) |
| GET | `/audience` | Métricas de audiência (views, pico, chat, duração) |
| GET | `/ranking` | Ranking de clientes por receita |

## finance — `/api/finance` ([routes](../../backend/src/modules/finance/routes.ts)) · Admin

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/closing/:year/:month` | Fechamento mensal (bruto, taxas por provedor, líquido, pendente) |

## integrations — `/api/integrations` ([routes](../../backend/src/modules/integrations/routes.ts)) · Admin

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/` | Lista as integrações |
| GET | `/:provider` | Configuração de um provedor (`CORA`/`STRIPE`) |
| PUT | `/:provider` | Salva/atualiza credenciais (criptografadas) |
| POST | `/:provider/test` | Testa a conexão |
| POST | `/:provider/toggle` | Habilita/desabilita |
| GET | `/cora/webhooks` | Lista webhooks na Cora |
| POST | `/cora/webhooks` | Registra webhook na Cora |
| DELETE | `/cora/webhooks/:id` | Remove webhook |

## blocked-slots — `/api/blocked-slots` ([routes](../../backend/src/modules/blocked-slots/routes.ts)) · Admin

| Método | Rota | Descrição |
| --- | --- | --- |
| POST | `/` | Cria bloqueio de horário |
| GET | `/?date=YYYY-MM-DD` | Lista bloqueios de uma data |
| DELETE | `/:id` | Remove um bloqueio |

## push — `/api/push` ([routes](../../backend/src/modules/push/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/vapid-key` | Público | Chave pública VAPID |
| POST | `/subscribe` | Autenticado | Registra inscrição Web Push |
| DELETE | `/unsubscribe` | Autenticado | Remove inscrição |
| POST | `/test` | Autenticado | Envia push de teste |

## Rate limits

Aplicados via Redis (globais entre instâncias) em `index.ts`:

| Escopo | Janela | Limite |
| --- | --- | --- |
| `/api/auth/login`, `/api/auth/register` | 15 min | 15 |
| `/api/auth/refresh` | 15 min | 60 |
| `/api/auth/otp`, `/register/send-code` | 15 min | 5 |
| Endpoints financeiros (`stripe/create-payment`, `verify-payment`, `contracts/:id/pay`, `confirm-payment`, `subscribe`, `client-renew`, `bookings/:id/complete-payment`) | 15 min | 20 |
| `/api` (geral) | 1 min | 300 |

## Relacionado

- [Autenticação](autenticacao.md) · [Pagamentos](pagamentos.md) · [Modelo de dados](modelo-de-dados.md)
