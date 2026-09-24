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
| POST | `/refresh` | Cookie | Renova o par de tokens a partir do refresh cookie (401 `Sessão encerrada. Faça login novamente.` se o refresh token é anterior a uma revogação — exclusão/bloqueio) |
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
| PATCH | `/:id` | Autenticado | Atualiza (remarcar, notas, status; Falta/Não Realizado exigem motivo — admin) |
| PATCH | `/:id/client-update` | Autenticado | Atualizações do cliente (plataformas, notas) |
| PATCH | `/:id/reschedule` | Autenticado | Remarcação (janela de 7 dias) |
| PATCH | `/:id/makeup` | Cliente dono ou Admin | Remarca a gravação avulsa perdida (falta justificada / não realizada) sem novo pagamento |
| POST | `/:id/addons` | Autenticado | Adiciona serviços ao agendamento |
| POST | `/:id/complete-payment` | Autenticado | Conclui o pagamento de avulso |
| DELETE | `/:id` | Autenticado | Cancela (soft delete) |
| DELETE | `/:id/hard-delete` | Admin | Remoção definitiva (devolve crédito Flex) |
| POST | `/cleanup-orphan-addons` | Admin | Limpeza de add-ons órfãos |
| PATCH | `/:id/confirm` | Admin | Confirma a sessão (RESERVED→CONFIRMED) |
| PUT | `/:id/client-cancel` | Autenticado | Cliente cancela a própria sessão |
| PUT | `/:id/check-in` | Admin | Check-in da sessão |
| PUT | `/:id/complete` | Admin | Conclui a sessão (registra métricas) |
| PUT | `/:id/start-recording` | Admin | Inicia a gravação (registra o operador; obrigatório antes de finalizar) |

**Falta justificada / remarcação do avulso (D4/D5, [lib/avulsoMakeup.ts](../../backend/src/lib/avulsoMakeup.ts))**

- `PATCH /:id` (admin) aceita `noShowJustified?: boolean`. `{ status: 'FALTA', statusReason, noShowJustified: true }` em reserva de contrato **AVULSO** abre a janela (`makeupStatus: 'OPEN'`, `makeupDeadline` = fim do dia D+7 em SP, `missedDate` = D). 400 (sem trocar nada) se o status final não for FALTA, se o contrato não for avulso, se a remarcação já foi usada ou se o prazo já passou. `noShowJustified: false` retira a janela aberta. Marcar `NAO_REALIZADO` em avulso abre a janela **sozinho**. Saindo de FALTA/NAO_REALIZADO pelo admin: para CONFIRMED/RESERVED/COMPLETED a janela vira `USED`; para CANCELLED é retirada. A resposta (`booking`) já traz `makeupStatus`/`makeupDeadline`/`missedDate`.
- `PATCH /:id/makeup` body `{ date: 'YYYY-MM-DD', startTime: 'HH:MM' }` → `{ booking: { id, date, startTime, endTime, status: 'CONFIRMED', tierApplied, price, contractId, originalDate, statusReason, makeupStatus: 'USED', makeupDeadline, missedDate, holdExpiresAt, contract: { id, name, type, tier } }, message }`. Exige janela `OPEN` e dentro do prazo, nova data ≤ D+7, antecedência mínima `booking_min_advance_hours` (cliente) ou só "não no passado" (admin), dia de funcionamento e horário da grade na **mesma faixa**. Mesma trava/conflito/bloqueio do `/reschedule`. Reabre a MESMA reserva (mesmo Payment, sem cobrança). Exceção D5: o admin remarca um NAO_REALIZADO mesmo sem janela/depois do prazo e sem o teto D+7. Erros: 400 (regra), 404 (não é o dono), 409 (horário ocupado/bloqueado/em reserva, ou outra remarcação venceu).
- `GET /my` e `GET /:id` (cliente) incluem `originalDate`, `statusReason`, `makeupStatus`, `makeupDeadline`, `missedDate`.
- Toda transição de status (complete, client-cancel, DELETE, hard-delete, PATCH, makeup, job) chama `syncContractCompletion`: o contrato vira `COMPLETED`/volta a `ACTIVE` automaticamente (ver [modelo-de-dados.md](modelo-de-dados.md)).
- `POST /admin` sem `contractId` cria o avulso com `endDate` = dia da gravação e `paymentPlan: 'FULL'`; PIX grava o provedor resolvido (Sicoob ou Cora), não mais `CORA` fixo.
- **Cliente excluído (D3)** → **409 `{ error: 'Este cliente foi excluído…', code: 'CLIENT_DELETED' }`** (ou 409 `MakeupError`) em: `POST /admin` (`userId` excluído); `PATCH /:id` que reabre a gravação (→ RESERVED/HELD/CONFIRMED vindo de outro status), muda data/horário de uma gravação que fica ativa ou manda `noShowJustified: true`; `PATCH /:id/makeup` (inclusive o override D5 do admin). Marcar NAO_REALIZADO não abre janela para cliente excluído. Finalizar, marcar falta/não realizado, cancelar e editar notas/métricas continuam permitidos.
- **Avulso acompanha a gravação:** quando a reserva de um contrato **AVULSO** muda de data/horário (`PATCH /:id` com `date`/`startTime`, `PATCH /:id/reschedule` e `PATCH /:id/makeup`), o contrato passa a ter `startDate` = `endDate` = dia da nova gravação e o nome gerado vira `Avulso DD/MM/AAAA às HH:MM` (mantém o conector do nome atual, "às" ou "as"; nome fora desse padrão não muda). Outros tipos (inclusive o FLEX-1 legado) não são tocados (`syncAvulsoContractSchedule` em `booking.service.ts`).

## contracts — `/api/contracts` ([routes](../../backend/src/modules/contracts/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/slot-options?tier=` | Autenticado | Grade de horários válidos de contrato da faixa (D8) |
| POST | `/check-fixo` | Autenticado | Pré-valida dia/horário de contrato FIXO |
| POST | `/custom/check` | Autenticado | Pré-valida agenda personalizada |
| POST | `/` | Autenticado | Cria contrato (FIXO/FLEX/CUSTOM/AVULSO) |
| POST | `/self` | Autenticado | Renovação usando o contrato anterior como base |
| POST | `/custom` | Autenticado | Cria contrato personalizado |
| POST | `/service` | Autenticado | Contrata um serviço mensal (SERVICO) com pagamento inline |
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

- `PATCH /:id` (admin): `status` aceita `ACTIVE`, `EXPIRED`, `CANCELLED` e `COMPLETED` (concluir/reabrir à mão). `PENDING_CANCELLATION` **não** é aceito: esse estado vem do `POST /:id/request-cancellation`, que também cancela as sessões futuras. Ajustar `flexCreditsRemaining` sem `status` recalcula a conclusão.
  - Troca de `paymentMethod`: **os valores das cobranças não mudam** e nenhuma cobrança é regravada. O cartão cobra a base marcada na criação (`metadata.pixDiscount`) ou, sem a marca, o próprio `amount`, nunca a mais. Ver [pagamentos.md](pagamentos.md) › Desconto PIX só no PIX.
- Cobranças à vista com desconto PIX (`POST /`, `/self`, `/custom`, `/service`, `/:id/pay` do serviço à vista) gravam `metadata.pixDiscount = { pct, cardAmount, pixAmount }` (`cardAmount` = valor do cartão, sem o desconto PIX e com o mesmo cupom em R$). Cobrança de R$ 0 nunca recebe a marca.
- `POST /` (admin) com cupom que zera parcelas (100% ou VALOR ≥ total): as parcelas de R$ 0 nascem `PAID` (`paidAt` = agora) e a resposta traz `payments[].status: 'PAID'`. A 1ª passa por `onPaymentConfirmed` (uso do cupom `CONFIRMED`). Nada vai ao gateway nem ao auto-charge.
- `POST /:id/resolve-cancellation` com `CHARGE_FEE`: multa = `cancellation_fine_pct`% da soma do `amount` das cobranças **pagas** do contrato (sem juros do parcelamento nem a diferença do desconto PIX paga no cartão).
- `GET /my`: cada `payments[]` traz também `chargedAmount` e `providerRef` (o "total pago" soma o valor efetivamente cobrado).
- `POST /:id/renew` (admin) aceita `ACTIVE`, `EXPIRED` e `COMPLETED` (exceto avulso). `startDate` opcional `YYYY-MM-DD` (inválida → 400). As datas sem hora (`startDate`/`endDate`, meia-noite UTC) viram dia pelo ISO — nunca por `saoPauloParts`, que com o servidor em UTC dava o dia anterior; o `/resume` usa o dia de hoje em SP como início e o novo `endDate` pelo ISO como fim.
- **Cliente excluído (D3)** → 409 `code: 'CLIENT_DELETED'` em `POST /`, `POST /custom`, `POST /:id/renew`, `PATCH /:id/resume` e no `PATCH /:id` que reativa (`status: 'ACTIVE'`), muda `flexCreditsRemaining` ou `addOns`. `GET /` e `GET /:id` trazem `user.deletedAt` (a lista do admin mostra o selo "Cliente excluído" e esconde Renovar/Pausar/Retomar/Cobrar multa).
- `GET /my` e `GET /:id`: os `bookings` trazem `statusReason`, `makeupStatus`, `makeupDeadline`, `missedDate` (e `originalDate`).
- **Grade de horários de contrato (D8)** — fonte única em `utils/pricing.ts` (`getContractSlotGrid`, `checkSlotInGrid`), lida da BusinessConfig (`time_slots`, `comercial_slots`, `audiencia_slots`, `operating_days`, `slot_duration_hours`, `close_time`). SÁBADO só aos sábados; COMERCIAL/AUDIÊNCIA só seg–sex; a faixa superior usa os horários da inferior (AUDIÊNCIA = 10:00/13:00/15:30 + 18:00/20:30); o pacote precisa terminar até `close_time`.
  - `GET /slot-options?tier=COMERCIAL|AUDIENCIA|SABADO` → `{ tier, slotDurationHours, days: [{ dayOfWeek, slots: [{ time, end, tier }] }] }` na raiz (`dayOfWeek` 0=dom..6=sáb; `tier` do slot = faixa do horário). Faixa inválida → 400.
  - Horário/dia fora da grade → **400 `{ error: 'Horário inválido: … Horários válidos: …', code: 'INVALID_SLOT' }`** (nunca "conflito") em `check-fixo`, `custom/check`, `POST /` (FIXO + `resolvedConflicts[].newTime`), `/self` (1ª gravação, fixo e trocas) e `/custom` (`schedule`, `customDates`, trocas).
  - `check-fixo`: horários livres/sugestões seguem a hierarquia (não mais faixa idêntica) e os dias alternativos ficam só entre os dias permitidos da faixa.
  - `custom/check`: aceita também `frequency` (`WEEKLY` padrão, `BIWEEKLY`, `MONTHLY`, `CUSTOM`), `weekPattern` e `customDates`, e gera as **mesmas** ocorrências do `POST /custom` (`planCustomOccurrences`, com o teto de sessões). Conflito = pacote inteiro sobreposto a reserva/bloqueio; sugestão = outro horário válido da grade no mesmo dia. Resposta inalterada: `{ available, conflicts (≤20), totalConflicts, totalSessions }`.
- **`POST /custom` (D7/D9)**:
  - **Admin** (em nome do cliente via `userId`): contrato `ACTIVE`, sessões `CONFIRMED` (PROGRESSIVE: ciclos 2+ `RESERVED`), todas as parcelas `PENDING` (as de R$ 0, de cupom 100%, nascem `PAID`) e **nenhuma chamada ao gateway** — a cobrança sai pelo ChargeNowSheet (`/stripe/create-payment`) ou fica pendente. Todas as opções (frequências, início, 1–12 meses, cupom).
  - **Cliente**: só `frequency: WEEKLY`, `startDate` ≥ amanhã (SP; padrão = amanhã) e `durationMonths` ∈ {1, 3, 6, 9, 12} (senão 400). Contrato `AWAITING_PAYMENT` com `paymentDeadline` = agora + `config.studio.lockTtlSeconds` (10 min), sessões `RESERVED` (sem `holdExpiresAt`; ocupam a agenda) e **só a 1ª parcela** cobrada no gateway (PIX/boleto; cartão segue pelo checkout inline). PIX/boleto com CPF/CNPJ inválido → **400 `code: 'CPF_CNPJ_REQUIRED'` antes de criar qualquer coisa**; falha real do provedor → 502 com a mensagem (rollback total). Não pagou no prazo → a varredura `cleanExpiredHolds` apaga contrato, sessões e parcelas.
  - Anti-overbooking: ocorrência cujo pacote já está ocupado é **pulada** (como no FIXO do admin) e listada em `skipped: [{ date, time }]`; se todas estiverem ocupadas → 409 `ALL_SLOTS_TAKEN`.
  - Resposta 201: `{ contract, status, paymentDeadline (ISO|null), payments: [{ id, amount, dueDate, status }], summary: { …, totalBookingsGenerated, skippedOccurrences }, skipped, message, firstPaymentId, clientSecret?, firstPixString?, qrCodeDataUrl?, expiresAt? }`. `qrCodeDataUrl` (PNG em data URL) e `expiresAt` (ISO) só vêm no PIX do **cliente**: a validade do QR da 1ª parcela é o próprio `paymentDeadline` (10 min), e o checkout (`/stripe/create-payment` → `issuePixCharge`) reaproveita esse mesmo QR sem estender o prazo.
  - Desconto por **volume** (nº total de gravações), lido da BusinessConfig: ≥ `episodes_6months` → `discount_6months`; ≥ `episodes_3months` → `discount_3months`; abaixo → 0 (padrão 12/24 → 30%/40%). É a mesma régua exibida pelo assistente.
  - Antes de gerar as sessões (e antes do cupom), os personalizados `AWAITING_PAYMENT` **vencidos** (`paymentDeadline` < agora) do mesmo cliente são descartados pela rotina segura da varredura (`purgeAwaitingContract`: pago → ativa; em andamento → mantém; senão cancela a cobrança, libera o cupom e apaga). O mesmo vale para o `custom/check`, que aceita `userId?` (admin: cliente-alvo; sem ele o admin não descarta nada). Assim as sessões `RESERVED` de uma tentativa vencida não viram conflito nem prendem o cupom até a varredura passar.
  - Ao pagar a 1ª parcela, o contrato vira `ACTIVE` e as sessões `RESERVED` são promovidas a `CONFIRMED` (`paymentEffects.activateAwaitingContract`: FULL → todas; PROGRESSIVE → só o 1º ciclo). Com PAID encontrado pela varredura, idem.
- **`POST /service` (D1/D2)** — body `{ serviceKey, paymentMethod: 'PIX'|'CARTAO'|'BOLETO', durationMonths?, paymentPlan?: 'MONTHLY'|'FULL', couponCode?, cardSplit?: boolean }`.
  - `cardSplit: true` só com plano **MONTHLY + CARTAO** (senão **400**): cobra o **total** agora, parcelado em até N× **sem juros** (N = meses da fidelidade) — grava `paymentPlan: 'FULL'` (sem desconto PIX) e `Payment.metadata.installmentCap = N`. `FULL` → `installmentCap = 1` (PIX com desconto ou cartão 1×). MONTHLY sem `cardSplit` → mensalidade 1×/mês (como antes).
  - Contrato `AWAITING_PAYMENT` com `paymentDeadline` = agora + `config.studio.lockTtlSeconds` (**10 min**); o QR PIX expira junto. Antes de criar, uma contratação anterior **não paga** do mesmo usuário + serviço é descartada pela rotina segura da varredura (`purgeAwaitingContract`); se ela estiver paga → **409** ("já está ativo"); com pagamento em processamento → **409**.
  - Resposta 201: `{ contractId, firstPaymentId, amount, paymentDeadline (ISO), paymentPlan: 'MONTHLY'|'FULL', installmentCap?, couponDiscount?, clientSecret?, pixString?, expiresAt? (ISO, PIX), message }`. Cupom 100%: `{ contractId, firstPaymentId, amount: 0, alreadyPaid: true, couponDiscount, message }`.
- **`POST /:id/pay`** (contrato `AWAITING_PAYMENT` do próprio cliente) — `{ paymentMethod?: 'CARTAO'|'PIX' (padrão CARTAO), couponCode? }`.
  - PIX: usa `issuePixCharge` (reusa só a cobrança viva e com o mesmo valor; senão concilia/cancela e emite nova). Resposta `{ provider: 'SICOOB'|'CORA', paymentId, pixString, qrCodeDataUrl, qrCodeBase64, expiresAt (ISO), amount, reused, couponDiscount?, message }`; se a conciliação achar a cobrança já paga: `{ provider, paymentId, amount, alreadyPaid: true, message }`.
  - Cartão numa linha que tinha PIX: aposenta o PIX vivo antes (se já pago → `{ …, alreadyPaid: true }`) e limpa `pixString/pixExpiresAt`.
- **`POST /:id/client-renew`**: aceita `ACTIVE`, `EXPIRED` e **`COMPLETED`** (D6; exceto avulso). `COMPLETED` é tratado como `ACTIVE`: janela dos últimos 7 dias e início no fim do contrato atual. Prazo de pagamento da renovação continua 3 dias.

## users — `/api/users` ([routes](../../backend/src/modules/users/routes.ts)) · Admin

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/` | Lista usuários (exclui os excluídos: `deletedAt: null`); `contracts[]` = `{ type, status, addOns, endDate, durationMonths }` (plano Concluído vigente — `isPlanInForce`); `totalPaid` = soma do valor **efetivamente cobrado** das pagas, `totalPending` = soma do `amount` das pendentes |
| GET | `/:id` | Detalhe do usuário (inclui `deletedAt` — perfil histórico de cliente excluído); `payments[]` traz `chargedAmount`, `provider` e `providerRef` |
| POST | `/` | Cria usuário |
| PATCH | `/:id` | Atualiza usuário (409 se excluído) |
| GET | `/:id/deletion-preview` | Consequências reais da exclusão (para o modal) |
| DELETE | `/:id` | Exclui o cliente: físico sem vínculos, soft delete + anonimização com vínculos |
| GET | `/:id/payment-overview` | Resumo financeiro do cliente |
| PATCH | `/:id/auto-charge` | Liga/desliga cobrança automática (409 se excluído) |

**Exclusão de cliente (D3, [lib/userDeletion.ts](../../backend/src/lib/userDeletion.ts))**

- Vínculo de negócio = contratos, agendamentos, pagamentos, resgates de cupom, bloqueios de agenda criados.
  Notificações, push, cartões salvos e elegibilidade de cupom são acessórios (apagados em qualquer modo).
- Sem vínculo → `user.delete` físico (acessórios por CASCADE). Um vínculo criado em corrida (P2003) cai no soft.
- Com vínculo → soft delete, sem bloquear por pendências: contratos ACTIVE/PAUSED/AWAITING_PAYMENT/
  PENDING_CANCELLATION → CANCELLED com parcelas PENDING anuladas (`voidContractPendingPayments`); demais
  PENDING do cliente (inclusive sem contrato) → CANCELLED com o cupom reservado devolvido; gravações futuras
  RESERVED/HELD/CONFIRMED → CANCELLED (travas Redis liberadas); janelas de remarcação OPEN → EXPIRED;
  `autoChargeEnabled=false`; cartões desvinculados no Stripe (best-effort). Numa transação: `deletedAt`,
  e-mail/googleId/senha/CPF/telefone/endereço/foto/redes/notas → null, `tags=[]` (ficam `name` e
  `stripeCustomerId`); apaga push, cartões, elegibilidade de cupom e notificações. AuditLog `USER`
  `SOFT_DELETED`/`DELETED` só com contagens (sem dados pessoais). Pagamentos PAID ficam intactos.
- Antes de anular, cada cobrança PENDING com `providerRef` é conciliada e cancelada no provedor (contrato:
  `settleContractCharges`; sem contrato: `retirePixCharge` / PaymentIntent). Pago no provedor → fica PAID
  (entra em `paidDuringDeletion`). Em andamento — cartão `processing` ou 3DS < 30 min, provedor fora do ar,
  PIX que continua pagável (`retirePixCharge` → `live`, com ou sem contrato) — → **409** `Há um pagamento
  deste cliente em processamento no provedor…` sem anular nada (cobrança automática e sessão restauradas).
- Gravações canceladas = RESERVED/HELD/CONFIRMED sem `recordingStartedAt` cujo início (data + hora SP) ainda
  não chegou; as de hoje já iniciadas ficam para o operador.
- Recusas (mesmas no preview e no DELETE): 400 auto-exclusão ou conta ADMIN · 404 inexistente ·
  409 já excluído ou exclusão em andamento.
- `GET /:id/deletion-preview` → `{ preview: { userId, name, mode: 'hard'|'soft',
  links: { contracts, bookings, payments, couponRedemptions, blockedSlots },
  pending: { activeContracts, futureBookings, pendingPayments, pendingAmount },
  preserved: { paidPayments, paidAmount }, accessories: { savedCards, pushSubscriptions, notifications,
  couponEligibilities, autoChargeEnabled } } }` (valores em centavos; `paidAmount` = valor efetivamente
  cobrado das pagas — no cartão, o do PaymentIntent).
- `DELETE /:id` → `{ message, softDeleted, cancelled: { contracts, bookings, payments }, paidDuringDeletion: { payments, amount } }`
  (no front, `usersApi.remove` tipa `paidDuringDeletion?`; hard delete devolve `{ payments: 0, amount: 0 }`).
  `paidDuringDeletion` = cobranças PENDING na abertura que foram confirmadas no provedor durante a exclusão
  (centavos); ficam PAID, sem estorno automático, e a `message` ganha `Atenção: N pagamento(s) (R$ X) …`.
- Conta excluída: login (senha/OTP/Google) e `POST /api/auth/refresh` → 401 `Conta não encontrada.`;
  `GET /api/auth/me`, `PATCH /api/auth/profile` e `POST /api/auth/profile/photo` → 404. `createNotification`
  ignora contas excluídas.
- Sessão encerrada **na hora** (excluir ou bloquear): `revokeUserSessions` grava `auth:revoked:<userId>` no
  Redis (instante da revogação; TTL = validade do access token + 60 s). O `authenticate` responde 401
  `Sessão encerrada. Faça login novamente.` a todo access token com `iat` ≤ esse instante, e o
  `POST /api/auth/refresh` recusa (401, mesma mensagem) refresh token anterior a ele — fecha a corrida de um
  refresh no meio da exclusão (o `deletedAt` só é gravado no fim). Com a exclusão em andamento (mutex
  `mutex:user-delete:<userId>`), o login por senha/OTP/Google responde **409** `Não foi possível entrar
  agora…` sem emitir sessão. A exclusão revoga no início e de novo **depois do commit** (soft e hard), com
  folga de 60 s para login/refresh que leram o usuário antes. Redis fora/lento (> 500 ms) → fail-open (as
  guardas do banco continuam valendo).

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
| GET | `/summary` | Admin | Resumo financeiro (receita paga pelo valor efetivamente cobrado — `paidChargedAmount`) |
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

- **`POST /create-payment`** — `{ paymentId, paymentMethod?: 'cartao'|'pix'|'boleto', installments?, savedPaymentMethodId?, savePaymentMethod? }`.
  - **PIX** (D15, `issuePixCharge`): `{ provider: 'SICOOB'|'CORA', pixString, qrCodeDataUrl ('data:image/png;base64,…'), qrCodeBase64 (compat, sem prefixo), expiresAt (ISO), amount (centavos), reused, alreadyPaid: false, paymentId }`. Reusa só a cobrança viva, com BR Code válido e o mesmo valor; senão concilia a anterior, cancela e emite nova (txid com sufixo de tentativa). Se a conciliação achar a cobrança paga: `{ provider, status: 'PAID', alreadyPaid: true, amount, paymentId }`. Erros (CPF ausente, provedor desligado, falha) → 400 `{ error }`.
  - **Cartão**: `installments` limitado pela política (inclui `metadata.installmentCap` do serviço); juros só acima de `freeUpTo`. Parcelamento só é habilitado no PI quando `installments > 1`; com **cartão salvo** o plano `fixed_count` vai de fato ao Stripe (se o cartão não oferece N× → erro, nada é cobrado). Se a linha tinha PIX vivo, ele é aposentado antes (já pago → **400** `{ error, status: 'PAID', alreadyPaid: true }`). Resposta: `{ provider: 'STRIPE', clientSecret, paymentIntentId, amount, installments }` — `amount` = valor do PI (= `chargedAmount`: a base do cartão, sem o desconto PIX do à vista, com juros quando parcelado); o checkout exibe este valor.
  - Valor base do cartão = `cardChargeBaseAmount`: `metadata.pixDiscount.cardAmount` quando a cobrança tem a marca (e ela não caducou); senão o próprio `amount`. Não há fallback legado: cobrança antiga sem a marca sai pelo `amount`, abaixo do preço de cartão e nunca acima (ver pagamentos.md). Valor 0 → 0 (nunca vai ao cartão).
  - **PI anterior da mesma cobrança** (`providerRef` pi_…, inclusive de uma linha `FAILED` reaberta): `succeeded`/`processing`/`requires_capture` → **409** `{ error, code: 'CARD_PAYMENT_IN_FLIGHT' }` e nenhum PI novo; pagável com **outro valor** → cancelado antes de criar o novo; não foi possível consultar/cancelar → **503**. O mesmo vale no cartão do `POST /contracts/:id/pay` (que reaproveita o PI pagável de mesmo valor).
  - Pagamento `FAILED` é reaberto (`PENDING`) limpando `providerRef/pixString/pixExpiresAt/boletoUrl/chargedAmount`.
- **`POST /installment-plans`** — `{ paymentId? , amount?, contractDurationMonths?, installmentCap? (1–12) }` → `{ plans: [{ count, perInstallment, total, feePercent, freeOfCharge }] }`. Com `paymentId`, a política vem do pagamento (serviço com teto → só 1..N, todas sem juros). Sem `paymentId`, `installmentCap` permite a prévia do serviço (ex.: `installmentCap: 3` → 1x–3x sem juros; `1` → só 1x). Com `paymentId`, o valor é `cardChargeBaseAmount` (a base marcada ou o `amount`); valor 0 → **400** `{ error: 'Valor inválido.' }`.

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
| GET | `/closing/:year/:month` | Fechamento mensal (bruto, taxas por provedor, líquido, pendente) — bruto do pago = valor efetivamente cobrado (`chargedAmount` quando a cobrança paga foi a do cartão; senão `amount`); pendente pelo `amount` |

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
