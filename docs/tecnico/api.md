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
| GET | `/my` | Autenticado | Lista os agendamentos do usuário (visão do cliente) |
| GET | `/:id` | Dono | Um agendamento do próprio usuário (visão do cliente) |
| GET | `/` | Autenticado | Lista agendamentos (admin vê todos) |
| PATCH | `/:id` | Autenticado | Atualiza (remarcar, notas, status; Falta/Não Realizado exigem motivo — admin) |
| PATCH | `/:id/client-update` | Dono | Cliente edita o episódio (título, descrição, redes) enquanto a gravação não foi finalizada/cancelada |
| POST | `/:id/cover-image` | Dono | Envia a capa do episódio (multipart `cover`; mesma regra de edição) |
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
| PUT | `/:id/undo-start-recording` | Admin | Desfaz um "Iniciar gravação" clicado por engano (zera início e operador) |

**Falta justificada / remarcação do avulso (D4/D5, [lib/avulsoMakeup.ts](../../backend/src/lib/avulsoMakeup.ts))**

- `PATCH /:id` (admin) aceita `noShowJustified?: boolean`. `{ status: 'FALTA', statusReason, noShowJustified: true }` em reserva de contrato **AVULSO** abre a janela (`makeupStatus: 'OPEN'`, `makeupDeadline` = fim do dia D+7 em SP, `missedDate` = D). 400 (sem trocar nada) se o status final não for FALTA, se o contrato não for avulso, se a remarcação já foi usada ou se o prazo já passou. `noShowJustified: false` retira a janela aberta. Marcar `NAO_REALIZADO` em avulso abre a janela **sozinho**. Saindo de FALTA/NAO_REALIZADO pelo admin: para CONFIRMED/RESERVED/COMPLETED a janela vira `USED`; para CANCELLED é retirada. A resposta (`booking`) já traz `makeupStatus`/`makeupDeadline`/`missedDate`.
- `PATCH /:id/makeup` body `{ date: 'YYYY-MM-DD', startTime: 'HH:MM' }` → `{ booking: { id, date, startTime, endTime, status: 'CONFIRMED', tierApplied, price, contractId, originalDate, statusReason, makeupStatus: 'USED', makeupDeadline, missedDate, holdExpiresAt, contract: { id, name, type, tier } }, message }`. Exige janela `OPEN` e dentro do prazo, nova data ≤ D+7, antecedência mínima `booking_min_advance_hours` (cliente) ou só "não no passado" (admin), dia de funcionamento e horário da grade na **mesma faixa**. Mesma trava/conflito/bloqueio do `/reschedule`. Reabre a MESMA reserva (mesmo Payment, sem cobrança). Exceção D5: o admin remarca um NAO_REALIZADO mesmo sem janela/depois do prazo e sem o teto D+7. Erros: 400 (regra), 404 (não é o dono), 409 (horário ocupado/bloqueado/em reserva, ou outra remarcação venceu).
- `GET /my` e `GET /:id` (cliente) incluem `originalDate`, `statusReason`, `makeupStatus`, `makeupDeadline`, `missedDate`.

**Desfazer o início da gravação (lote 2)**

- **`PUT /:id/undo-start-recording`** (admin) — desfaz um "Iniciar gravação" clicado por engano: zera `recordingStartedAt`, `recordingStartedById` e `recordingStartedByName`. O cliente deixa de ver "AO VIVO" (`isRecordingNow` volta a `false`) e a sessão volta a exigir "Iniciar gravação" antes de finalizar. Sem corpo.
  - 200 `{ booking, message: 'Início da gravação desfeito.' }`; gravação que não estava iniciada → 200 `{ booking, message: 'A gravação não estava iniciada.' }` (idempotente, nada é gravado).
  - Só em `CONFIRMED`: qualquer outro status (inclusive `COMPLETED`, já finalizada) → **409** `{ error, code: 'RECORDING_UNDO_NOT_ALLOWED' }`. A escrita é guardada pelo status, então uma finalização concorrente cai no 409 e o início não se perde. 404 se o agendamento não existe; 403 para não-admin.
  - O início desfeito (quando, quem) fica em `audit_logs` (`entityType BOOKING`, `action RECORDING_START_UNDONE`).
- **`PUT /:id/start-recording`** (admin) — só em `CONFIRMED` e **só no dia da sessão ou depois**: sessão FUTURA (data posterior a hoje no calendário de São Paulo) → **400** `{ error: 'Só é possível iniciar a gravação no dia da sessão.', code: 'RECORDING_START_FUTURE' }`, nada é gravado. Sessão de hoje ou passada segue permitida (Iniciar → Finalizar retroativo). Já iniciada → 200 idempotente (mantém o início original).
- **`PUT /:id/complete`** (admin) — a 1ª finalização é **condicional** ao estado lido (mesmo status + `recordingStartedAt` ainda preenchido):
  - o início foi desfeito ou o status mudou em outra tela entre a leitura e a escrita → **409** `{ error, code: 'RECORDING_STATE_CHANGED' }`, nada é gravado e o contrato não é concluído;
  - outro operador (ou um duplo clique) já finalizou → **200** `{ booking, message }` com a reserva atual, sem regravar;
  - regravar métricas de uma gravação já `COMPLETED` continua incondicional.
  - `durationMinutes` omitido → derivado de Iniciar → Finalizar; se o intervalo passar de **12 h** (início antigo esquecido), a derivação é ignorada e a duração fica vazia até o operador informar.

**Visão do cliente sobre a gravação (lote 2 — E11/E12, [booking.clientView.ts](../../backend/src/modules/bookings/booking.clientView.ts))**

Toda rota em que o **cliente** recebe uma reserva devolve o MESMO objeto (`CLIENT_BOOKING_SELECT` + `toClientBooking`): `GET /my` (`bookings[]`), `GET /:id` (`booking`), `GET /availability` (`myBookings[]`) e as respostas de `PATCH /:id/client-update`, `POST /:id/cover-image`, `PATCH /:id/reschedule` e `PATCH /:id/makeup` feito pelo cliente (`booking`).

- **Nunca** traz `adminNotes` (nota interna do estúdio) nem quem operou a gravação (`recordingStartedById`/`recordingStartedByName`). As rotas exclusivas do admin (`GET /`, `PATCH /:id`, `PUT /:id/complete`, `PUT /:id/start-recording`…) continuam devolvendo `adminNotes`.
- Campos: `id`, `date`, `startTime`, `endTime`, `status`, `tierApplied`, `price`, `contractId`, `clientNotes` (feedback do estúdio ao cliente — só leitura), `episodeTitle`, `episodeDescription`, `coverImageUrl`, `platforms` (string JSON, array de redes), `platformLinks` (string JSON `{ REDE: url }`; `GRAVACAO` = link da gravação não transmitida), `durationMinutes`, `peakViewers`, `chatMessages`, `audienceOrigin`, `isLivestream`, `streamMetrics` (string JSON `{ REDE: { views, peak, subscribers, likes, comments } }`), `recordingStartedAt`, `addOns`, `holdExpiresAt`, `originalDate`, `statusReason`, `makeupStatus`, `makeupDeadline`, `missedDate`, `contract: { id, name, type, tier, discountPct, addOns }`.
- Derivados (calculados na resposta):
  - `isRecordingNow` — **"gravando agora"**: `status === 'CONFIRMED'` + `recordingStartedAt` preenchido (o admin clicou "Iniciar Gravação") e ainda não finalizada. É o único critério do selo "AO VIVO" do cliente; `isLivestream` ("foi transmitida ao vivo") é um atributo permanente e **não** indica gravação em andamento. Teto de segurança: deixa de valer `RECORDING_LIVE_MAX_HOURS` (6 h) depois do início, para um "Finalizar" esquecido não prender o selo.
  - `recordingFinishedAt` — fim da gravação = `recordingStartedAt` + `durationMinutes`, só em `COMPLETED` (não há coluna própria; `null` se faltar início ou duração).
  - `canEditEpisode` / `editBlockedReason` — se o cliente ainda pode editar o episódio e, quando não pode, a mensagem (a mesma do 409 abaixo).
- `PATCH /:id/client-update` body `{ episodeTitle?, episodeDescription?, platforms? }` → `{ booking, message }`.
  - Só o **dono** (404 para qualquer outro usuário, inclusive admin) e só com a reserva em `RESERVED`, `HELD` ou `CONFIRMED` (inclusive durante a gravação). `COMPLETED`, `CANCELLED`, `FALTA` e `NAO_REALIZADO` → **409 `{ error, code: 'BOOKING_NOT_EDITABLE' }`**, sem gravar nada (a escrita é um `updateMany` guardado pelo status: finalização/cancelamento concorrente também cai no 409).
  - `episodeTitle`: texto de uma linha (espaços/quebras colapsados), máx. 140; `episodeDescription`: máx. 4000; `''` ou `null` limpam o campo. `platforms`: string JSON com array de `YOUTUBE`/`INSTAGRAM`/`FACEBOOK`/`TIKTOK` (normalizado, sem repetição). Inválido → 400 com a mensagem do campo em `error` (pt-BR) e `details`.
  - Campos fora dessa lista são **ignorados** (não dão erro): `clientNotes` (feedback do estúdio), `platformLinks`, métricas, status, preço.
- `POST /:id/cover-image` (multipart, campo `cover`; JPG/PNG/WEBP/AVIF/HEIC até 12 MB) → `{ coverImageUrl, booking, message }`. Mesma regra de dono/status (404 / 409 `BOOKING_NOT_EDITABLE`). 400 sem arquivo, formato não aceito ou imagem ilegível; 413 acima de 12 MB.
- `PATCH /:id/reschedule` → `{ booking, message }` com `booking` na visão do cliente (superconjunto do retorno anterior).
- **"Iniciar Gravação" vale para a sessão daquele dia/horário:** remarcar uma sessão aberta (`PATCH /:id` do admin mudando `date`/`startTime` com status final `RESERVED`/`HELD`/`CONFIRMED`, `PATCH /:id/reschedule` e `PATCH /:id/makeup`) zera `recordingStartedAt`/`recordingStartedById`/`recordingStartedByName` — o operador inicia de novo na nova data. Corrigir a data de uma gravação já finalizada preserva o registro.
- Toda transição de status (complete, client-cancel, DELETE, hard-delete, PATCH, makeup, job) chama `syncContractCompletion`: o contrato vira `COMPLETED`/volta a `ACTIVE` automaticamente (ver [modelo-de-dados.md](modelo-de-dados.md)).
- **Extras da gravação cancelada (lote 2):** quando a gravação de um **plano** (contrato FIXO/FLEX/CUSTOM) passa a `CANCELLED` — `PUT /:id/client-cancel` e `DELETE /:id` (pelo admin; pelo cliente, reserva `RESERVED`/`HELD` a qualquer tempo ou `CONFIRMED` com 24 h ou mais — abaixo disso vira `FALTA` e nada é anulado), `PATCH /:id` do admin com `status: 'CANCELLED'` — ou é apagada por `DELETE /:id/hard-delete`, as cobranças `PENDING`/`FAILED` dos **extras** dela (`Payment` com `contractId` + `bookingId`) são anuladas pela mesma sequência do cancelamento do contrato (`voidContractPendingPaymentsDetailed(contractId, { bookingIds: [id] })`, via `voidExtrasOfCancelledBooking` em `booking.service.ts`): a cobrança viva é aposentada no provedor antes; PIX/cartão já pago vira `PAID` (não é anulado); extra já `PAID` fica intocado, sem estorno automático.
  - Resposta: `voidedExtras` (número) em `client-cancel`, `DELETE /:id` e `hard-delete`; no `PATCH /:id` só quando > 0. Quando > 0 a `message` ganha " N cobrança(s) de serviços extras desta gravação foi/foram cancelada(s).".
  - Best-effort: uma falha na anulação vai para o log e não desfaz o cancelamento (`voidedExtras: 0`).
  - No `hard-delete` a anulação roda **antes** de apagar (a FK zera o `bookingId` do pagamento; um extra pendente sem `bookingId` passaria a parecer parcela do plano).
  - **Não** anula: remarcação (`PATCH /:id` só com data/horário, `/reschedule`, `/makeup`), aviso com menos de 24 h (vira `FALTA`) e gravação **AVULSA** (a cobrança da própria reserva segue o fluxo do avulso, inalterado).
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
| POST | `/:id/subscribe` | Autenticado | Ativa a cobrança automática do cliente com o cartão informado (E9 — sem assinatura Stripe) |
| POST | `/:id/client-renew` | Autenticado | Cliente inicia a renovação |

- `PATCH /:id` (admin): `status` aceita `ACTIVE`, `EXPIRED`, `CANCELLED` e `COMPLETED` (concluir/reabrir à mão). `PENDING_CANCELLATION` **não** é aceito: esse estado vem do `POST /:id/request-cancellation`, que também cancela as sessões futuras. Ajustar `flexCreditsRemaining` sem `status` recalcula a conclusão.
  - `paymentMethod: 'BOLETO'` (E3): trocar a forma do contrato para boleto exige o boleto **efetivo** (chave-mestra ligada **e** Cora habilitada) → senão **400** `{ error, code: 'BOLETO_UNAVAILABLE', reason: 'SWITCH_OFF'|'PROVIDER_DISABLED' }`, antes de qualquer efeito e sem gravar nada do PATCH. Reenviar `BOLETO` num contrato que já era boleto não é troca e não bloqueia. `boletoAllowed` no corpo é **ignorado** (não é gravado).
  - `addOns` (troca de serviços, FIXO/FLEX ativos): repreça só as parcelas `PENDING` do plano (nunca extras de gravação nem a multa de cancelamento). No à vista, a marca `metadata.pixDiscount = { pct, cardAmount, pixAmount }` é regravada com os dois preços do total **novo**, seja qual for a forma do contrato (E2): criado no PIX, `amount` = `pixAmount`; criado no cartão/boleto, `amount` = `cardAmount` e o PIX continua saindo com o desconto. Parcela repreçada com **PaymentIntent** já emitido pelo valor antigo: o PI pagável é cancelado e `providerRef`/`chargedAmount` são zerados; PI aprovado/em processamento ou não consultável → a parcela fica no valor antigo (como o QR PIX que não pôde ser cancelado).
  - Troca de `paymentMethod`: **os valores das cobranças não mudam** e nenhuma cobrança é regravada. O cartão cobra a base marcada na criação (`metadata.pixDiscount`) ou, sem a marca, o próprio `amount`, nunca a mais. Ver [pagamentos.md](pagamentos.md) › Desconto PIX só no PIX.
- **Toda** cobrança à vista (`POST /`, `/self`, `/custom`, `/service`, `/:id/pay` do serviço à vista), seja qual for a forma de pagamento (E2), grava `metadata.pixDiscount = { pct, cardAmount, pixAmount }`: `cardAmount` = preço de cartão/boleto, `pixAmount` = preço PIX, os dois com o mesmo cupom em R$. Criada no PIX, `amount` = `pixAmount`; criada no Cartão/Boleto, `amount` = `cardAmount` (o PIX ganha o desconto ao emitir o QR). Cobrança de R$ 0, ou cujo preço PIX zeraria, nunca recebe a marca.
- **Boleto (E3)**: `POST /` (admin) e `POST /custom` (admin) com `paymentMethod: 'BOLETO'` exigem o boleto **efetivo** (chave-mestra ligada **e** Cora habilitada) → senão **400** `{ error, code: 'BOLETO_UNAVAILABLE', reason: 'SWITCH_OFF'|'PROVIDER_DISABLED' }` antes de criar qualquer coisa. `POST /self`, `POST /service`, `POST /custom` do **cliente** e `POST /:id/client-renew` **nunca** aceitam boleto (contratação com prazo de pagamento) → **400** `{ error, code: 'BOLETO_NOT_ALLOWED_HERE' }`. `boletoAllowed` (no corpo e na coluna `Contract.boletoAllowed`) não é mais autoridade — é ignorado.
- `POST /` (admin) com cupom que zera parcelas (100% ou VALOR ≥ total): as parcelas de R$ 0 nascem `PAID` (`paidAt` = agora) e a resposta traz `payments[].status: 'PAID'`. A 1ª passa por `onPaymentConfirmed` (uso do cupom `CONFIRMED`). Nada vai ao gateway nem ao auto-charge.
- **Cancelamento e multa (E13)** — regra completa em [pagamentos.md](pagamentos.md#cancelamento-de-contrato-e-multa-e13). Valores em centavos.
  - `POST /:id/request-cancellation` (dono, contrato `ACTIVE`): congela a multa (% vigente × o que falta pagar do plano) e cancela só as gravações que ainda não começaram. Resposta: `{ contract, message, cancelledBookings, fine: { finePct, baseAmount, amount } }`; `contract` já traz `cancellationRequestedAt`, `finePct`, `fineBaseAmount`, `fineAmountPreview`. Contrato não ativo → 400. As cobranças `PENDING`/`FAILED` de **extras** (`bookingId`) das gravações que o próprio pedido cancelou são anuladas na hora (`voidedExtras` na resposta), aposentando antes a cobrança viva no provedor — PIX/cartão já pago fica `PAID`; extras de gravações já realizadas continuam pagáveis. A `message` diz o motivo verdadeiro do "sem multa": nada em aberto ("Não há parcelas do plano em aberto…") ou percentual zerado ("O cancelamento não tem multa.").
  - `POST /:id/resolve-cancellation` `{ action: 'CHARGE_FEE' | 'WAIVE_FEE' }` (admin): `CHARGE_FEE` cria a multa (`metadata.kind = 'CANCELLATION_FINE'`, `PENDING`) sobre a **base efetiva** = mínimo entre a congelada no pedido e o que ainda falta pagar (parcela da base paga durante a análise sai dela; `fine.baseAmount` e `metadata.baseAmount` trazem essa base); base 0 ou `WAIVE_FEE` → sem cobrança. Resposta: `{ contract, message, fine: { id, amount, status, dueDate, finePct, baseAmount } | null, voidedCount, paidAtProvider, liveAtProvider }`. Contrato que não está (mais) em `PENDING_CANCELLATION` — lista defasada, outro admin, duplo clique — → **409** `{ error, code: 'CANCELLATION_NOT_PENDING' }` ("Este pedido de cancelamento já foi resolvido." quando `CANCELLED`; "O contrato não está mais aguardando cancelamento." nos demais), sem nenhum efeito. A decisão é serializada por contrato (trava Redis, com o status relido dentro dela): outra requisição de cancelamento do mesmo contrato ainda em andamento depois de ~15 s → **409** `{ error, code: 'CANCELLATION_IN_PROGRESS' }`. Se o contrato já tinha uma multa em aberto de um cancelamento anterior (reaberto e cancelado de novo) e a decisão gera multa nova, a anterior é anulada antes (nunca duas em aberto); sem multa nova ela continua devida e a `message` avisa.
  - `DELETE /:id` (admin): `{ message, voidedCount, cancelledBookings, paidAtProvider, liveAtProvider }`. `paidAtProvider` = cobranças que o provedor confirmou como pagas na anulação (ficaram `PAID`); `liveAtProvider` = cobranças anuladas que não puderam ser canceladas no provedor agora. O `PATCH /:id` que **cancela** (`status: 'CANCELLED'` num contrato ainda não cancelado) responde igual: `{ contract, message, voidedCount, cancelledBookings, paidAtProvider, liveAtProvider }`, com a nota do provedor na `message`; os demais `PATCH` seguem com `{ contract, message }`. `DELETE` e esse `PATCH` usam a mesma trava da decisão (→ 409 `CANCELLATION_IN_PROGRESS` se ocupada) e **nunca** anulam a multa de cancelamento.
  - Pedido, `DELETE` e `PATCH` com `status: 'CANCELLED'` avisam o cliente e só cancelam gravações `RESERVED`/`CONFIRMED`/`HELD` com início futuro (relógio de SP).
- **Campos de cancelamento/multa** em cada contrato de `GET /` (admin), `GET /:id` e `GET /my`:
  - `paidTotal` — total efetivamente pago no contrato; `remainingTotal` — o que falta pagar do plano agora;
  - `finePct`, `fineBaseAmount`, `fineAmountPreview` — a multa: a do pedido em análise (% congelado × base efetiva — cai se uma parcela da base for paga, nunca aumenta), a gerada (cancelado) ou a prévia de hoje (demais status);
  - `cancellationRequestedAt`, `cancelledAt` (ISO ou `null`; `cancelledAt` só com status `CANCELLED` — contratos antigos usam a última atualização);
  - `cancellationFine` — `{ id, amount, status, dueDate, paidAt, finePct, baseAmount }` ou `null`.
- **Renovação (E4)** — `GET /` (admin) e `GET /:id` trazem `alreadyRenewed` (existe renovação não cancelada), `renewedToId`, `daysToEnd` (dias no calendário de SP até o fim da vigência; negativo = encerrada) e `canRenew`: plano (nunca `AVULSO`/`SERVICO`), cliente não excluído, ainda não renovado e (`ACTIVE`/`COMPLETED` com `daysToEnd` ≤ 30, ou `EXPIRED`). `GET /my` traz só `alreadyRenewed`.
- `GET /my`: cada `payments[]` traz `chargedAmount` e `providerRef` (o "total pago" soma o valor efetivamente cobrado), `paidAt`, `pixExpiresAt`, `bookingId` e **`kind`** (`'CANCELLATION_FINE'` ou `null`) — o `metadata` não sai. Os `bookings` **não** trazem `adminNotes` (nota interna); trazem `clientNotes`, `recordingStartedAt`, `episodeTitle`, `coverImageUrl` e as métricas (`durationMinutes`, `peakViewers`, `chatMessages`, `audienceOrigin`, `isLivestream`, `streamMetrics`).
- `GET /:id`: `payments[]` com `kind`; `user.cpfCnpj`, `bookings[].adminNotes` e `bookings[].recordingStartedByName` **só para o admin** (o dono do contrato não os recebe).
- `POST /:id/renew` (admin) aceita `ACTIVE`, `EXPIRED` e `COMPLETED`; **`AVULSO` e `SERVICO` → 400** (não são renováveis por aqui). A janela de 30 dias do botão não é imposta pela rota. `startDate` opcional `YYYY-MM-DD` (inválida → 400). As datas sem hora (`startDate`/`endDate`, meia-noite UTC) viram dia pelo ISO — nunca por `saoPauloParts`, que com o servidor em UTC dava o dia anterior; o `/resume` usa o dia de hoje em SP como início e o novo `endDate` pelo ISO como fim.
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
  - `cardSplit: true` só com plano **MONTHLY + CARTAO** (senão **400**): cobra o **total** agora, parcelado em até N× **sem juros** (N = meses da fidelidade) — grava `paymentPlan: 'FULL'` e `Payment.metadata.installmentCap = N`. `FULL` → `installmentCap = 1` (PIX com desconto ou cartão 1×). MONTHLY sem `cardSplit` → mensalidade 1×/mês (como antes). Toda cobrança única (`FULL`, inclusive o `cardSplit`) leva a marca `pixDiscount` dos dois preços (E2): no cartão cobra o total; se o cliente trocar para o PIX no checkout, o QR sai com o desconto PIX. `paymentMethod: 'BOLETO'` → **400** `BOLETO_NOT_ALLOWED_HERE`.
  - Contrato `AWAITING_PAYMENT` com `paymentDeadline` = agora + `config.studio.lockTtlSeconds` (**10 min**); o QR PIX expira junto. Antes de criar, uma contratação anterior **não paga** do mesmo usuário + serviço é descartada pela rotina segura da varredura (`purgeAwaitingContract`); se ela estiver paga → **409** ("já está ativo"); com pagamento em processamento → **409**.
  - Resposta 201: `{ contractId, firstPaymentId, amount, paymentDeadline (ISO), paymentPlan: 'MONTHLY'|'FULL', installmentCap?, couponDiscount?, clientSecret?, pixString?, expiresAt? (ISO, PIX), message }`. Cupom 100%: `{ contractId, firstPaymentId, amount: 0, alreadyPaid: true, couponDiscount, message }`.
- **`POST /:id/pay`** (contrato `AWAITING_PAYMENT` do próprio cliente) — `{ paymentMethod?: 'CARTAO'|'PIX' (padrão CARTAO), couponCode? }`.
  - Contrato do cliente em `PENDING_CANCELLATION` → **409** `{ error: 'Este contrato está com cancelamento em análise. Aguarde a decisão do estúdio.', code: 'CANCELLATION_PENDING' }` (em vez do 404 dos demais status).
  - PIX: usa `issuePixCharge` (reusa só a cobrança viva e com o mesmo valor; senão concilia/cancela e emite nova). Resposta `{ provider: 'SICOOB'|'CORA', paymentId, pixString, qrCodeDataUrl, qrCodeBase64, expiresAt (ISO), amount, reused, couponDiscount?, message }`; se a conciliação achar a cobrança já paga: `{ provider, paymentId, amount, alreadyPaid: true, message }`.
  - Cartão numa linha que tinha PIX: aposenta o PIX vivo antes (se já pago → `{ …, alreadyPaid: true }`) e limpa `pixString/pixExpiresAt`.
  - Cobrança reaproveitada (PIX e cartão): a `PENDING` do **plano** (`bookingId: null`) que vence primeiro — nunca um extra de gravação do contrato (Z1-d); sem nenhuma, cria a do plano.
- **`POST /:id/client-renew`**: aceita `ACTIVE`, `EXPIRED` e **`COMPLETED`** (D6; exceto avulso). `COMPLETED` é tratado como `ACTIVE`: janela dos últimos 7 dias e início no fim do contrato atual. Prazo de pagamento da renovação continua 3 dias. `paymentMethod: 'BOLETO'` (ou contrato original em boleto sem informar outra forma) → **400** `BOLETO_NOT_ALLOWED_HERE` (a renovação é paga por PIX ou cartão).
- **`POST /:id/subscribe` (E9 — "Ativar cobrança automática")** — body `{ paymentMethodId }` (id do `SavedPaymentMethod` **ou** o `pm_…` do Stripe, ex.: o cartão recém-cadastrado por SetupIntent; `durationMonths` é aceito e ignorado). **Não cria assinatura Stripe nem `Payment`** (a assinatura paralela cobrava em dobro). Liga `User.autoChargeEnabled` (por **cliente** — vale para todos os contratos dele) e torna o cartão o padrão; quem cobra é o `autoChargeJob`, as parcelas que já existem. Idempotente.
  - 200: `{ success: true, autoChargeEnabled: true, alreadyEnabled, scope: 'USER', defaultCard: { id, stripePaymentMethodId, brand, last4, expMonth, expYear, funding, isDefault: true }, message }`.
  - Erros: contrato de outro cliente → **404**; `CANCELLED` → **400** `CONTRACT_CANCELLED`; à vista sem cobrança pendente **do plano** (extras de gravação, com `bookingId`, não contam) → **400** `NOTHING_TO_CHARGE`; cartão que não é do cliente (ou não existe mais no Stripe) → **404** `CARD_NOT_FOUND`; débito/pré-pago → **400** `CARD_NOT_CREDIT`; Stripe desligado → **503**; falha ao conferir o cartão/definir o padrão no Stripe → **502** (nada muda).

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
| PATCH | `/:id/auto-charge` | Liga/desliga cobrança automática (409 se excluído). Ligar exige cartão de **crédito** conferido no Stripe: mesmos status/códigos do `PUT /stripe/auto-charge` (400 sem cartão, 400 `CARD_NOT_CREDIT`, 404 `CARD_NOT_FOUND`, 502/503), com mensagens sobre o cartão do cliente; ligado, o cartão conferido vira o padrão do cliente (Z1-a) |

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
| GET | `/payment-methods` | Público | Métodos de pagamento ativos + estado do boleto |
| GET | `/payment-methods/all` | Admin | Todos os métodos (inclui inativos) + estado do boleto |
| PUT | `/payment-methods` | Admin | Atualiza configuração dos métodos |
| PUT | `/payment-methods/boleto` | Admin | Chave-mestra "Aceitar pagamento por boleto" (E3) |
| GET | `/business-config/public` | Público | Configuração pública do negócio |
| GET | `/business-config` | Admin | Configuração completa |
| PUT | `/business-config` | Admin | Atualiza configuração |
| POST | `/checkout-quote` | Autenticado | Cotação autoritativa (valor + parcelas) |

- **Boleto (E3)** — fonte única `getBoletoStatus()` (`lib/paymentGateway.ts`): `boleto = { enabled, providerEnabled, available, reason, message }`. `enabled` = chave-mestra (`PaymentMethodConfig BOLETO.active`); `providerEnabled` = integração Cora habilitada com credenciais do ambiente ativo; `available` = os dois; `reason` = `'PROVIDER_DISABLED'` (Cora inativa — tem precedência), `'SWITCH_OFF'` ou `null`; `message` = texto pronto para a tela (ou `null`).
  - `GET /payment-methods` → `{ methods, boleto }`. `BOLETO` só vem em `methods` quando `boleto.available`. Sem nenhum método configurado, os padrões devolvidos são só PIX e Cartão. **A rota é pública, então `boleto` vem saneado**: só `available` informa (`enabled` e `providerEnabled` repetem `available`; `reason` e `message` são sempre `null`). A posição da chave, o estado da integração Cora e o texto de administração **não** saem aqui.
  - `GET /payment-methods/all` (ADMIN) → `{ methods (todos), boleto }` com o `boleto` **completo** (`enabled`, `providerEnabled`, `available`, `reason`, `message`) — é de onde as telas do admin leem o motivo do boleto indisponível. Na 1ª leitura o boleto é semeado **desligado**.
  - `PUT /payment-methods/boleto` — `{ enabled: boolean }` → `{ boleto, message }`. Ligar com a Cora inativa → **400** `{ error, code: 'BOLETO_PROVIDER_DISABLED', boleto }`; desligar é sempre permitido.
  - `PUT /payment-methods` (lote) → `{ methods, boleto, message }`. Ligar o boleto no lote (`active` de `false` para `true`) com a Cora inativa → **400** `BOLETO_PROVIDER_DISABLED` e **nada** do lote é gravado; um boleto que já estava ligado não bloqueia salvar os demais (ele só não fica efetivo).

## payments — `/api/payments` ([routes](../../backend/src/modules/payments/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/` | Admin | Lista pagamentos |
| GET | `/summary` | Admin | Resumo financeiro (receita paga pelo valor efetivamente cobrado — `paidChargedAmount`) |
| PATCH | `/:id` | Admin | Atualiza um pagamento |
| GET | `/sandbox-mode` | Autenticado | Indica se o gateway está em sandbox |
| GET | `/:id/status` | Autenticado | Status de um pagamento |
| POST | `/:id/simulate` | Autenticado (dono ou admin) | Simula confirmação — só com o provedor efetivo em sandbox |

- **Sandbox efetivo** — `GET /sandbox-mode` → `{ pix, card }` e `POST /:id/simulate` usam o **mesmo** critério (`isProviderSandbox`, em `payments.client.ts`): a integração do provedor precisa estar **habilitada** e no ambiente `sandbox`; no Sicoob, também precisa ser o ambiente que o deploy pode operar (`sicoobAllowedEnvironment`: num servidor com `NODE_ENV=production` o Sicoob em sandbox não conta). `pix` = o provedor de PIX ativo (`resolvePixProvider`: Sicoob, senão Cora); `card` = Stripe.
- **`POST /:id/simulate`** — 404 se o pagamento não é de quem chama (o admin alcança qualquer um); **403** `{ error }` se o provedor **efetivo** da cobrança não está em sandbox; senão `PENDING → PAID` + `onPaymentConfirmed` → `{ status: 'PAID', message }`. Provedor efetivo: `STRIPE` para cartão; para PIX/boleto, quem **emitiu** a cobrança (linha com `providerRef`) ou, se a linha ainda é um placeholder sem cobrança emitida (ex.: o `CORA` gravado na criação do avulso), o provedor de PIX ativo. Uma integração desligada nunca habilita a simulação, mesmo com `environment = 'sandbox'`.

## stripe — `/api/stripe` ([routes](../../backend/src/modules/stripe/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/publishable-key` | Autenticado | Chave pública da Stripe |
| POST | `/setup-intent` | Autenticado | Cria SetupIntent (salvar cartão) |
| POST | `/setup-intent/confirm` | Autenticado | Persiste o cartão do SetupIntent confirmado (uso imediato) |
| GET | `/payment-methods` | Autenticado | Lista cartões salvos de quem está logado |
| GET | `/payment-methods/for-payment/:paymentId` | Admin | Cartões salvos e CPF do **cliente** dono do pagamento (E1) |
| DELETE | `/payment-methods/:pmId` | Autenticado | Remove cartão |
| PUT | `/payment-methods/:pmId/default` | Autenticado | Define cartão padrão |
| POST | `/create-payment` | Autenticado | Cria PaymentIntent (cartão/PIX/boleto) |
| POST | `/installment-plans` | Autenticado | Planos de parcelamento (1–12x com taxas) |
| GET | `/auto-charge` | Autenticado | Estado da cobrança automática + cartão que será cobrado |
| PUT | `/auto-charge` | Autenticado | Liga/desliga cobrança automática |
| POST | `/verify-payment` | Autenticado | Recuperação manual de webhook (verifica PI) |

- **`POST /create-payment`** — `{ paymentId, paymentMethod?: 'cartao'|'pix'|'boleto', installments?, savedPaymentMethodId?, savePaymentMethod? }`. O admin pode cobrar qualquer pagamento; o **pagador é sempre o dono do pagamento** (Customer Stripe, cartão salvo e CPF/CNPJ do cliente — E1). Não olha o status do contrato (exceto o cancelamento em análise, abaixo): a multa de cancelamento (`metadata.kind = 'CANCELLATION_FINE'`) é pagável com o contrato `CANCELLED`.
  - **Cancelamento em análise (E13)**: com o contrato em `PENDING_CANCELLATION`, o **cliente** não paga parcelas do plano (cobrança sem `bookingId` que não é a multa) → **409** `{ error: 'Este contrato está com cancelamento em análise. Aguarde a decisão do estúdio.', code: 'CANCELLATION_PENDING' }`, antes de qualquer efeito (não reabre `FAILED`, não emite QR nem PaymentIntent). O **admin** continua podendo cobrar; extras de uma gravação (`bookingId`) e a multa seguem pagáveis. Só a emissão é bloqueada: um pagamento já feito (webhook, conciliação, `verify-payment`) é sempre registrado. Regra em `lib/cancellationPending.ts`.
  - **Gravação cancelada (CLI-2)**: cobrança com `bookingId` cuja gravação está `CANCELLED` → **400** `{ error: 'A gravação desta cobrança foi cancelada. Esta cobrança não pode mais ser paga.', code: 'BOOKING_CANCELLED' }`, para cliente **e** admin, antes de qualquer efeito (não reabre `FAILED`, não emite QR nem PaymentIntent). O `POST /contracts/:id/pay` segue a mesma regra: nunca reaproveita a cobrança de uma gravação cancelada (cobra a parcela do plano).
  - **Trilha do admin (SEC-4)**: quando o admin cobra o **cartão** de um cliente, fica um registro em `audit_logs` (entidade `PAYMENT`, `performedBy` = o admin): `ADMIN_CHARGED_SAVED_CARD` (cartão salvo, debitado na hora) ou `ADMIN_CHARGE_STARTED` (cartão novo), com `{ payerUserId, paymentIntentId, amount, installments, method }`. Marca o início da cobrança; a aprovação continua vindo do webhook/`verify-payment`. O metadata do PaymentIntent não muda.
  - **E2 (desconto PIX bidirecional)**: no PIX, uma cobrança à vista que está no preço de cartão da marca (`amount === pixDiscount.cardAmount` e `pixAmount < amount`) passa a valer `pixAmount` (update condicional atômico) antes de o QR sair — `amount` da resposta = preço PIX. Com um PaymentIntent de cartão em andamento → **400** e o valor não muda. No cartão, cobra-se `cardAmount` (nunca mais). Sem a marca, os dois cobram o `amount`.
  - **Cartão salvo** (`savedPaymentMethodId` = id do `SavedPaymentMethod` **ou** `pm_…`): tem de ser do dono do pagamento (linha dele no banco ou cartão anexado ao Customer dele). Cartão de outra pessoa — inclusive o do próprio admin — → **400** `{ error, code: 'CARD_NOT_FOUND' }` antes de qualquer efeito.
  - **CPF/CNPJ** (PIX e boleto): pagador sem documento válido → **400** `{ error, code: 'CPF_CNPJ_REQUIRED', payerUserId }` (para o admin, a mensagem fala do cliente).
  - **Boleto (E3)**: exige o boleto efetivo (senão **400** `{ code: 'BOLETO_UNAVAILABLE', reason }`) e uma cobrança sem prazo de pagamento — contrato `AWAITING_PAYMENT`, contratação `/self` ainda sem contrato ou reserva em espera → **400** `{ code: 'BOLETO_NOT_ALLOWED_HERE' }` (vale também para o admin). `Contract.boletoAllowed` é ignorado. O boleto cobra o **preço de cartão** (uma cobrança que estava no preço PIX volta a `cardAmount`). Resposta: `{ provider: 'CORA', boletoUrl, barcode, amount, paymentId }`.
  - **PIX** (D15, `issuePixCharge`): `{ provider: 'SICOOB'|'CORA', pixString, qrCodeDataUrl ('data:image/png;base64,…'), qrCodeBase64 (compat, sem prefixo), expiresAt (ISO), amount (centavos), reused, alreadyPaid: false, paymentId }`. Reusa só a cobrança viva, com BR Code válido e o mesmo valor; senão concilia a anterior, cancela e emite nova (txid com sufixo de tentativa). Se a conciliação achar a cobrança paga: `{ provider, status: 'PAID', alreadyPaid: true, amount, paymentId }`. Erros (CPF ausente, provedor desligado, falha) → 400 `{ error }`.
  - **Cartão**: `installments` limitado pela política (inclui `metadata.installmentCap` do serviço); juros só acima de `freeUpTo`. Parcelamento só é habilitado no PI quando `installments > 1`; com **cartão salvo** o plano `fixed_count` vai de fato ao Stripe (se o cartão não oferece N× → erro, nada é cobrado). Se a linha tinha PIX vivo, ele é aposentado antes (já pago → **400** `{ error, status: 'PAID', alreadyPaid: true }`). Resposta: `{ provider: 'STRIPE', clientSecret, paymentIntentId, amount, installments }` — `amount` = valor do PI (= `chargedAmount`: a base do cartão, sem o desconto PIX do à vista, com juros quando parcelado); o checkout exibe este valor.
  - Valor base do cartão = `cardChargeBaseAmount`: `metadata.pixDiscount.cardAmount` quando a cobrança tem a marca (e ela não caducou); senão o próprio `amount`. Não há fallback legado: cobrança antiga sem a marca sai pelo `amount`, abaixo do preço de cartão e nunca acima (ver pagamentos.md). Valor 0 → 0 (nunca vai ao cartão).
  - **Linha `FAILED` com PaymentIntent (Z1-e)**: antes de reabrir, o PI do `providerRef` é consultado (só leitura); `succeeded`/`processing`/`requires_capture` → **409** `{ error, code: 'CARD_PAYMENT_IN_FLIGHT' }` para **qualquer** `paymentMethod` (cartão, PIX, boleto) e a linha **não** é reaberta (segue `FAILED` apontando para o PI; o webhook/verify a baixam — PAY-6). Stripe desligado, PI inexistente ou falha na consulta → reabre como antes.
  - **PI anterior da mesma cobrança** (`providerRef` pi_…, inclusive de uma linha `FAILED` reaberta): `succeeded`/`processing`/`requires_capture` → **409** `{ error, code: 'CARD_PAYMENT_IN_FLIGHT' }` e nenhum PI novo; pagável com **outro valor** → cancelado antes de criar o novo; não foi possível consultar/cancelar → **503**. O mesmo vale no cartão do `POST /contracts/:id/pay` (que reaproveita o PI pagável de mesmo valor).
  - Pagamento `FAILED` é reaberto (`PENDING`) limpando `providerRef/pixString/pixExpiresAt/boletoUrl/chargedAmount`.
- **`POST /installment-plans`** — `{ paymentId? , amount?, contractDurationMonths?, installmentCap? (1–12) }` → `{ plans: [{ count, perInstallment, total, feePercent, freeOfCharge }], cardAmount, pixAmount }`. `cardAmount` = o que o cartão cobra em 1x; `pixAmount` = o que o PIX cobra (com o desconto do à vista quando a cobrança tem a marca — E2) — o checkout mostra o preço certo em cada aba **antes** de gerar. Sem `paymentId`, os dois são o `amount` informado. Com `paymentId`, a política vem do pagamento (serviço com teto → só 1..N, todas sem juros). Sem `paymentId`, `installmentCap` permite a prévia do serviço (ex.: `installmentCap: 3` → 1x–3x sem juros; `1` → só 1x). Com `paymentId`, o valor é `cardChargeBaseAmount` (a base marcada ou o `amount`); valor 0 → **400** `{ error: 'Valor inválido.' }`.

- **`POST /setup-intent/confirm` (E9)** — `{ setupIntentId, makeDefault?: boolean }` → `{ card: { id, stripePaymentMethodId, brand, last4, expMonth, expYear, funding, isDefault }, message }`. Chame depois de `stripe.confirmSetup` (Stripe Elements): grava o cartão no banco sem esperar o webhook `setup_intent.succeeded` (idempotente; não duplica a linha do webhook). O SetupIntent tem de ser do Customer do usuário (**404** `SETUP_INTENT_NOT_FOUND`) e estar `succeeded` (**409** `SETUP_INTENT_NOT_CONFIRMED`). Não liga a cobrança automática (isso é o `POST /contracts/:id/subscribe` ou o `PUT /auto-charge`). Com a cobrança automática **ligada**, `makeDefault` de um cartão de débito/pré-pago salva o cartão mas **não** o torna padrão: a resposta traz `card.isDefault: false` e `defaultNotApplied: { code: 'CARD_NOT_CREDIT', error }`.
- **`GET /payment-methods/for-payment/:paymentId` (ADMIN, E1)** → `{ paymentMethods: [{ id, stripePaymentMethodId, brand, last4, expMonth, expYear, funding, isDefault }], autoChargeEnabled, payer: { id, name, cpfCnpj, hasValidCpfCnpj, deleted } }` — os cartões e o CPF do **cliente** dono do pagamento (nunca os do admin). Nunca cria Customer; Stripe desligado/fora do ar → cartões do banco com `funding: 'unknown'`.
- **`GET /auto-charge` (E9)** → `{ autoChargeEnabled, scope: 'USER', hasSavedCard, savedCards, defaultCard: { id, stripePaymentMethodId, brand, last4, expMonth, expYear, isDefault } | null }`. `defaultCard` = o cartão que o `autoChargeJob` usaria (o padrão ou, sem padrão, o mais recente).
- **`PUT /auto-charge` (E9)** — body `{ enabled: boolean }` → `{ message }`. **Desligar** é sempre aceito e não consulta o Stripe. **Ligar** exige que o cartão que o job cobraria (o mesmo `defaultCard` do `GET`) seja de **crédito**, conferido no Stripe como no `POST /contracts/:id/subscribe`:
  - débito ou pré-pago → **400** `{ error: 'A cobrança automática aceita apenas cartão de crédito.', code: 'CARD_NOT_CREDIT' }` (novo; mesmo corpo do `/subscribe`). `funding` `unknown` é aceito;
  - nenhum cartão salvo → **400** `{ error: 'Adicione pelo menos um cartão antes de ativar a cobrança automática.' }` (sem `code`, como antes);
  - cartão que não pôde ser conferido: Stripe desligado → **503**; falha na consulta → **502**; cartão que não existe mais no Stripe ou não é do Customer do usuário → **404** `CARD_NOT_FOUND`. Em todas as recusas `autoChargeEnabled` fica como estava.
  - A conferência é única (`lib/savedCards.checkAutoChargeCard`) e vale também no `POST /contracts/:id/subscribe` e no `PATCH /users/:id/auto-charge` do admin (mesmos status/códigos; mensagens na 3ª pessoa).
  - Ligado com sucesso, o cartão conferido **vira o padrão** (Z1-a — banco + padrão no Stripe em best-effort; também no `PATCH` do admin): um cartão salvo depois não assume a cobrança sem conferência. Corpo da resposta inalterado.
- **`PUT /payment-methods/:pmId/default`** → `{ message }`. Com a cobrança automática **ligada**, o novo padrão passa pela mesma conferência antes de qualquer efeito: débito/pré-pago → **400** `{ error: 'Com a cobrança automática ligada, o cartão padrão precisa ser de crédito. Desligue a cobrança automática ou escolha um cartão de crédito.', code: 'CARD_NOT_CREDIT' }`; cartão que não é do cliente → **404** `CARD_NOT_FOUND`; Stripe não respondeu → **502**. Com ela desligada, a troca segue livre.
- **`DELETE /payment-methods/:pmId`** → `{ message }`. Se o cartão removido era o que a cobrança automática cobra (o padrão ou, sem padrão, o mais recente) e ela está **ligada**, o substituto (o salvo mais recente) passa pela mesma conferência — aprovado, **vira o padrão** (Z1-a; resposta de sempre); sem substituto ou reprovado, a cobrança automática é **desligada** e a resposta vira `{ message, autoChargeEnabled: false, autoChargeDisabled: true, autoChargeDisabledReason: 'NO_CARD' | 'CARD_NOT_CREDIT' | 'CARD_NOT_FOUND' | 'CARD_NOT_VERIFIED' }` (auditoria `AUTO_CHARGE_DISABLED` na entidade `USER`). O cartão é removido de qualquer forma.
- **`POST /verify-payment`** — `{ paymentId, paymentIntentId }`. Só responde `{ status: 'PAID' }` quando a linha está `PAID`: baixa uma linha `PENDING` ou uma `FAILED` de cartão cujo `providerRef` é o **mesmo** PaymentIntent aprovado (PAY-6). PI aprovado mas a linha não pôde ser baixada (ex.: `FAILED` de outra tentativa) → **409** `{ error, code: 'PAYMENT_NOT_SETTLED', paymentStatus }` e nada muda. PI ainda não aprovado → 200 com o status atual da linha.

## webhooks — `/api/webhooks` ([routes](../../backend/src/modules/webhooks/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| POST | `/cora` | Assinatura | Webhook da Cora (PIX/boleto) |
| POST | `/stripe` | Assinatura | Webhook da Stripe (precisa do corpo bruto) |

- **`payment_intent.succeeded` numa cobrança já `PAID` (Z1-c)**: se a baixa foi por **outro** PaymentIntent, o cliente foi cobrado duas vezes — a linha não muda, os admins recebem `admin_card_double_charge` (1 aviso por PI excedente; auditoria `DOUBLE_CARD_CHARGE`) para estornar no painel do Stripe. Mesmo PI da baixa → nada; paga por outro meio (PIX/boleto) → só log `[Webhook:Stripe][SECURITY]`. Ver [pagamentos.md](pagamentos.md#cobrança-automática-e9).

## notifications — `/api/notifications` ([routes](../../backend/src/modules/notifications/routes.ts))

| Método | Rota | Acesso | Descrição |
| --- | --- | --- | --- |
| GET | `/` | Autenticado | Notificações (computadas + persistidas) |
| PATCH | `/read-all` | Autenticado | Marca todas como lidas |
| PATCH | `/:id/read` | Autenticado | Marca uma como lida |
| DELETE | `/:id` | Autenticado | Remove uma notificação |

- `GET /` — os alertas computados "faturas vencidas" e "pagamento com cartão falhou" (cliente e admin) não contam a cobrança ligada a uma gravação `CANCELLED` (`payment.booking.status`): ela não é mais pagável (`create-payment` → 400 `BOOKING_CANCELLED`). O push de faturas vencidas (`pushNotificationJob`) aplica o mesmo filtro. Cobre o dado legado; hoje o cancelamento da gravação de plano já anula esses extras (ver bookings).

## reports — `/api/reports` ([routes](../../backend/src/modules/reports/routes.ts)) · Admin

| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/summary` | KPIs (sessões, concluídas, faltas, receita, taxas) |
| GET | `/occupancy` | Ocupação por horário e por dia da semana |
| GET | `/tiers` | Distribuição por tier (quantidade + receita) |
| GET | `/audience` | Métricas de audiência (views, pico, chat, duração) |
| GET | `/ranking` | Ranking de clientes por receita |

- `GET /ranking?from&to&limit` — sem `limit` (ou com `limit` inválido/0) devolve só os **10** primeiros; não há teto no servidor. A tela de Relatórios pede `limit=10` para o card e um `limit` alto (`FULL_RANKING_LIMIT` = 100000, em `AdminReportsPage.tsx`) para exportar o ranking inteiro no CSV (E6).

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
