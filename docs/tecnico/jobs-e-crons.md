# Jobs e tarefas agendadas

Os cronjobs são registrados no boot do servidor em [`backend/src/index.ts`](../../backend/src/index.ts) via `setInterval` e ficam em [`backend/src/jobs/`](../../backend/src/jobs/) (a reconciliação Cora vive em `lib/`).

## Locks distribuídos (Redis)

Cada execução tenta adquirir um lock no Redis com `SET <chave> running EX <ttl> NX`. Se o lock já existe, a execução é pulada. Isso evita que **múltiplas instâncias** (ou execuções sobrepostas) rodem o mesmo job em paralelo. O lock é liberado no `finally`.

## Jobs registrados

| Job | Arquivo | Intervalo | Lock (chave / TTL) | Função |
| --- | --- | --- | --- | --- |
| Limpeza de holds | `cleanExpiredHolds.ts` | 60s | `cron:hold-cleanup:lock` / 50s | Remove bookings `HELD` e contratos `AWAITING_PAYMENT` cuja reserva expirou |
| Push de notificações | `pushNotificationJob.ts` | 5 min | `cron:push-notif:lock` / 280s | Envia notificações pendentes via Web Push |
| Lembretes de sessão | `bookingReminderJob.ts` | 30 min (+1x no boot) | `cron:booking-reminder:lock` / 1500s | Lembra 24h e 2h antes da gravação |
| Expiração de crédito Flex | `flexCreditExpiryJob.ts` | 6h (+1x no boot) | `cron:flex-credit-expiry:lock` / 1500s | Perde crédito semanal quando a janela fecha atrasada |
| Limpeza de notificações | `notificationCleanupJob.ts` | diário (+1x no boot) | `cron:notif-cleanup:lock` / 3600s | Remove notificações antigas |
| Reconciliação Cora | `lib/coraReconciliation.ts` | 2 min (+1x no boot) | `cron:cora-reconcile:lock` / 110s | Confirma PIX/boleto pagos cujo webhook não chegou |
| Cobrança automática | `autoChargeJob.ts` | diário (+1x no boot) | `cron:auto-charge:lock` / 1800s | Cobra cartões salvos (off-session) para parcelas vencidas |

## Detalhes

- **Limpeza de holds (60s):** garante que reservas não pagas em 10 min liberem o horário. É a contrapartida do `holdExpiresAt`/`paymentDeadline`.
- **Lembretes (24h/2h):** o lembrete de 24h cobre a véspera, por isso a notificação computada `BOOKING_UNCONFIRMED` foi enxugada para **apenas o dia de hoje** (ver [notificacoes.md](notificacoes.md)).
- **Crédito Flex:** o motor de "janela semanal" perde 1 crédito quando a semana fecha e o cliente está atrás do ritmo. Usa `flexForfeitFloor` como baseline para **não** punir retroativamente contratos antigos.
- **Reconciliação Cora (2 min):** rede de segurança para webhooks perdidos. Converge para `paymentEffects` (mesmos efeitos do webhook). Ver [pagamentos.md](pagamentos.md).
- **Cobrança automática (diária):** para clientes com `autoChargeEnabled`, cobra a próxima parcela no cartão salvo padrão.

## Relacionado

- [Pagamentos](pagamentos.md) · [Notificações](notificacoes.md) · [Arquitetura](arquitetura.md)
