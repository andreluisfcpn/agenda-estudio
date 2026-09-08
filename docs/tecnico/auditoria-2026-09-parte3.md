# Auditoria completa (Parte 3) — round 2 pós-correção · set/2026

> ## ✅ STATUS: OS 29 ACHADOS (B1–B29) FORAM CORRIGIDOS (2026-09-03)
> Todos corrigidos após esta re-auditoria. Verificação:
> - **Compilação:** backend `tsc --noEmit` EXIT 0 · frontend `tsc --noEmit` EXIT 0 · `npm run build` EXIT 0.
> - **Testes:** 100 unidade + 16 integração passando.
> - **Verificado ao vivo:** B2 (perCycle negativo → 400), A7 e2e re-confirmado após os edits de B25 (extra vira Payment PENDING, add_ons vazio, crédito debitado), backend hot-reload sem erros.
> - **Sem nova migração** (todos os fixes são de lógica; a coluna `charged_amount` da rodada 1 permanece).
> - Regra do dono respeitada: só correção de bug, nada descaracterizado. **Alterações NÃO commitadas** — aguardando revisão.
>
> Destaques ALTO corrigidos: B1 (parcelas 2..N de assinatura carregam stripeSubscriptionId + auto-charge as ignora), B2 (perCycle `.int().min(0)`), B3 (cancelamento com transição atômica guardada em DELETE/client-cancel/PATCH), B22 (renovação CUSTOM copia sessionsPerCycle + /pay usa computeMonthlyAmount + gera bookings recorrentes).

> ## Veredito original (identificação): as 36 correções ficaram boas (0 regressões) — mas incompletas em alguns "gêmeos"
> **Pergunta do dono:** "as correções foram satisfatoriamente feitas? há novas correções a fazer?"
>
> **Resposta:** Sim, as 36 correções (A1–A25 + L1–L12) **passaram na verificação adversarial — 0 regressões**, nenhuma quebrou funcionalidade nem foi aplicada errada. Porém **6 fixes ficaram incompletos** (corrigiram o caminho principal mas não o caminho-irmão) e a varredura profunda achou **bugs novos/mais fundos** que a 1ª rodada não cobria. Total: **29 achados confirmados (0 regressão · 21 residuais · 8 novos · 4 ALTO)**. Nenhum corrigido ainda — este é o relatório de identificação.
>
> **Como foi feito (mais profundo que a rodada 1):**
> 1. **Workflow multi-agente** — 32 agentes: 6 finders de REGRESSÃO (re-verificam cada fix) + 10 de DESCOBERTA profunda (RBAC/IDOR, idempotência de webhooks, estornos/créditos, TZ sistêmico, uploads/validação, anti-abuso, concorrência, PWA, dinheiro) → verificação adversarial → síntese.
> 2. **Testes ao vivo** (servidor local + API + navegador):
>    - **A7 ponta-a-ponta:** reserva por plano + serviço extra pago → gerou **Payment PENDING** (R$140), extra NÃO entregue no booking, crédito debitado. **Vazamento de receita fechado (confirmado ao vivo).**
>    - **IDOR:** criei um 2º cliente e tentei ler/alterar booking/contrato/pagamento/usuário do 1º por ID → **todos 404/403**, listas vazias. Ownership sólido.
>    - **A12** salva pela UI (toast de sucesso), **A14/A15/L4/L7** confirmados via API, **L2/L3/L5/L6/L11/L12** confirmados no navegador.
> 3. **Regra do dono respeitada:** só correção de bug, nada descaracterizado.
>
> **Destaques ALTO:** B1 (parcelas 2..N de assinatura Stripe nunca conciliadas → cobrança dupla), B2 (`perCycle` negativo = dinheiro grátis no contrato CUSTOM), B3 (cancelamento concorrente restaura crédito em dobro), B22 (renovação CUSTOM subfaturada + sem agendamentos). Detalhes abaixo.


## Resumo executivo

- **Nenhuma regressão confirmada.** Nenhum dos 36 fixes quebrou funcionalidade existente nem foi aplicado incorretamente. Os 21 achados "residuais" são casos em que um fix corrigiu o caminho principal mas **não alcançou um caminho-irmão** (cobertura incompleta) — não são fixes errados.
- **29 achados** no total: 21 residuais + 8 novos; 0 regressões.
- **4 HIGH**, todos com impacto direto em dinheiro/cobrança: 3 residuais (B1 assinatura Stripe, B2 cupom perCycle, B3 cancelamento concorrente) e 1 novo (B22 renovação CUSTOM).

### Tabela-resumo por severidade

| Severidade | Qtd |
|---|---|
| CRITICAL | 0 |
| HIGH | 4 |
| MEDIUM | 11 |
| LOW | 14 |
| **Total** | **29** |

### Tabela-resumo por kind

| Kind | Qtd |
|---|---|
| regression | 0 |
| residual | 21 |
| new | 8 |
| **Total** | **29** |

### Cruzamento kind × severidade

| Kind | HIGH | MEDIUM | LOW | Total |
|---|---|---|---|---|
| regression | 0 | 0 | 0 | 0 |
| residual | 3 | 7 | 11 | 21 |
| new | 1 | 4 | 3 | 8 |
| **Total** | **4** | **11** | **14** | **29** |

Verdict: **28 CONFIRMED**, **1 PLAUSIBLE** (B27).

---

## SEÇÃO 1 — Regressões / fixes incorretos

**Regressões confirmadas: 0.** As 36 correções passaram na verificação adversarial — nenhum fix regrediu comportamento nem foi aplicado incorretamente. Os itens abaixo são **residuais** (`kind=residual`): lacunas onde a correção não cobriu um caminho-irmão. Ordenados por severidade.

### HIGH

#### B1 — Parcelas recorrentes da assinatura Stripe (meses 2..N) nunca conciliadas
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** payments-integrity
- **local:** `backend/src/modules/webhooks/routes.ts:415`
- **Resumo:** o handler `invoice.payment_succeeded` casa a fatura por `{stripeSubscriptionId, status:PENDING}`, mas só a 1ª parcela grava `stripeSubscriptionId`; as parcelas 2..N geradas por `generateRemainingInstallments` não têm o campo.
- **Cenário:** cliente renova → `/subscribe` cria 1 Payment PENDING com `stripeSubscriptionId`; Stripe cria assinatura mensal real. 1ª invoice quita a 1ª parcela e dispara `generateRemainingInstallments`, criando meses 2..N **sem** `stripeSubscriptionId`. No mês 2 o Stripe cobra o cartão e emite `invoice.payment_succeeded`, mas o `findFirst` não acha a parcela → fica PENDING para sempre (não há cron de conciliação Stripe). Com `autoChargeEnabled`, `runAutoChargeJob` debita **de novo** a mesma parcela → **cobrança em dobro**; sem auto-charge, o cliente pode pagar de novo via `/pay`.
- **Fix mínimo:** propagar `stripeSubscriptionId` para as parcelas geradas quando o contrato tem assinatura (e casar a fatura por `dueDate`/período), **e/ou** pular contratos com assinatura Stripe em `generateRemainingInstallments`, **e/ou** excluir essas parcelas do `runAutoChargeJob`.

#### B2 — Cupom-livre de dinheiro via `addonConfig.perCycle` negativo em `/contracts/custom`
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** money
- **local:** `backend/src/modules/contracts/validators.ts:93`
- **Resumo:** `perCycle` é `z.number().optional()` sem `.int()/.min(0)`; valor negativo enviado por cliente autenticado reduz o total do contrato abaixo do custo real das sessões. (Confirmado no arquivo: `perCycle: z.number().optional()`.)
- **Cenário:** cliente autenticado (rota só `authenticate`) envia `addOns:['TRANSCRICAO']`, `addonConfig:{TRANSCRICAO:{mode:'credits',perCycle:-N}}`. Em `contract.creation.ts:690` o teste `config.perCycle` é truthy para negativo; `applyDiscount(addon.price * -N, ...)` (`utils/pricing.ts:85`) não tem piso, então o produto negativo permanece. `cycleAmount` cai abaixo do custo das sessões (que são entregues igual). Calibrando N para manter `cycleAmount>0`, todas as parcelas passam pelo gateway subfaturadas. Propaga a renovação/parcela via `contractPricing.ts:188-189`.
- **Fix mínimo:** `perCycle: z.number().int().min(0).optional()` em `validators.ts:93`; e tratar `perCycle<=0` como ausente em `contract.creation.ts:690` e `contractPricing.ts:188`.

#### B3 — Cancelamento concorrente de booking restaura crédito em dobro
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** concurrency
- **local:** `backend/src/modules/bookings/booking.management.ts:122`
- **Resumo:** `DELETE /:id`, `PUT /:id/client-cancel` e o `PATCH→NAO_REALIZADO` cancelam com `prisma.booking.update` incondicional (por id, sem guard de status) e chamam `restoreCredit()` gated apenas no snapshot pré-leitura. Duas requisições quase simultâneas passam ambas o gate e restauram (+2 créditos por 1 gravação cancelada).
- **Cenário:** cliente dá duplo-clique em "Cancelar" (FLEX/CUSTOM). Req A e Req B fazem `findFirst` antes do commit da outra → ambas leem RESERVED/CONFIRMED. Ambas `update` por id (sucesso) e ambas avaliam `cancelableStatuses.includes(booking.status)` contra o mesmo snapshot velho → ambas chamam `restoreCredit` (`increment:1` sem guard de transição). Sem `$transaction`/lock, nada serializa. Fica sessão paga grátis. O fix anterior só tornou o increment lost-update-safe, não gated na transição desta requisição.
- **Fix mínimo:** transição atômica guardada — `const c = await prisma.booking.updateMany({ where:{ id, status:{ in: cancelableStatuses } }, data:{ status: CANCELLED } }); if (c.count===0) return; ...restoreCredit(...)`. Aplicar o mesmo gate em `booking.status.ts` (client-cancel) e no ramo admin `PATCH→NAO_REALIZADO`.

### MEDIUM

#### B4 — `/resume` FIXO regenera bookings sem o teto `durationMonths × sessions_per_month` (gêmeo não-corrigido de A6)
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** money
- **local:** `backend/src/modules/contracts/contract.lifecycle.ts:581`
- **Resumo:** o laço FIXO do `PATCH /:id/resume` (`while (cursor < newEndDate)`) não aplica o teto de sessões nem desconta as já entregues, ao contrário de `creation.ts:98-108` e do renew já corrigido por A6 (`lifecycle.ts:464-468`).
- **Cenário:** pausa em 01-07 cancela sessões `date>=01-07` (11 canceladas, 01-06 sobrevive); resume em 01-08 (`newEndDate=04-07`) regenera 12 (incl. 03-31 que o cap da criação excluíra) → **13 ativas para plano de 12**. Pausa cedo de 30 dias → +2. Bookings entram direto via `createMany`, sem guard downstream (A8 só cobre `POST /bookings`). Sobre-entrega de gravações pagas.
- **Fix mínimo:** espelhar A6 — `const maxBookings = durationMonths * sessions_per_month; const jaEntregues = <count de bookings não-cancelados com date < now>; while (cursor < newEndDate && bookings.length < (maxBookings - jaEntregues))` com `break`, avançando 7 dias.

#### B5 — Hard-delete devolve crédito de sessão CONCLUÍDA/FALTA/NÃO-REALIZADA e dupla-restaura NAO_REALIZADO
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** money
- **local:** `backend/src/modules/bookings/booking.management.ts:153`
- **Resumo:** `DELETE /:id/hard-delete` restaura crédito para QUALQUER status `!= CANCELLED` (guard antigo), incluindo COMPLETED/FALTA/NAO_REALIZADO — divergindo do `DELETE /:id` (linha 121) que limita a `cancelableStatuses=[RESERVED,HELD,CONFIRMED]`.
- **Cenário:** hard-delete de COMPLETED/FALTA em contrato CUSTOM/AVULSO devolve crédito não merecido; NAO_REALIZADO já teve o crédito restaurado ao ser marcado (`management.ts:366-368`) → **dupla-restauração**. Para CUSTOM/AVULSO não há reconciler → drift **permanente**. A UI (`AdminBookingsPage.tsx:27`) anuncia devolução para todo status `!= CANCELLED`, tornando rotineiro. (Ressalva: FLEX converge no `flexCreditExpiryJob`; o dano persistente é em CUSTOM/AVULSO.)
- **Fix mínimo:** usar `cancelableStatuses=[RESERVED,HELD,CONFIRMED]` também no hard-delete e ajustar o aviso em `AdminBookingsPage.tsx:27`.

#### B6 — Cancelamento admin (DELETE e PATCH) não cancela bookings de HOJE (usa `new Date()` contra `date` à meia-noite)
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** data-integrity
- **local:** `backend/src/modules/contracts/contract.lifecycle.ts:280`
- **Resumo:** DELETE (linha 279) e PATCH cancel (linha 230) filtram `date: { gte: new Date() }` (instante). Como `booking.date` é date-only à meia-noite, o booking de hoje fica `< agora` e não é cancelado — divergindo do request-cancellation do cliente (315-322), que ancora em meia-noite.
- **Cenário:** qualquer cancelamento admin após 00:00 deixa o booking de hoje CONFIRMED/RESERVED num contrato CANCELLED. O slot continua bloqueado (`hasConflict` conta status `!= CANCELLED`) e o cliente mantém sessão vinculada a contrato cancelado.
- **Fix mínimo:** nos dois caminhos, `const startOfToday = new Date(); startOfToday.setHours(0,0,0,0);` e filtrar `date: { gte: startOfToday }` (linhas 230 e 279).

#### B7 — Dashboard "hoje/amanhã" erra 1 dia entre 21:00–24:00 SP
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** timezone
- **local:** `frontend/src/components/client/ClientDashboard.tsx:205`
- **Resumo:** `heroMessage` calcula `diffDays` subtraindo `new Date()` (instante) de `bookingDate` (`@db.Date`, sempre 00:00Z). Entre 21:00–23:59 SP o instante UTC já passou a meia-noite Z do dia SP seguinte → sessão de amanhã recebe `diffDays=0` e é rotulada "hoje".
- **Cenário:** agora = 2026-09-10 22:00 BRT (= 11 01:00Z); sessão de 11-09 tem `date=2026-09-11T00:00Z`; `diffDays=ceil(-0.0417)=0` → "Sua sessão é hoje" quando é amanhã. Janela: 21:00–23:59 SP. Bug de display, sem impacto em dados.
- **Fix mínimo:** ancorar ao meio-dia local, como `daysUntil()`: `new Date(nextBooking.date.split('T')[0] + 'T12:00:00')` para o `diffDays`.

#### B8 — Vencimento de parcela exibido 1 dia antes (`formatDate` sem `timeZone:'UTC'`)
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** timezone
- **local:** `frontend/src/utils/format.ts:18`
- **Resumo:** `formatDate()` usa `Intl.DateTimeFormat('pt-BR')` **sem** `timeZone:'UTC'`, ao contrário das irmãs `formatDateShort`/`formatDateFull`. Aplicada a `p.dueDate` em `MyPaymentsPage`; o `dueDate` das parcelas fica 00:00Z, então em navegador SP renderiza o dia anterior.
- **Cenário:** servidor UTC (default de containers Node); parcela com `dueDate=…31T00:00:00Z` renderiza "30 de out." em vez de "31 de out.". A MESMA `dueDate` é renderizada corretamente com `timeZone:'UTC'` em `ContractCard.tsx:556` — inconsistência interna.
- **Fix mínimo:** adicionar `{ timeZone: 'UTC' }` ao `Intl.DateTimeFormat` em `format.ts:18`.

#### B9 — Arrays sem `.max()` em `customContractSchema` permitem geração massiva de bookings (amplificação/DoS)
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** resource-exhaustion
- **local:** `backend/src/modules/contracts/validators.ts:83`
- **Resumo:** `schedule`, `customDates` e `weekPattern` não têm `.max()` (contraste com `bulkBookingSchema.slots.max(24)`). Confirmado no arquivo: os três arrays sem teto.
- **Cenário:** `express.json()` usa 100kb padrão. Um `schedule` de ~4000 itens (~96KB) com `durationMonths:12` → `totalSessions ≈ 192000`; o laço empilha até `totalSessions` e faz um único `createMany` (~192k linhas), após o contrato já estar ACTIVE (antes do pagamento). `createMany` sem try/catch → 500 e contrato ACTIVE órfão; requisições repetidas exaurem DB/CPU (~1900× de amplificação).
- **Fix mínimo:** `.max()` nos três arrays (ex.: `schedule.max(7)`, `customDates.max(366)`, `weekPattern.max(5)`) e/ou validar teto de `totalSessions` antes de criar contrato/bookings.

#### B10 — Cron de holds expirados cancela booking cujo PIX confirmou na janela (órfão pago-mas-cancelado)
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** concurrency
- **local:** `backend/src/jobs/cleanExpiredHolds.ts:69`
- **Resumo:** o cron checa pagamento PAID (linha 40) e, em passo não-atômico, cancela o booking (linha 69). Um pagamento que vira PENDING→PAID entre as duas chamadas passa pelo guard; o cron cancela o booking ainda RESERVED, e o `confirmBooking` posterior (que só casa RESERVED/HELD) vira no-op.
- **Cenário:** hold de ~10min expirando; cron acha booking RESERVED+expirado, `paidExists` não acha (ainda PENDING). Concorrentemente `reconcileSicoobPayment` commita PENDING→PAID (não-transacional com o effects); antes de `onPaymentConfirmed` rodar, o cron cancela (booking ainda RESERVED). Depois `confirmBookingAndActivateContract` → 0 rows (booking já CANCELLED), mas o contrato flipa AWAITING_PAYMENT→ACTIVE. Resultado: **payment PAID + contrato ACTIVE + booking CANCELLED**, nunca reparado.
- **Fix mínimo:** após o cancel atômico, re-consultar pagamento PAID e, se apareceu, promover o booking a CONFIRMED (espelhar linhas 51-65); para AVULSO, estender o re-read da linha 88 para restaurar o booking, não só pular o delete do contrato. Alternativa: checar+cancelar numa transação serializável.

### LOW

#### B11 — `/contracts/:id/confirm-payment` ignora `chargedAmount` e rejeita cartão com sobretaxa (residual de A1)
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** money
- **local:** `backend/src/modules/contracts/contract.payments.ts:353`
- **Resumo:** A1 moveu a sobretaxa de parcelamento para `chargedAmount` e atualizou 2 dos 4 caminhos; este endpoint ainda faz `if (pi.amount !== payment.amount)` (confirmado). Um PI com sobretaxa (`pi.amount == chargedAmount != amount`) é rejeitado com 400.
- **Cenário:** contrato FULL pago via CARTÃO em N parcelas (N > freeUpTo). POST direto autenticado com o `paymentIntentId` bate na linha 353 → 400 "Valor do pagamento não confere." (Inalcançável pela UI atual — a UI confirma via `/stripe/verify-payment`, que usa `chargedAmount ?? amount`; e o webhook ativa o contrato mesmo assim. Daí LOW.)
- **Fix mínimo:** `const expected = payment.chargedAmount ?? payment.amount; if (pi.amount !== expected) {...}`.

#### B12 — `/bookings/:id/complete-payment` ignora `chargedAmount` e rejeita avulso com sobretaxa (residual de A1)
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** money
- **local:** `backend/src/modules/bookings/booking.status.ts:77`
- **Resumo:** mesma lacuna de A1 no avulso: `if (pi.amount !== bookingPayment.amount)` (confirmado). Rejeita PI de cartão com sobretaxa (avulso `freeUpTo=1`, qualquer 2x+).
- **Cenário:** POST direto autenticado com PI sobretaxado passa a checagem de posse (linha 72) mas falha na 77 → 400. (Único caller de UI, `BookingModal.tsx:554`, não envia `paymentIntentId` e é barrado antes; a confirmação real corre por `/stripe/verify-payment`; webhook cobre. Daí LOW.)
- **Fix mínimo:** `const expected = bookingPayment.chargedAmount ?? bookingPayment.amount; if (pi.amount !== expected) {...}`.

#### B13 — `booking_min_advance_hours = 0` vira 12 no frontend (`|| 12`) → slots das próximas 12h greyados
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** ux-flow
- **local:** `frontend/src/components/BulkBookingModal.tsx:24`
- **Resumo:** `getConfigNum('booking_min_advance_hours') || 12` (também em `CalendarPage.tsx:47`): como `0` é falsy, uma config legítima de 0h vira 12h só no frontend; o backend usa o 0 real.
- **Cenário:** admin define `booking_min_advance_hours=0` (o PUT valida só `z.string()`, sem piso). Backend aceita quase qualquer horário futuro; frontend faz `0||12=12` e greya os slots das próximas 12h como "Encerrado". Cliente não consegue agendar curto prazo pela UI. Só ocorre com config exatamente 0.
- **Fix mínimo:** `const v = getConfigNum('booking_min_advance_hours'); const minAdvanceHours = Number.isFinite(v) ? v : 12;` em `BulkBookingModal.tsx:24` e `CalendarPage.tsx:47`.

#### B14 — Seção de config salva o snapshot inteiro (todos os grupos), revertendo silenciosamente chaves salvas em paralelo
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** data-integrity
- **local:** `frontend/src/components/admin/settings/SettingsBusinessConfigSection.tsx:100`
- **Resumo:** cada seção carrega o catálogo inteiro (`res.configs`) e, ao salvar, re-envia o snapshot stale completo — inclusive chaves de grupos que nunca renderiza. O backend faz upsert de tudo (exceto `EMAIL_SECRET_KEYS` em branco). A12 relaxou o Zod (`z.string()`), o que **ativou** este overwrite cross-group antes impossível (o PUT antes dava 400).
- **Cenário:** dois admins (ou duas abas). Aba A abre Financeiro (snapshot de tudo). Aba B muda `studio_name` e salva. Aba A, sem recarregar, salva um desconto → PUT do snapshot velho reverte `studio_name`, template de e-mail, toggles etc. Single-admin single-aba é seguro (remonta e refaz fetch ao trocar de seção).
- **Fix mínimo:** ao salvar, enviar só as chaves dos grupos que a seção realmente renderiza (montar o payload a partir de `configGrouped`/prop `groups`).

#### B15 — Plural quebrado "notificaçãoões" no tooltip (`title`) do sino
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** ui-text
- **local:** `frontend/src/components/NotificationBell.tsx:140`
- **Resumo:** `title={... notificação${unreadCount !== 1 ? 'ões' : ''} ...}` concatena a palavra completa com o sufixo → "notificaçãoões" para `unreadCount !== 1` (confirmado no arquivo). Mesma classe do bug de plural corrigido em L5 (arquivo diferente), ocorrência irmã não tocada.
- **Cenário:** `unreadCount=3` → "3 notificaçãoões não lidas"; `0` → "0 notificaçãoões não lidas". Só acerta em `===1`. O `aria-label` (linha 123) está correto (só pluraliza "lida"). Cosmético.
- **Fix mínimo:** usar a raiz — `notifica${unreadCount !== 1 ? 'ções' : 'ção'}`.

#### B16 — Refresh de background zera `setError` incondicionalmente e pode deixar o calendário público em branco
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** error-handling
- **local:** `frontend/src/components/PublicCalendarGrid.tsx:65`
- **Resumo:** em `fetchData`, `setError(null)` roda incondicional (linha 65), mas o erro só é re-setado no caminho foreground (`if (!isBackground) setError(...)`, linha 92) e `setDays` só em sucesso. Um tick de background apaga o erro sem restaurá-lo se o retry também falhar — contra a própria intenção de A19.
- **Cenário:** load inicial falha (API fora) → erro exibido, `days=[]`. Após 60s o interval dispara `fetchData(..., true)`: linha 65 apaga o erro, a chamada lança, o catch pula `setError` por `isBackground`. Estado final: `loading=false, error=null, days=[]` → painel em branco sem retry na principal superfície de conversão. Edge estreito (falha inicial + falha continuada).
- **Fix mínimo:** mover `setError(null)` para dentro do `if (!isBackground)` (ou limpar o erro só no sucesso, após `setDays`).

#### B17 — `PATCH /bookings/:id` roda `restoreCredit`/`deductCredit` ANTES de validações com early-return → crédito órfão
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** credit-integrity
- **local:** `backend/src/modules/bookings/booking.management.ts:366`
- **Resumo:** o bloco de crédito (367/373) executa no início; validações posteriores fazem `res.status(400); return` (métricas linha 396; startTime linha 423) ANTES do `prisma.booking.update` (432) — deixando o crédito alterado sem a mudança de status, e fora de transação.
- **Cenário:** PATCH em booking CONFIRMED FLEX com `{status:'NAO_REALIZADO', peakViewers:10}`: `restoreCredit` (+1) dispara; depois a validação de métricas retorna 400 antes do update. Booking segue CONFIRMED, crédito já devolvido; repetir infla créditos. Espelho: `deductCredit` sem mudar status. (FLEX auto-cura no cron; CUSTOM/AVULSO persistem. Payload atípico → LOW.)
- **Fix mínimo:** mover `restoreCredit`/`deductCredit` para DEPOIS de todas as validações, junto do `prisma.booking.update`, idealmente na mesma transação.

#### B18 — "Encerrado em" mostra 1 dia antes para contratos FIXO/CUSTOM
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** timezone
- **local:** `frontend/src/components/client/ContractCard.tsx:272`
- **Resumo:** no rodapé do card cancelado, `new Date(c.endDate).toLocaleDateString('pt-BR')` **não** passa `timeZone:'UTC'`. O MESMO `c.endDate` usa `timeZone:'UTC'` na linha 159 → inconsistência intra-arquivo.
- **Cenário:** servidor UTC, `endDate=2026-12-05T00:00:00Z`. Linha 272 em SP mostra "04/12/2026"; linha 159 mostra "05/12/2026". Só display, card cancelado/arquivado.
- **Fix mínimo:** passar `{ timeZone: 'UTC' }` no `toLocaleDateString` da linha 272.

#### B19 — `durationMonths` em `customContractSchema` não é `.int()` → 500 em vez de 400
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** input-validation
- **local:** `backend/src/modules/contracts/validators.ts:82`
- **Resumo:** `durationMonths: z.number().min(1).max(12)` sem `.int()` (confirmado), enquanto a coluna Prisma é `Int`. Fracionário passa o schema e estoura na criação.
- **Cenário:** cliente envia `durationMonths:3.5`; `prisma.contract.create` recebe 3.5 numa coluna Int e lança `PrismaClientValidationError` → catch genérico responde 500 em vez de 400. Não corrompe dados. (Ressalva: `customCheckSchema:69` não retorna 500 porque `/custom/check` só usa em `setMonth`, onde JS trunca.)
- **Fix mínimo:** `z.number().int().min(1).max(12)` em `validators.ts:82`.

#### B20 — Lockout de OTP (`MAX_FAILED_ATTEMPTS=5`) não é atômico → tentativas concorrentes excedem o teto por alvo
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** concurrency
- **local:** `backend/src/lib/otp.ts:45`
- **Resumo:** `verify()` lê o contador (43), decide no `failCount>=MAX` (45), executa awaits (`redis.get code` em 52) e só então `redis.incr` (63). Read-check e increment separados por awaits, não-atômicos: chamadas concorrentes leem a contagem stale, todas passam o gate.
- **Cenário:** atacante dispara N `verify` quase simultâneos para um alvo; cada um roda até o 1º await e cede antes de qualquer `incr` — todos leem `failCount<5` e avaliam N palpites contra o código ativo. O teto de 5/alvo não vale sob concorrência (limitado só pelo `authLimiter` 15/15min por IP). Enfraquece defesa-em-profundidade; não concede takeover (código expira em 5min, cooldown, limiters). Daí LOW.
- **Fix mínimo:** tornar o contador autoritativo — `const newCount = await redis.incr(failKey); if(newCount===1) await redis.expire(...); ` e gate em `newCount>MAX`; ou serializar read+compare+incr com Lua/lock por alvo.

#### B21 — Cooldown de send-code é get-then-set não-atômico → requisições concorrentes furam o throttle de 30s
- **kind:** residual · **verdict:** CONFIRMED · **categoria:** anti-abuse
- **local:** `backend/src/lib/otp.ts:81`
- **Resumo:** o throttle é check (`isOnSendCooldown`, `redis.get` em 81) seguido depois de set (a chave só é escrita em `otp.ts:36`, **após** o e-mail ser entregue). Sem atomicidade, sends simultâneos observam "sem cooldown" e todos chamam `generateAndSend`.
- **Cenário:** rajada de send-code concorrentes para um alvo; todos passam antes de qualquer write (que ainda espera o `deliverOtpEmail` resolver, alargando a janela). Vítima recebe rajada de OTPs numa janela; código ativo sobrescrito repetidas vezes. Limitado por `otpLimiter` (5/15min) por IP; amplifica email-bomb com IPs distribuídos. Daí LOW.
- **Fix mínimo:** adquirir o cooldown atomicamente no início — `redis.set(cooldownKey,'1','EX',SEND_COOLDOWN_SECONDS,'NX')` e retornar 429 quando o `NX` falhar.

---

## SEÇÃO 2 — Bugs novos

`kind=new`, agrupados por área, ordenados por severidade dentro de cada área.

### Área: Pagamentos e faturamento (backend)

#### B22 — Renovação de contrato CUSTOM cobrada com 4 sessões/mês fixas (ignora `sessionsPerCycle`) e não gera agendamentos
- **kind:** new · **verdict:** CONFIRMED · **severidade:** HIGH · **categoria:** money
- **local:** `backend/src/modules/contracts/contract.payments.ts:588`
- **Resumo:** `client-renew` não copia `sessionsPerCycle/sessionsPerWeek/totalSessions/customSchedule/addonCredits/accessMode` (ficam null); `/pay` então precifica CUSTOM pelo `sessions_per_month` global (4) em vez do ciclo real, e nenhum booking é criado.
- **Cenário:** CUSTOM ativo com 2 sessões/semana (ciclo real 8×R$180=R$1.440) entra em `isExpiring`; `RenewContractModal`→`clientRenew` (sem guard de tipo) cria renovação AWAITING_PAYMENT sem `sessionsPerCycle`. `/pay` (ramo não-SERVICO) usa `sessions_per_month=4` → R$720/mês (~50% a menos), replicado nos meses 2..N. `generateBookingsForRenewedContract` retorna cedo para não-FIXO → **0 bookings**. Cliente paga contrato subfaturado e não recebe gravação (ou superfatura se o plano tinha <4 sessões/ciclo). Distinto de A4 (que corrigiu só `computeMonthlyAmount` p/ `/subscribe`).
- **Fix mínimo:** em `client-renew`, ao renovar `type==='CUSTOM'` copiar os campos do original; fazer `/pay` usar `computeMonthlyAmount` (que ramifica CUSTOM por `sessionsPerCycle`) em vez do cálculo inline; e estender `generateBookingsForRenewedContract` para CUSTOM a partir de `customSchedule/customDates`.

#### B23 — CUSTOM "Datas Livres" fatura `round(N/meses)×meses` sessões, ≠ N datas realmente agendadas
- **kind:** new · **verdict:** CONFIRMED · **severidade:** MEDIUM · **categoria:** money
- **local:** `backend/src/modules/contracts/contract.creation.ts:521`
- **Resumo:** no modo `frequency='CUSTOM'`, `sessionsPerCycle=round(customDates.length/durationMonths)`; o valor cobrado = `sessionsPerCycle×durationMonths×preço`, que só iguala o nº de datas quando N é múltiplo de `durationMonths`. Bookings são criados 1:1 com as N datas → billed ≠ delivered (viola o invariante C8).
- **Cenário:** admin seleciona 10 datas, `durationMonths=6`: `round(10/6)=2` → cobra 12 sessões, entrega 10 (**overcharge de 2**). Inverso 10/3: `round=3` → cobra 9, entrega 10 (subfatura). 8/3 → cobra 9, entrega 8. O frontend usa a mesma fórmula, então o total exibido bate com a cobrança mas não com a contagem de datas — discrepância silenciosa. Só via admin.
- **Fix mínimo:** no modo CUSTOM-dates, derivar a cobrança de `totalSessions (=customDates.length)`: distribuir `N×preço-com-desconto` pelas M parcelas (resto na última), espelhando o cap C8 já aplicado ao ramo WEEKLY.

#### B24 — `charge.refunded` marca o pagamento REFUNDED total mesmo em estorno PARCIAL
- **kind:** new · **verdict:** CONFIRMED · **severidade:** LOW · **categoria:** payments-integrity
- **local:** `backend/src/modules/webhooks/routes.ts:273`
- **Resumo:** o handler `charge.refunded` flipa o Payment inteiro para REFUNDED sem checar `charge.refunded` (boolean) nem comparar `amount_refunded` com `amount`; o evento também dispara em estornos parciais (com `refunded=false`).
- **Cenário:** admin estorna R$50 de R$500 pelo dashboard Stripe. O `updateMany` marca REFUNDED. No relatório: `paidRevenue` deixa de contar o row e `refundedAmount` soma R$500 cheios (quando só R$50 foram estornados). Não há perda de dinheiro (Stripe tratou certo), só o relatório local distorce; menos comum. Daí LOW.
- **Fix mínimo:** só marcar REFUNDED em estorno total — verificar `charge.refunded===true` (ou `charge.amount_refunded>=charge.amount`) antes do `updateMany`.

### Área: Integridade de crédito (backend)

#### B25 — Crédito FLEX/CUSTOM decrementado fora de transação com `booking.create` → crédito perdido se o create falhar
- **kind:** new · **verdict:** CONFIRMED · **severidade:** MEDIUM · **categoria:** data-integrity
- **local:** `backend/src/modules/bookings/booking.creation.ts:449`
- **Resumo:** no `POST /api/bookings` (caminho por plano), o decremento atômico de `flexCreditsRemaining` (411-414) / `customCreditsRemaining` (433-436) roda como statement autocommitado, separado do `prisma.booking.create` (449-464). Se o create lançar após o decremento já comitado, o crédito foi consumido mas nenhuma reserva existe e não há compensação.
- **Cenário:** FLEX com 5 créditos. `updateMany` decrementa → 4 (comitado). `prisma.booking.create` lança (queda/timeout de conexão). O catch só libera locks e re-lança → 500. Crédito fica em 4 sem booking; nenhum cron devolve (booking de plano tem `holdExpiresAt=null`, e aqui nem booking existe). Retry decrementa de novo. Gatilho raro (falha de infra entre 2 statements), mas é perda de crédito pago sem recuperação. Contraste com `/bulk`, que envolve decremento+createMany em `$transaction` (fix C6).
- **Fix mínimo:** envolver o decremento (+ eventual `flexCycleStart`) e o `booking.create` numa única `prisma.$transaction`, como no `/bulk`. Alternativa: re-incrementar o crédito no catch quando o decremento foi aplicado.

### Área: PWA / Service Worker (frontend)

#### B26 — Fallback offline nunca serve `offline.html` (`caches.match` não bate na chave revisionada do Workbox)
- **kind:** new · **verdict:** CONFIRMED · **severidade:** MEDIUM · **categoria:** correctness
- **local:** `frontend/src/sw.ts:82`
- **Resumo:** `setCatchHandler` serve a página offline com `caches.match('/offline.html')`, mas o Workbox precacheia sob a chave revisionada `'/offline.html?__WB_REVISION__=<hash>'`. Com `ignoreSearch=false` (padrão), o match por URL exata nunca encontra a entrada → usuário recebe o texto cru "Offline" (503).
- **Cenário:** `injectManifest` + glob `**/*.html` + arquivo estático sem hash → revision atribuído. Usuário instala PWA, fica offline e navega para um deep link nunca visitado (ex.: `/meus-pagamentos`) → `NavigationRoute` falha → cai no catch handler → `caches.match('/offline.html')` retorna `undefined` → `new Response('Offline',{status:503})`. A `offline.html` estilizada (6,3 KB) nunca aparece.
- **Fix mínimo:** importar `matchPrecache` de `workbox-precaching` e usar `const cached = await matchPrecache('/offline.html');` (resolve via `getCacheKeyForURL`) — já disponível no workbox 7.4.0. Alternativa: `caches.match('/offline.html', { ignoreSearch: true })`.

#### B27 — Ícone e badge das notificações push usam `.svg` — não renderizam no Chrome Android
- **kind:** new · **verdict:** PLAUSIBLE · **severidade:** LOW · **categoria:** ui
- **local:** `frontend/src/sw.ts:96`
- **Resumo:** o handler de push define `icon`/`badge` como `'/icons/icon-192.svg'` (96-97). Sendo o app mobile-first (alvo Android), e o Chrome Android historicamente não renderizando SVG em ícone/badge de notificação, as notificações tendem a aparecer sem ícone/badge apesar de existirem os PNGs equivalentes.
- **Cenário:** backend envia push → `showNotification` com `icon/badge = .svg`. No Chrome Android o SVG não é decodificado; `icon-192.png` (presente em `public/icons`, usado no manifest) renderizaria. **PLAUSIBLE** porque a falha depende de comportamento externo do navegador, não reproduzível só lendo código.
- **Fix mínimo:** trocar `icon`/`badge` (96-97) para `'/icons/icon-192.png'` (ou um badge PNG monocromático dedicado), que já existem.

### Área: Configuração / cache (frontend)

#### B28 — Cache module-level de business config nunca é invalidado após o admin salvar (`invalidateFrontendConfigCache` é código morto)
- **kind:** new · **verdict:** CONFIRMED · **severidade:** MEDIUM · **categoria:** stale-cache
- **local:** `frontend/src/components/admin/settings/SettingsBusinessConfigSection.tsx:100`
- **Resumo:** `useBusinessConfig` guarda a config num cache module-level populado uma vez por sessão. Existe `invalidateFrontendConfigCache()` documentada como "Call this after admin saves business config", mas o grep só acha a **definição** — nunca é chamada. `handleSaveConfigs()` faz o PUT e mostra sucesso sem invalidar.
- **Cenário (corrigível pelo fix, mesma sessão do admin):** admin muda `discount_6months` 40→50 e `booking_min_advance_hours` 12→2, salva. Em seguida, na MESMA sessão, abre `CreateContractModal`/`CustomContractWizard` ou navega para `CalendarPage`: todos leem o cache antigo (40% / 12h) até um reload completo. (No fluxo de contrato o valor cobrado vem do backend/quote — a divergência é de **exibição/gating**, não de cobrança. Staleness cross-session é inerente a cache client-side e não é o que o fix conserta.)
- **Fix mínimo:** em `handleSaveConfigs()`, após `updateBusinessConfig()` bem-sucedido, importar e chamar `invalidateFrontendConfigCache()`. Para reflexo imediato em componentes já montados, disparar também um refetch das telas afetadas.

### Área: Relatórios / timezone (frontend)

#### B29 — Relatórios derivam o range `from/to` em UTC (`toISOString`), deslocando a janela 1 dia à noite (SP)
- **kind:** new · **verdict:** CONFIRMED · **severidade:** LOW · **categoria:** timezone
- **local:** `frontend/src/pages/AdminReportsPage.tsx:26`
- **Resumo:** `getDateRange()` monta `to` (e a base de `from`) a partir de `new Date().toISOString().split('T')[0]` — data-calendário em UTC. Entre ~21:00 e 23:59 SP (UTC-3) o `toISOString()` retorna SP+1, deslocando toda a janela 1 dia à frente. `AdminDashboard.tsx:90` já usa `todayStrSaoPaulo()`; esta página não.
- **Cenário:** admin abre Relatórios "7 dias" às 22:00 de 03/09; `to='2026-09-04'`, `from` cai em '2026-08-28' (ambos +1). Backend `end=to+1` → janela efetiva [28/08, 04/09] em vez de [27/08, 03/09]: reservas de amanhã (SP) entram no summary e o dia mais antigo sai. Ocorre só ~3h/noite; de dia o range fica correto. Daí LOW.
- **Fix mínimo:** derivar `to` de `todayStrSaoPaulo()` (`frontend/src/utils/time.ts`) e calcular `from` subtraindo os dias sobre essa data SP, em vez de `new Date().toISOString()`. (Obs.: `saoPauloParts` **não** existe em `utils/time.ts` — só `studioSlotDate` e `todayStrSaoPaulo`.)

---

## Lacunas remanescentes (o que ainda não foi coberto)

Áreas onde a auditoria não teve alcance total ou onde a verificação estática não pôde ser conclusiva:

1. **Sem execução dinâmica.** Todos os achados são estáticos (leitura de código). Nenhuma corrida de concorrência (B3, B10, B20, B21, B25) foi reproduzida sob carga real; a magnitude do DoS de B9 depende de timeout/lock do Postgres, **não** medida. As janelas temporais foram derivadas do código, não cronometradas.

2. **Comportamento de plataforma externo não verificável.** B27 (SVG em push no Chrome Android) ficou **PLAUSIBLE** — precisa de teste em device real. Idem qualquer suposição sobre renderização de notificações push/badge por SO/versão.

3. **Conciliação de pagamentos externos.** Confirmou-se a ausência de cron de conciliação Stripe (B1), mas **não** foi auditada a completude dos handlers de webhook Stripe além de `invoice.payment_succeeded`/`charge.refunded` (ex.: `invoice.payment_failed`, `customer.subscription.deleted`, disputes/`charge.dispute.created`), nem a idempotência ponta-a-ponta dos webhooks Sicoob/Cora sob replay.

4. **Dependência de timezone do servidor.** B8/B18 assumem servidor em UTC (default de container). A auditoria **não** confirmou o TZ de runtime do ambiente de produção; sob servidor SP alguns desses displays acertariam (mas a convenção UTC-anchored do codebase permanece inconsistente).

5. **Staleness cross-session de config.** B28 cobre só a mesma sessão do admin. A propagação cross-session/cross-device de mudanças de business config (inerente a cache client-side) **não** tem solução mapeada (ex.: invalidação via push/polling/versionamento).

6. **Cobertura de testes automatizados.** Não foi avaliada a suíte de testes: se os fixes da rodada 1 (e estes achados) têm testes de regressão, nem se os caminhos "direct-API-only" (B11, B12, B17) têm cobertura — hoje eles escapam da UI e, por isso, de qualquer smoke test manual.

7. **Invariante billed==delivered (C8) fora dos ramos auditados.** B4 e B23 mostram violações do teto de sessões em `/resume` e no modo "Datas Livres". Não foi feita varredura sistemática dos **demais** caminhos que geram bookings/parcelas (ex.: `weekPattern`/BIWEEKLY em cenários de borda, add-on credits, reagendamentos em massa) contra o mesmo invariante.

8. **Superfície admin.** Vários achados são "admin-gated" (B5, B6, B17, B23). A auditoria assumiu o admin como confiável; **não** cobriu autorização granular (RBAC) nem trilha de auditoria das ações destrutivas de admin (hard-delete, cancelamento de contrato).
