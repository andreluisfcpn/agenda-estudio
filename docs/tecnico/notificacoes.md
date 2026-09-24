# Notificações

O sistema combina notificações **computadas** (calculadas em tempo real a partir dos dados) e **persistidas** (gravadas na tabela `notifications` por jobs/efeitos). Endpoint principal: `GET /api/notifications` ([routes](../../backend/src/modules/notifications/routes.ts)).

## Dois tipos

### Computadas (tempo real)
Geradas a cada requisição de `GET /api/notifications`, sem persistir. Filtram por papel (admin vê de todos; cliente só as suas):

| Origem | Tipo | Severidade |
| --- | --- | --- |
| Contratos expirando (≤7d admin / ≤15d cliente) — `ACTIVE` ou `COMPLETED` (lembrete de renovação), **nunca AVULSO** | `CONTRACT_EXPIRING` | warning / critical (≤2d) |
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
- `BOOKING_UNCONFIRMED` passou a considerar **apenas o dia de hoje** — a véspera já é coberta pelo lembrete de 24h (`BOOKING_REMINDER`), evitando notificação dupla. Ressalva: sessões marcadas com menos de 24h de antecedência não recebem o lembrete de véspera (ver abaixo).
- Os valores de enum `CONTRACT_RENEWED`, `CLIENT_INACTIVE` e `SYSTEM` **não são mais produzidos**, mas permanecem no enum do Postgres (remover exigiria migração com `--accept-data-loss`). Ver [modelo-de-dados.md](modelo-de-dados.md).

## Lembretes de sessão (24h / 2h)

Decisão do dono (set/2026), que reverte o "nunca amanhã" anterior:

- **24h:** enviado **exatamente** 24h antes (mesmo horário, na véspera), com `{diaLabel}` = `amanhã (DD/MM)`.
- **2h:** enviado **exatamente** 2h antes, com `{diaLabel}` = `hoje (DD/MM)`.
- O rótulo vem de `spDayLabel` (`lib/spTime.ts`), sempre no **calendário SP** (entre 21h e meia-noite SP o dia UTC já virou): 0 dia → `hoje`, 1 dia → `amanhã`, outros → `<dia da semana> (DD/MM)` (fallback; o job não envia nesses casos). O job só envia o 24h se a sessão for "amanhã" no SP e o 2h se for "hoje".
- **Marcações tardias:** sessão criada depois do vencimento (com <24h de antecedência — possível, `booking_min_advance_hours` = 12) **não** recebe o de 24h (nunca sai atrasado); recebe o aviso das 7h do dia e o de 2h (se marcada com ≥2h). Vale também para reagendamentos que caiam a <24h.
- A "Prévia" e o "Enviar teste" do admin usam o exemplo **por evento** do catálogo: 24h → `amanhã (16/09)`, 2h → `hoje (16/09)`, `computed_booking_unconfirmed_admin` → `hoje` (valor usado em runtime).
- Overrides de template (`notification_templates`) não devem escrever "amanhã"/"hoje" literal ao lado de `{diaLabel}` (ficaria "amanhã amanhã (16/09)").
- Detalhes do agendamento (1 min alinhado, last-run, catch-up ≤60 min, dedup) em [jobs-e-crons.md](jobs-e-crons.md).

## Remarcação do avulso (set/2026)

Eventos persistidos da janela de remarcação sem novo pagamento (FALTA justificada / NÃO REALIZADO — `lib/avulsoMakeup.ts` e `jobs/avulsoMakeupExpiryJob.ts`). Reusam `NotificationType` existentes (sem migration). Variáveis novas: `{prazo}` (último dia, DD/MM) e `{novaData}`.

| eventKey | Público | Tipo | Severidade | Quando |
| --- | --- | --- | --- | --- |
| `avulso_makeup_opened` | cliente | `BOOKING_REMINDER` | warning | Admin justifica a falta ou marca "Não realizado" (janela abre) |
| `avulso_makeup_reminder` | cliente | `BOOKING_REMINDER` | critical | Nos 2 últimos dias da janela, no máximo 1 por dia SP |
| `avulso_makeup_expired` | cliente | `BOOKING_CANCELLED` | critical | Janela de FALTA expirou: valor perdido, contrato concluído |
| `avulso_makeup_expired_studio` | cliente | `BOOKING_REMINDER` | critical | Janela de NÃO REALIZADO expirou: valor garantido, o estúdio entra em contato |
| `admin_makeup_expired_studio` | admin | `BOOKING_UNCONFIRMED` | critical | Idem, para cada admin resolver (link para o contrato) |
| `admin_makeup_rescheduled` | admin | `BOOKING_CONFIRMED` | info | A gravação perdida foi remarcada (pelo cliente ou por um admin) |

Lembrete e expirações são `critical` para chegar também a quem escolheu "só essenciais". A dedup usa `dedupKey` com o id do booking (e o do admin nos eventos de admin); o lembrete diário tem ainda uma marca Redis própria (`makeup:reminded:<booking>:<dia SP>`, TTL 36h), porque a dedup de 6h dos `critical` sozinha deixaria sair até 4 lembretes no mesmo dia com o job de hora em hora.

## UI

No frontend, o sino ([`frontend/src/components/NotificationBell.tsx`](../../frontend/src/components/NotificationBell.tsx)) renderiza a lista como **dropdown no desktop** e como **bottom-sheet no mobile** (≤768px). Detalhes de uso em [guia-cliente/notificacoes-e-pwa.md](../guia-cliente/notificacoes-e-pwa.md).

## Relacionado

- [Jobs e crons](jobs-e-crons.md) · [Modelo de dados](modelo-de-dados.md) · [API](api.md)
