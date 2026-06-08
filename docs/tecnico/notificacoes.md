# Notificações

O sistema combina notificações **computadas** (calculadas em tempo real a partir dos dados) e **persistidas** (gravadas na tabela `notifications` por jobs/efeitos). Endpoint principal: `GET /api/notifications` ([routes](../../backend/src/modules/notifications/routes.ts)).

## Dois tipos

### Computadas (tempo real)
Geradas a cada requisição de `GET /api/notifications`, sem persistir. Filtram por papel (admin vê de todos; cliente só as suas):

| Origem | Tipo | Severidade |
| --- | --- | --- |
| Contratos expirando (≤7d admin / ≤15d cliente) | `CONTRACT_EXPIRING` | warning / critical (≤2d) |
| Pagamentos vencidos (`PENDING` com `dueDate` no passado) | `PAYMENT_OVERDUE` | warning / critical (>7d) |
| Pagamentos recusados (`FAILED`) | `PAYMENT_OVERDUE` | critical |
| Sessões não confirmadas **de hoje** (`RESERVED`) | `BOOKING_UNCONFIRMED` | critical |
| Contratos em cancelamento pendente | `CANCELLATION_PENDING` | warning |
| Contratos aguardando pagamento | `CONTRACT_AWAITING_PAYMENT` | warning / critical (prazo curto) |

### Persistidas (DB)
Gravadas por jobs e por `paymentEffects` (ex.: `PAYMENT_CONFIRMED`, `CONTRACT_ACTIVATED`, `BOOKING_REMINDER`, sinais de crédito Flex). São lidas junto com as computadas; há **deduplicação** por `(type, entityId)` para não repetir uma computada que também exista persistida.

## Severidades e ordenação

Severidade é `critical` | `warning` | `info`. A lista é ordenada por **não lidas primeiro** e depois por severidade (critical → warning → info). O resumo retorna contagens por severidade e total de não lidas (usado no badge do sino).

## Web Push

- Chave pública via `GET /api/push/vapid-key`; inscrição em `POST /api/push/subscribe` (guarda `endpoint`/`p256dh`/`auth` em `PushSubscription`).
- O job `pushNotificationJob` (a cada 5 min) envia as notificações persistidas ainda não enviadas (`pushSent=false`) via `web-push` (VAPID). Ver [jobs-e-crons.md](jobs-e-crons.md).
- O service worker ([`frontend/src/sw.ts`](../../frontend/src/sw.ts)) exibe a notificação nativa e, ao clicar, abre a `actionUrl`.
- Usuários com `essentialNotificationsOnly=true` recebem **apenas** notificações críticas.

## Poda (jun/2026)

Para reduzir ruído com o sistema já maduro:

- **Removidos** os blocos computados `FLEX_CREDITS_LOW` (variante *info*, ≤2 créditos) e `CLIENT_INACTIVE`. Os sinais Flex relevantes (crédito perdido = critical; "grave esta semana" = warning) continuam vindo dos jobs como linhas persistidas.
- `BOOKING_UNCONFIRMED` passou a considerar **apenas o dia de hoje** — a véspera já é coberta pelo lembrete de 24h (`BOOKING_REMINDER`), evitando notificação dupla.
- Os valores de enum `CONTRACT_RENEWED`, `CLIENT_INACTIVE` e `SYSTEM` **não são mais produzidos**, mas permanecem no enum do Postgres (remover exigiria migração com `--accept-data-loss`). Ver [modelo-de-dados.md](modelo-de-dados.md).

## UI

No frontend, o sino ([`frontend/src/components/NotificationBell.tsx`](../../frontend/src/components/NotificationBell.tsx)) renderiza a lista como **dropdown no desktop** e como **bottom-sheet no mobile** (≤768px). Detalhes de uso em [guia-cliente/notificacoes-e-pwa.md](../guia-cliente/notificacoes-e-pwa.md).

## Relacionado

- [Jobs e crons](jobs-e-crons.md) · [Modelo de dados](modelo-de-dados.md) · [API](api.md)
