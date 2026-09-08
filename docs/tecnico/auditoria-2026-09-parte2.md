# Auditoria completa (Parte 2) — set/2026 · backlog

> ## ✅ STATUS: TODOS OS 36 ACHADOS CORRIGIDOS (2026-09-03)
> Todos os itens abaixo (A1–A25 + L1–L12) foram corrigidos. Verificação:
> - **Compilação:** backend `tsc --noEmit` EXIT 0 · frontend `tsc --noEmit` EXIT 0 · `npm run build` (backend+frontend+PWA) EXIT 0.
> - **Testes:** 100 unidade + 16 integração passando.
> - **Migração nova:** `20260903000000_add_payment_charged_amount` (coluna `payments.charged_amount` para o fix A1) — aplicada em dev + test; em produção roda no start do container (`prisma migrate deploy`).
> - **Verificado ao vivo (navegador + API):** A12 (salvar config → 200), A14 (socialLinks single-encode), A15 (endereço na resposta de login), L4 (admin fora do diretório), L7 (teste Stripe com erro limpo), L2/L3 (badges corretos + CUSTOM esgotado bloqueado), L5 ("sessões"), L6 (avulso "1"), L11 (CUSTOM "12/12"), L12 ("Cobrança falhou").
> - Regra do dono respeitada: **apenas correção de bug**, nada descaracterizado. Alterações NÃO commitadas — aguardando revisão/deploy.


> **Escopo:** auditoria profunda de **todas** as funcionalidades + teste ao vivo no navegador com banco/servidor local. **Nada foi alterado no sistema** (apenas 1 cupom de teste criado e revertidos os dados de teste do perfil). Todo *fix* sugerido é **apenas correção de bug** — sem mudança de funcionalidade nem redesign.
>
> **Como foi feito:**
> 1. **Auditoria de código multi-agente** (workflow, 13 áreas → verificação adversarial → síntese; 27 agentes, 0 erros). Resultado: **25 achados CONFIRMED** (`A1–A25`).
> 2. **Teste ao vivo no navegador** (servidor local backend :3005 / Postgres :5436 / Redis :6380, frontend :5173; login admin e cliente via OTP bypass 999999). Resultado: **11 achados exclusivos do teste** (`L1–L12`, sendo L9 = confirmação ao vivo de A12) + verificação ao vivo de A12/A14/A15.
>
> *Nota de ambiente:* o `claude-in-chrome` não estava conectado à conta — usei o navegador embutido. Cliques físicos no pane têm imprecisão de coordenada (artefato do pane, **não** bug do app); interações feitas via eventos JS reais.

## Resumo por severidade (consolidado)

| Severidade | Código (A) | Live-only (L) | Total |
|---|---|---|---|
| CRÍTICO | 0 | 0 | 0 |
| ALTO | 5 | 1* | 6 |
| MÉDIO | 12 | 5 | 17 |
| BAIXO/NIT | 8 | 5 | 13 |
| **Total** | **25** | **11** | **36** |

*L7 (Stripe) é MÉDIO→ALTO conforme configuração. L9 é duplicata de A12 (não somada).

**Top prioridade (dinheiro / bloqueio funcional):** A1, A3, A4, A7, A12 (=L9), L7, A2, A18, L11, L12.

---

# PARTE B — Achados exclusivos do teste ao vivo no navegador

> Bugs que só apareceram (ou só foram confirmados) rodando o app. Vários corroboram a Parte A.

### L7 · MÉDIO→ALTO · Stripe `getStripeClient` estoura ("reading 'slice'") com config flat sem secretKey
- **Local:** `backend/src/lib/stripeService.ts:93` (+ `getStripeConfig` ramo flat, linhas 73-79).
- **Repro ao vivo:** /admin/configuracoes?sec=integracoes → Stripe → **Testar** → "Falha na conexão: **Cannot read properties of undefined (reading 'slice')**" (`POST /api/integrations/STRIPE/test` retorna `{success:false, message:"...slice"}`).
- **Causa:** `setup.config.secretKey.slice(-8)` sem guard. O ramo flat/legado de `getStripeConfig` NÃO valida `secretKey` ausente (o ramo dual valida na linha 69). Com config STRIPE flat sem secret (estado do DB de dev), retorna `{config:{secretKey:undefined}}` e o `.slice` estoura.
- **Impacto:** além do teste, `getStripeClient` é usado por cobrança de cartão (`stripeCreatePaymentIntent`, auto-charge). Se em produção o Stripe for habilitado com config flat/legado sem secret, TODA cobrança de cartão estoura com esse TypeError em vez de erro limpo.
- **Fix mínimo:** no ramo flat de `getStripeConfig`, `if (!credentials?.secretKey) return null;` (igual ao dual); ou guardar a linha 93.

### L2 · MÉDIO · Badge de tipo de contrato mostra "Flex" para CUSTOM/AVULSO/SERVICO
- **Local:** `frontend/src/components/admin/bookings/CreateBookingModal.tsx:351-355`.
- **Repro:** /admin/bookings → "Novo Agendamento" → Passo 2 "Vincular a contrato": C8 (CUSTOM), C9 (FLEX) e "Avulso 15/09" (AVULSO) — TODOS exibem "Flex".
- **Causa:** badge binário `c.type === 'FIXO' ? 'Fixo' : 'Flex'` — qualquer não-FIXO vira "Flex".
- **Fix mínimo:** derivar o rótulo de `c.type` real (Fixo/Flex/Personalizado/Avulso/Serviço). Nota: o `BookingModal` do cliente e o `ClientContractsCard` já rotulam certo.

### L3 · MÉDIO · Contrato CUSTOM esgotado continua selecionável no "Novo Agendamento" do admin
- **Local:** `frontend/src/components/admin/bookings/CreateBookingModal.tsx:308`.
- **Detalhe:** `hasCredits = c.type === 'FLEX' ? (flexCreditsRemaining>0) : true` — para CUSTOM sempre `true`. O C8 (CUSTOM, todas as 12 sessões geradas) segue clicável/vinculável. O `BookingModal` do **cliente** desabilita corretamente ("Todas as sessões já estão agendadas") — inconsistência.
- **Impacto:** admin pode vincular gravação além do total do CUSTOM (sobre-alocação / sessão não faturada). Confirmar recusa no backend `bookings.adminCreate`.
- **Fix mínimo:** para CUSTOM, checar sessões restantes antes de habilitar (espelhar o modal do cliente).

### L4 · MÉDIO · Admin aparece no "Diretório de Clientes" e diverge da contagem
- **Local:** `backend/src/modules/users/users.listing.ts` (provável filtro de role só na contagem).
- **Repro:** /admin/clients → KPI "TOTAL 1 clientes" mas a tabela lista 2 linhas ("2 resultados"): Cliente Principal + **Administrador** (badge Admin).
- **Fix mínimo:** excluir role=ADMIN da listagem (ou incluí-lo no total) para consistência.

### L11 · MÉDIO · Contrato PERSONALIZADO (CUSTOM) mostra "0/0 episódios" no cartão do cliente
- **Local:** `frontend/src/components/client/ContractCard.tsx` (derivação de progresso).
- **Repro:** /meus-contratos (cliente) → card "PERSONALIZADO" → "Gravações **0 / 0 episódios** · 0% utilizado". O contrato tem `total_sessions=12` e 12 sessões agendadas; o card FLEX ao lado mostra "1/12" certo.
- **Causa provável:** o progresso usa campos FLEX (flex_credits) e não trata CUSTOM (total_sessions/custom_credits).
- **Impacto:** cliente com plano Personalizado não vê o progresso real das 12 gravações.

### L12 · MÉDIO · "Falha no Cartão" em pagamentos PIX/SICOOB que falharam
- **Local:** `frontend/src/pages/MyPaymentsPage.tsx:101` — `{isFailed ? 'Falha no Cartão' : 'Em Atraso'}` hardcoded.
- **Repro:** /meus-pagamentos → 5 parcelas FAILED, todas com badge "FALHA NO CARTÃO". No DB são `provider=SICOOB` (PIX), não cartão.
- **Extensão:** /notificacoes também mostra 5× "Pagamento com cartão falhou" para as mesmas falhas PIX (o evento recorrente de cartão dispara para falha PIX).
- **Fix mínimo:** rótulo genérico ("Pagamento falhou") ou derivar do provider (PIX/boleto vs cartão), tanto no badge quanto no gatilho da notificação.

### L1 · BAIXO/NIT · Pluralização "1 clientes cadastrados" (Dashboard admin)
- **Local:** card do `AdminDashboard` (CONTRATOS ATIVOS → "1 clientes cadastrados"). Esperado "1 cliente cadastrado".

### L5 · BAIXO · Plural quebrado "sessãoões" (perfil do cliente / Health card)
- **Local:** `frontend/src/components/admin/clients/ClientHealthCards.tsx:34` — `sessão{h.completed !== 1 ? 'ões' : ''}` gera "sessãoões" para contagem ≠ 1. Fix: `sess${...?'ões':'ão'}`.

### L6 · BAIXO · Contrato "Avulso" exibe "24 gravações" no ADMIN
- **Repro:** /admin/contracts e perfil do cliente → avulso "24 gravações · 1m". O DB tem `total_sessions=NULL`. No **cliente** (/meus-contratos) o mesmo avulso aparece correto ("1/1 · uma gravação") → derivação errada só no front admin.

### L8 · BAIXO · URL de webhook mostra `localhost:3001` (backend dev roda em :3005)
- **Local:** integrações → "Webhook Cora/Sicoob" exibem `http://localhost:3001/...`. `integrations.crud.ts:189` usa `BACKEND_URL || http://localhost:${PORT||3001}`; o valor exibido parece STORED antigo. Artefato de dev; em prod usa `BACKEND_URL`. Verificar se não há default hardcoded no front.

### L10 · NIT · Dashboard cliente: "FATURAS ABERTAS ... No prazo" com faturas "Falhou"
- **Repro:** /dashboard (cliente) → KPI "No prazo" enquanto a lista mostra 5× "Falhou". "No prazo" reflete data futura (defensável) mas conflita com o status. Considerar refletir FAILED no rótulo.

## Verificações ao vivo de achados da Parte A

- **A12 (=L9) — VERIFICADO:** editar qualquer seção de Configurações → Salvar → `PUT /api/pricing/business-config` **400 "Dados inválidos"**. Detalhe capturado: o schema exige `value.min(1)` e o front envia TODAS as configs, incluindo `email_smtp_host/user/password/resend_api_key` vazias (índices 34/36/37/39). No estado padrão (sem SMTP) **nenhuma seção salva**.
- **A14 (socialLinks duplo-encode) — VERIFICADO:** salvei Instagram/LinkedIn; no DB `social_links` ficou `"{\"instagram\":...}"` (string de string) e `/auth/me` retorna `socialLinks` como **string**.
- **A15 (toAuthUser dropa 4 campos) — VERIFICADO:** resposta de `login/verify-code` traz só `address, city, state` (faltam `addressNumber, complement, neighborhood, zipCode`); `/auth/me` traz todos.
- **A3/P3/C8/C9/P2/P6 (auditoria anterior):** Financeiro conta Sicoob (taxa 0, 2 pagos); C8 gerou exatamente 12 bookings; parcelas 3×R$840 (cadência 28d). Coupon TESTE10 validado (10% → R$300 vira R$270).

---

# PARTE A — Achados da auditoria de código (25, verificados adversarialmente)

## Pagamentos e Financeiro

### A1 · HIGH · CONFIRMED — Juros de cartão compõem e vazam para PIX/boleto
- **Categoria:** money-pricing · **Área:** Pagamentos · **Local:** `backend/src/modules/stripe/routes.ts:431`
- **Resumo:** `create-payment` (cartão) grava o total **com juros** de volta na coluna base `payment.amount`; sem idempotência no ramo cartão, uma nova tentativa aplica juros sobre valor já com juros (compõe) e o valor inflado contamina PIX/boleto (que leem `payment.amount`).
- **Cenário de falha:** Base R$1.000, 6x com tarifa 10% → PI de R$1.100 e `payment.amount` persistido = 1.100. (A) Cartão recusado → webhook marca PENDING→FAILED; `MyPaymentsPage` lista o FAILED como pagável; o reset FAILED→PENDING **não zera** `amount` → 6x sobre 1.100 = R$1.210. (B) Re-selecionar "novo cartão" após cancelar o form Stripe recobra 1.210. (C) Trocar para PIX após tentar cartão lê `amount=1.100` → PIX de R$1.100 (deveria ser ~base à vista). Os checks de paridade (verify/webhook) não detectam, pois `PI.amount == payment.amount` já no valor inflado.
- **Fix mínimo:** Nunca sobrescrever `payment.amount` (mantê-la imutável como base sem juros) e recalcular o total do parcelamento **sempre a partir da base** a cada chamada. Se a paridade persistido==cobrado for necessária, gravar o total cobrado em coluna separada (ex.: `chargedAmount`) e comparar o PI contra ela. PIX/boleto devem cobrar a base (com desconto PIX quando aplicável).

### A2 · MEDIUM · CONFIRMED — Taxa de Recebimento conta faturas CANCELLED/REFUNDED no denominador
- **Categoria:** correctness · **Área:** Financeiro · **Local:** `frontend/src/pages/AdminFinancePage.tsx:83`
- **Resumo:** `collectionRate = paid / data.payments.length` usa **todas** as faturas do mês, incluindo `CANCELLED` (parcelas anuladas por contrato cancelado) e `REFUNDED` — que o backend exclui de `paidCount`/`unpaidCount` — deflacionando a barra e contradizendo os cartões KPI.
- **Cenário de falha:** `voidContractPendingPayments` marca parcelas PENDING como `CANCELLED` sem tocar em `dueDate`; `/finance/closing` busca por `dueDate` sem filtro de status, então a parcela CANCELLED volta em `data.payments`. Mês com 7 PAID + 0 PENDING + 3 CANCELLED → barra = 7/10 = 70% enquanto 100% do cobrável foi recebido e os cartões mostram "7 pagos / 0 pendentes".
- **Fix mínimo:** Calcular sobre o conjunto cobrável: `denom = data.payments.filter(p => ['PAID','PENDING','FAILED'].includes(p.status)).length`; ou reutilizar `paidCount/(paidCount+unpaidCount)`.

---

## Contratos

### A3 · HIGH · CONFIRMED — Pausar contrato FLEX não congela o relógio de forfeiture (créditos pagos perdidos)
- **Categoria:** erro-de-dinheiro · **Área:** Contratos · **Local:** `backend/src/modules/contracts/contract.lifecycle.ts:555`
- **Resumo:** Ao retomar um FLEX pausado, `endDate` é estendido pelos dias de pausa mas `flexCycleStart` **não** é deslocado; `computeFlexState` mede semanas por wall-clock (`now − cycleStart`) e o `flexCreditExpiryJob` confisca créditos pré-pagos das semanas em que o contrato esteve pausado.
- **Cenário de falha:** FLEX `flexCreditsTotal=12`, `flexForfeitFloor=0` (nunca null → grandfather não roda), `flexCycleStart=2026-08-01`, 1 booking. Pausa 08/08, retoma 07/09 (só estende `endDate`). 1º tick pós-resume: `weeksElapsed=5`, `recordingsWithinElapsed=1` → shortfall=4 → `newForfeited=4`, `remaining` cai de 11 para 7. Forfeiture é monotônico → não volta. O cliente perde 4 créditos só por ter ficado pausado.
- **Fix mínimo:** No `/resume`, para FLEX deslocar `flexCycleStart` pelos mesmos `daysPaused` aplicados ao `endDate` (antes de reativar), congelando o relógio de janelas durante a pausa. Alternativa: acumular/subtrair o tempo pausado no cálculo de `weeksElapsed`.

### A4 · HIGH · CONFIRMED — /subscribe subfatura assinatura CUSTOM (ignora sessionsPerCycle e add-ons por ciclo)
- **Categoria:** money-pricing · **Área:** Contratos · **Local:** `backend/src/lib/contractPricing.ts:150`
- **Resumo:** `computeMonthlyAmount()` só trata SERVICO especialmente; para CUSTOM cai no ramo genérico que usa o `sessions_per_month` global (default 4) e `computeAddonsCost(sessions_per_month)`, nunca lendo `sessionsPerCycle` real nem `addonCredits` por ciclo. É a base usada por `POST /:id/subscribe` para precificar a assinatura recorrente Stripe.
- **Cenário de falha:** CUSTOM WEEKLY, 2 dias/semana → `sessionsPerCycle=8`; tier COMERCIAL R$300 com 40% off → R$180/sessão; ciclo real = 8×180 = R$1.440. Ao clicar "Ativar Recorrência (Stripe)", `computeMonthlyAmount` retorna 4×180 = R$720 → assinatura cobra ~50% a menos em toda cobrança. Qualquer CUSTOM com `sessionsPerCycle>4` subfatura.
- **Fix mínimo:** Ramificar CUSTOM em `computeMonthlyAmount`: usar `contract.sessionsPerCycle × preço-com-desconto do tier + custo de add-ons por ciclo` derivado de `contract.addonCredits`, espelhando `cycleBaseAmount + addonsCostPerCycle` da criação.

### A5 · MEDIUM · CONFIRMED — Auditoria de RENEW/PAUSE/RESUME nunca é gravada (ator sempre undefined)
- **Categoria:** data-integrity · **Área:** Contratos · **Local:** `backend/src/modules/contracts/contract.lifecycle.ts:483`
- **Resumo:** Os handlers de renew (483), pause (527) e resume (584) passam `(req as any).user.id` como ator, mas `req.user` é `{ userId, email, role }` (sem `id`); `performedBy` fica `undefined`, e como a coluna é obrigatória não-nullable o insert lança `PrismaClientValidationError`, engolido pelo `try/catch` de `logAudit` → nenhuma linha é escrita.
- **Cenário de falha:** Admin renova/pausa/retoma contrato → a ação de lifecycle é aplicada e o endpoint retorna 200/201, mas `audit_logs` fica sem registro de RENEWED/PAUSED/RESUMED — a trilha de accountability dessas 3 ações é perdida silenciosamente. Todos os outros 8 call sites de `logAudit` usam corretamente `req.user!.userId`.
- **Fix mínimo:** Trocar `(req as any).user.id` por `req.user!.userId` nas linhas 483, 527 e 584.

### A6 · LOW · CONFIRMED — Renew FIXO gera bookings por span de calendário (sobre-entrega ~1 sessão)
- **Categoria:** correctness-integrity · **Área:** Contratos · **Local:** `backend/src/modules/contracts/contract.lifecycle.ts:462`
- **Resumo:** O laço de bookings do `/renew` FIXO usa `while (cursor < end)` com `end = start + durationMonths` meses de **calendário**, sem o teto `durationMonths × sessions_per_month` que todo outro caminho FIXO aplica. Um mês de calendário ≈ 4,33 semanas → ~1 booking a mais (3m) / ~2 (6m).
- **Cenário de falha:** Renovação FIXO 3 meses (`durationMonths=3`, `sessions_per_month=4` → plano define 12). Início 05/01, `end=05/04`; o laço emite todas as segundas até 30/03 = **13** CONFIRMED bookings. Uma sessão de estúdio entregue além do plano; renovação de 6 meses sobre-entrega ~2. Nunca sub-entrega.
- **Fix mínimo:** Limitar o laço por `totalWeeks = durationMonths × sessions_per_month` com `break`, avançando 7 dias por iteração (espelhando `contract.creation.ts` / `generateBookingsForRenewedContract`).

---

## Agendamentos e Calendário

### A7 · HIGH · CONFIRMED — Serviços extras pagos em reserva por PLANO nunca geram cobrança
- **Categoria:** money · **Área:** Agendamentos · **Local:** `backend/src/modules/bookings/booking.creation.ts:427`
- **Resumo:** Numa reserva vinculada a contrato, add-ons pagos **não inclusos** no plano são somados a `booking.price` e gravados em `booking.addOns`, mas nenhum `Payment` é criado (o bloco de Payment está sob `if (isAvulso)` e é pulado). O serviço prometido na UI é entregue sem ser cobrado.
- **Cenário de falha:** Cliente com plano ativo marca um extra R$150 no `BookingModal`; o botão exibe "Pagar R$150 extras"; `handleUsePlan` cria a reserva e vai direto para "done", sem checkout. No backend, `contractId` presente ⇒ `isAvulso=false`: o custo entra em `price` mas a criação do Payment é pulada. O addon fica órfão não-pago — entregue de graça, ou removido silenciosamente do episódio pelo job `cleanup-orphan-addons`.
- **Fix mínimo:** No caminho de plano do `POST /api/bookings`, quando `data.addOns` contém chaves ausentes de `contract.addOns`, gerar um `Payment` PENDING para o total desses extras (reutilizando a lógica de `POST /:id/addons`, `booking.management.ts:811-846`) e retornar `paymentId`/`clientSecret`; ou rotear `handleUsePlan` para checkout quando `addonsCost>0`. Não incorporar o custo do extra em `price` sem a cobrança correspondente.

### A8 · MEDIUM · CONFIRMED — Teto de sessões do plano FIXO checado sem atomicidade (corrida estoura o limite)
- **Categoria:** concurrency · **Área:** Agendamentos · **Local:** `backend/src/modules/bookings/booking.creation.ts:118`
- **Resumo:** O teto do plano FIXO é validado por *read-then-create* (conta `contract.bookings` lido antes dos locks) sem trava por-contrato nem decremento atômico — diferente de FLEX/CUSTOM, que usam `updateMany` guardado.
- **Cenário de falha:** Contrato FIXO com teto 12 e 11 bookings ativos. O cliente dispara N requisições quase simultâneas para N slots **diferentes**. `acquireMultiSlotLock` só serializa o **mesmo** slot; slots distintos travam chaves distintas → todas as N leem `usedBookings=11 (<12)` e passam. FIXO não decrementa contador algum → N bookings criados, N-1 acima do teto (sessões já pagas que o plano não comporta).
- **Fix mínimo:** Tornar a checagem atômica: `UPDATE` condicional decrementando um contador de sessões usadas do contrato (como o `updateMany` de FLEX/CUSTOM), ou count+create dentro de uma transação com condição no banco, de modo que só uma das requisições concorrentes vença ao atingir o teto.

### A9 · MEDIUM · CONFIRMED — BulkBookingModal libera slots a <30 min (regra real 12h) e aborta o lote inteiro
- **Categoria:** ux-flow · **Área:** Agendamentos · **Local:** `frontend/src/components/BulkBookingModal.tsx:176`
- **Resumo:** O grid de seleção em lote (FLEX) só bloqueia slots a <30 min, mas a disponibilidade não pré-filtra por antecedência e o `POST /bookings/bulk` exige `booking_min_advance_hours` (12h) por slot; a transação é all-or-nothing e aborta o **lote inteiro** no 1º slot <12h.
- **Cenário de falha:** 22:00 (SP) um cliente FLEX seleciona slots de amanhã 09:00 (~11h), que voltam `available:true`. Ao confirmar, o backend faz `throw` no 1º violador → 400 para o lote todo (nenhum booking salvo, commit único). Marcações válidas do mesmo lote são perdidas. (Secundário: `new Date(\`${currentDate}T${s.time}:00\`)` parseado no fuso do navegador diverge de SP fora de UTC-3.)
- **Fix mínimo:** Ler `booking_min_advance_hours` (via `useBusinessConfig`) e usar `studioSlotDate(currentDate, s.time)` para calcular `isPast` com o mesmo limiar (`minAdvanceHours*60`) e fuso da reserva única (`CalendarDesktopView.tsx:137-138`), greyando os slots que o backend rejeitaria.

### A10 · LOW · CONFIRMED — Modal "Ação Indisponível" informa "30 minutos" enquanto a regra é 12h
- **Categoria:** ux-copy · **Área:** Agendamentos · **Local:** `frontend/src/pages/CalendarPage.tsx:684`
- **Resumo:** O texto do `BottomSheetModal` ao clicar num slot bloqueado por antecedência afirma "antecedência inferior a 30 minutos", mas o greying e o backend usam `booking_min_advance_hours` (default 12h).
- **Cenário de falha:** Um slot que começa em 6h é corretamente greyado (`minAdvanceHours=12`). Ao clicá-lo, o alerta mostra texto fixo com "30 minutos", passando número incorreto ao usuário.
- **Fix mínimo:** Interpolar `minAdvanceHours` no texto do alerta (ex.: "no passado, ou com menos de X horas de antecedência"), lendo o valor já disponível na `CalendarPage` (linha 47).

### A11 · LOW · CONFIRMED — Lembretes 24h/2h nunca disparam para sessões noturnas (dia UTC vs data SP)
- **Categoria:** correcao-selecao · **Área:** Agendamentos · **Local:** `backend/src/jobs/bookingReminderJob.ts:37`
- **Resumo:** O pré-filtro da query usa o dia de calendário **UTC** de `rangeStart`/`rangeEnd`, mas `booking.date` é a data SP em 00:00Z. Para sessões cujo instante UTC cai no dia UTC seguinte, ambos os limites caem em D+1 e a reserva (datada em D) nunca é selecionada.
- **Cenário de falha:** Config com bloco <2h (`slot_duration_hours=1`) e slot 22:00 BRT no dia SP D → `startDateTime = D+1 01:00Z`. Nos ticks do lembrete de 2h (e de 24h), `floor(rangeStart)=floor(rangeEnd)=D+1`, e o filtro `date gte D+1 00:00Z AND lte D+1 00:00Z` exclui a reserva datada em D → nenhum lembrete enviado para sessões que começam a partir de ~21:00 BRT. Condicional à config (não ocorre no default).
- **Fix mínimo:** Filtrar por data de calendário SP (converter a janela via `saoPauloParts`) ou alargar o range em ±1 dia (`gte = floor(rangeStart) − 1d`).

---

## Configurações

### A12 · HIGH · CONFIRMED — Salvar seções de Configurações falha com "Dados inválidos" (envia chaves de e-mail vazias)
- **Categoria:** correctness · **Área:** Configurações · **Local:** `frontend/src/components/admin/settings/SettingsBusinessConfigSection.tsx:100`
- **Resumo:** `handleSaveConfigs` envia **todas** as configs carregadas (catálogo mesclado completo, inclusive o grupo `email`), sem filtrar por `groups` nem descartar vazios. Como o PUT valida `value: z.string().min(1)`, qualquer chave de e-mail vazia dispara `ZodError` → 400 "Dados inválidos" e nada é salvo — quebra 6 seções (Gerais, Horários, Financeiro, Políticas, Ambiente, Gravações).
- **Cenário de falha:** Instalação padrão tem `email_smtp_host=''`/`email_smtp_user=''` e segredos vazios. Admin edita "Nome do Estúdio" em Gerais e salva → payload inclui as 4 chaves de e-mail com `value=''` → `parse()` lança no 1º vazio → 400, nenhum upsert. Como só um provedor de e-mail é usado por vez, **sempre** resta ≥1 chave de e-mail vazia → salvamento dessas seções fica quebrado permanentemente. `SettingsEmailSection` não sofre porque filtra vazios de propósito.
- **Fix mínimo:** Em `handleSaveConfigs`, enviar apenas as entradas dos grupos renderizados (filtrar por `group ∈ groups`) e/ou descartar `value===''` antes do `map` (espelhando `SettingsEmailSection.tsx:67-68`). Defesa complementar no backend: no PUT, pular chaves não-secretas vazias em vez de rejeitar o payload inteiro.

---

## Autenticação e Perfil

### A13 · MEDIUM · CONFIRMED — maskEmail remove "+", quebrando registro/login para e-mails com plus-addressing
- **Categoria:** correctness · **Área:** Autenticação · **Local:** `frontend/src/utils/mask.ts:31` · *(consolida 2 achados idênticos)*
- **Resumo:** `maskEmail` roda `/[^a-z0-9@._-]/g` a cada tecla, deletando `+` (e outros chars RFC-válidos), corrompendo silenciosamente e-mails plus-addressed antes do envio. Bloqueia registro e ambos os logins por código para esse grupo.
- **Cenário de falha:** `joao+podcast@gmail.com` vira `joaopodcast@gmail.com` (outra caixa). No registro, o OTP vai ao endereço errado (nunca chega) → signup não completa. Em "Entrar com código"/"Esqueceu a senha?", o lookup no endereço strippado retorna 404 "Conta não encontrada". O backend aceita `+` (só `trim().toLowerCase()`), então a máscara é a única causa. Só o login Google ainda funciona.
- **Fix mínimo:** Incluir `+` na allowlist (`/[^a-z0-9@._+-]/g`) ou parar de filtrar caracteres e só `trim`/`lowercase`, deixando a validação de e-mail do backend rejeitar entradas realmente malformadas.

### A14 · MEDIUM · CONFIRMED — socialLinks gravado com JSON duplamente codificado (links somem ao recarregar)
- **Categoria:** integridade-de-dados · **Área:** Perfil · **Local:** `backend/src/modules/auth/routes.ts:568`
- **Resumo:** `PATCH /auth/profile` faz `JSON.stringify(data.socialLinks)` sobre um valor que o frontend **já** enviou como string JSON, gravando string duplamente codificada; na releitura o parse devolve uma string (não objeto) e os campos ficam vazios; o admin renderiza um `<a>` por caractere.
- **Cenário de falha:** Cliente salva Instagram → frontend envia `'{"instagram":"x","linkedin":""}'` (string) → o schema aceita pelo ramo `z.string()` → o handler re-stringifica e grava dupla. Ao recarregar `/me`, `JSON.parse` retorna uma **string**, `parsed.instagram === undefined` → campos vazios na tela (dado corrompido no banco). No admin, `SocialLinksEditor` faz `Object.entries(string)`, iterando índices de caracteres → lista quebrada de links.
- **Fix mínimo:** Não re-stringificar valor que já é string: `updateData.socialLinks = typeof data.socialLinks === 'string' ? data.socialLinks : JSON.stringify(data.socialLinks)`. Alternativa: o frontend enviar o objeto e deixar o backend serializar uma única vez.

### A15 · MEDIUM · CONFIRMED — toAuthUser descarta 4 campos do endereço estruturado (somem após login/troca de foto)
- **Categoria:** integridade-de-dados · **Área:** Perfil · **Local:** `backend/src/modules/auth/routes.ts:116`
- **Resumo:** O helper `toAuthUser` (login/register/login-por-código/google/upload de foto) monta objeto parcial sem `addressNumber`, `complement`, `neighborhood` e `zipCode` — campos que `/me`, `PATCH /profile` e o type `User` do frontend incluem. Como `setUser`/`updateUser` **substituem** o user no contexto, esses 4 campos ficam `undefined` e aparecem vazios em Meu Perfil.
- **Cenário de falha:** Usuário com endereço completo faz login; `AuthContext.login` faz `setUser(res.user)` e não refaz `/me`. Ao abrir Meu Perfil, `addr` é semeado de `user` → CEP/Número/Bairro/Complemento caem para `''`. Mesmo efeito após trocar a foto. Não há perda no banco (guard de igualdade impede reenvio vazio no Salvar) — é bug de exibição/integridade percebida.
- **Fix mínimo:** Incluir `addressNumber`, `complement`, `neighborhood` e `zipCode` na interface `AuthUserRecord` (109-114) e no objeto retornado por `toAuthUser` (116-122). Nenhuma mudança de select é necessária (login e upload de foto já trazem a linha completa).

### A16 · LOW · CONFIRMED — Mensagem de orientação do "Esqueceu a senha?" é limpa no mesmo tick (nunca renderiza)
- **Categoria:** ux · **Área:** Autenticação · **Local:** `frontend/src/components/LoginModal.tsx:158`
- **Resumo:** No branch `forgot_password`, `setSuccessMessage(...)` (158) é seguido por `navigateTo('login_code')` (159), cujo corpo faz `setSuccessMessage('')` (74); batched no mesmo handler, o valor committado é `''` e o banner verde nunca aparece.
- **Cenário de falha:** Usuário envia esqueci-senha; a instrução "Enviamos um código... redefina sua senha no seu perfil" nunca é exibida — ele vê só o subtítulo genérico da tela de código. Não bloqueia o fluxo (o OTP ainda funciona).
- **Fix mínimo:** Ordenar as escritas: chamar `navigateTo('login_code')` primeiro e depois `setSuccessMessage(...)`; ou passar a mensagem para `navigateTo` (ou fazê-lo não limpar `successMessage` recém-setada).

---

## Relatórios e Dashboards

### A17 · MEDIUM · CONFIRMED — Filtro de data dos relatórios inclui o dia seguinte ao "to" (off-by-one)
- **Categoria:** correctness · **Área:** Relatórios · **Local:** `backend/src/modules/reports/routes.ts:225`
- **Resumo:** `buildDateFilter` monta `filter.lte = (to + 1 dia às 00:00)` com operador **inclusivo**; como `booking.date` é `@db.Date` (midnight UTC), reservas datadas em `to+1` satisfazem `date<=lte` e vazam para todos os relatórios. Além disso, o laço de ocupação usa `d < toDate` (exclusivo) sobre o mesmo `end`, então `to+1` entra no numerador mas não no denominador, inflando a %.
- **Cenário de falha:** `to='2026-09-03'` → `lte=2026-09-04T00:00:00Z`. Uma reserva FIXO de 2026-09-04 (`date=2026-09-04T00:00:00Z`) satisfaz a igualdade e é contada em `/summary`, `/tiers`, `/ranking`. Em `/occupancy`, o numerador inclui esse dia mas o denominador não → % superestimada. O período "até hoje" sempre abrange 1 dia a mais.
- **Fix mínimo:** No branch de `to`, trocar `filter.lte` por limite **exclusivo** (`filter.lt = end`), mantendo o `+1 dia` — assim `to` continua inclusivo e `to+1` fica de fora, alinhando ao laço `d < toDate`.

### A18 · MEDIUM · CONFIRMED — Dashboard admin descarta reservas do dia 1 do mês (skew de fuso)
- **Categoria:** money · **Área:** Dashboards · **Local:** `frontend/src/components/admin/dashboard/AdminDashboard.tsx:97`
- **Resumo:** `getMonthRange()` constrói `monthStart` com `Date(y,m,1)` (hora **local**) e compara contra datas de reserva em UTC-midnight, então toda reserva no dia 1 do mês é excluída de Receita do Mês, da contagem de agendamentos e da taxa de presença.
- **Cenário de falha:** Navegador em UTC-3, set/2026. Reserva CONFIRMED de 01/09 (`b.date` = `2026-09-01T00:00:00Z`); `monthStart = new Date(2026,8,1)` = `2026-09-01T03:00:00Z`; teste `00:00Z >= 03:00Z` é **false** → droppada. `monthRevenue` menos R$400, contagem -1, e um COMPLETED/FALTA no dia 1 sai da Taxa de Presença. Recorre no dia 1 de todo mês em qualquer fuso a oeste de UTC.
- **Fix mínimo:** Comparar na mesma base — construir `monthStart`/`monthEnd` com `Date.UTC(...)`; ou (como o resto do arquivo) comparar prefixos de string de data (`b.date.split('T')[0]` contra um range "YYYY-MM").

### A19 · MEDIUM · CONFIRMED — Calendário público reseta o dia escolhido e pisca spinner a cada 60s
- **Categoria:** ux · **Área:** Dashboards/Público · **Local:** `frontend/src/components/PublicCalendarGrid.tsx:98`
- **Resumo:** O polling de 60s reusa o `fetchData` de mount, que incondicionalmente faz `setLoading(true)` e `setSelectedIdx(firstAvailIdx)`; um refresh de background esconde a lista atrás do `Loader2` e descarta o dia escolhido pelo visitante a cada minuto.
- **Cenário de falha:** Visitante clica na tira da semana para ver sexta (`setSelectedIdx(4)`). 60s depois o `interval` dispara `fetchData` → `loading=true` substitui o bloco de slots pelo spinner e, no sucesso, `setSelectedIdx(firstAvailIdx)` volta a visão para o 1º dia disponível (ex.: hoje). Repete a cada minuto numa superfície crítica de conversão.
- **Fix mínimo:** Separar o refresh de background do load inicial: não chamar `setLoading(true)` nos refetches por intervalo (gate por flag de primeiro-load) e auto-selecionar `firstAvailIdx` só no 1º fetch e na troca explícita de semana (`shiftWeek`), preservando `selectedIdx` nos polls.

### A20 · LOW · CONFIRMED — KPI "Gravações — sessões concluídas" conta faltas como concluídas
- **Categoria:** correctness · **Área:** Dashboards · **Local:** `frontend/src/components/client/ClientDashboard.tsx:93`
- **Resumo:** `historyStatuses` inclui `FALTA` e `NAO_REALIZADO`, e `stats.completedBookings` (= `completedBookings.length`) alimenta o StatCard "Gravações / sessões concluídas", contando faltas e não-realizadas como gravações concluídas.
- **Cenário de falha:** Cliente com 5 COMPLETED + 2 FALTA. `GET /api/bookings/my` retorna tudo exceto CANCELLED, então as FALTA chegam ao dashboard; o filtro por `historyStatuses` dá `length=7` e o card mostra "7 sessões concluídas" quando só 5 foram gravadas.
- **Fix mínimo:** Para esse KPI, contar só `b.status === 'COMPLETED'` (ex.: `completedCount` separado). Manter `historyStatuses` amplo para as linhas de "Últimas Gravações", se surfacear sessões passadas ali for intencional.

---

## Cupons

### A21 · LOW · CONFIRMED — Trocar o cliente-alvo no admin não revalida o cupom aplicado
- **Categoria:** validation-ux · **Área:** Cupons · **Local:** `frontend/src/components/CouponField.tsx:57`
- **Resumo:** O efeito de revalidação tem `userId` nas deps, mas o guard `if (lastValidatedAmount.current === amount) return;` retorna antes de revalidar quando o total não muda. Trocar o cliente-alvo nos fluxos admin não altera o total, então o cupom fica exibido como aplicado com a elegibilidade do cliente **anterior**; a rejeição só aparece no submit.
- **Cenário de falha:** Admin aplica cupom restrito ao cliente A e troca o dropdown para B inelegível; `chargeAmount` independe de `userId` → o guard curto-circuita e nada reseta `appliedCoupon`. Ao criar, o backend cria+reverte bookings/contrato e devolve "Este cupom não está disponível para a sua conta". Sem prejuízo financeiro (falha antes de reservar uso do cupom) — dano é estado enganoso + 1º submit falho. Mesmo padrão em `CreateBookingModal`/`CustomContractModal`.
- **Fix mínimo:** Rastrear também `lastValidatedUserId` e revalidar quando `amount` **ou** `userId` mudar (`if (lastValidatedAmount.current === amount && lastValidatedUserId.current === (userId ?? null)) return;`). Alternativa equivalente: os modais admin resetarem `appliedCoupon` no `onChange` do cliente.

---

## Notificações

### A22 · LOW · CONFIRMED — Notificação CONTRACT_EXPIRING persistida ressurge desatualizada
- **Categoria:** correctness · **Área:** Notificações · **Local:** `backend/src/modules/notifications/notificationService.ts:172`
- **Resumo:** `CONTRACT_EXPIRING` é o único dos três tipos que o `pushNotificationJob` persiste que **não** está em `EPHEMERAL_TYPES`; quando a versão computada deixa de sombrear (contrato ACTIVE com `endDate` já no passado — decisão T2), as linhas com texto congelado reaparecem no sino mostrando "expira em N dia(s)" de um contrato já vencido, e a limpeza de 48h não as remove.
- **Cenário de falha:** Contrato ACTIVE `endDate=2026-09-20`. A partir de ~05/09 o job grava ~1 linha/dia (`CONTRACT_EXPIRING`, texto congelado). Enquanto `endDate>=hoje`, o `GET /notifications` as sombreia. Em 21/09 (ainda ACTIVE, sem auto-expiração) a regra computada para → o sino passa a exibir "expira em N dia(s)" de contrato vencido, persistindo até 90 dias. `PAYMENT_OVERDUE`/`BOOKING_UNCONFIRMED` (os outros dois tipos) são purgados em 48h.
- **Fix mínimo:** Adicionar `'CONTRACT_EXPIRING'` a `EPHEMERAL_TYPES` (linha 172), alinhando-o aos outros dois tipos computados persistidos — a cópia persistida é limpa em 48h e nunca ressurge, sem afetar a versão computada ao vivo.

---

## Interface e Acessibilidade

### A23 · MEDIUM · CONFIRMED — BottomSheetModals empilhados brigam pelo foco (Tab) — trap inferior rouba o foco
- **Categoria:** accessibility · **Área:** Interface · **Local:** `frontend/src/hooks/useFocusTrap.ts:74`
- **Resumo:** `useFocusTrap` adiciona um listener `keydown` em `document` (fase de captura) por trap ativo; com dois `BottomSheetModal` abertos, ambos os handlers rodam a cada Tab e o trap **inferior** (ainda montado) faz `preventDefault()` e puxa o foco para si, prendendo o usuário de teclado no 1º controle do sheet de cima.
- **Cenário de falha:** `BookingDetailModal` (sheet principal) + sheet de serviços, ambos portalled em `document.body`, principal registrado primeiro. Tab → o trap principal roda primeiro (focusables não-vazios: seus controles mantêm `offsetParent` atrás do overlay), foca `M1`; o trap de serviços então vê `activeEl=M1` fora do container e re-foca `S1`. Net: Tab/Shift+Tab sempre volta ao 1º controle do topo → controles posteriores do sheet de compra ficam inalcançáveis (keyboard trap, WCAG 2.1.2 nível A); o foco transita por controles escondidos atrás do overlay.
- **Fix mínimo:** Só o trap do topo deve agir: manter um stack module-level de traps ativos e no-op o handler se o container não for o último registrado; ou anexar o listener ao **elemento container** em vez de `document`, para um trap inferior não conseguir `preventDefault`/redirecionar enquanto um sheet superior está aberto.

### A24 · LOW · CONFIRMED — Scroll-lock do body vaza ao fechar um BottomSheetModal empilhado
- **Categoria:** ui · **Área:** Interface · **Local:** `frontend/src/components/BottomSheetModal.tsx:79`
- **Resumo:** O scroll-lock é um efeito por-instância que seta `document.body.style.overflow='hidden'` e restaura `''` no cleanup, sem ref-counting; fechar o sheet do topo da pilha destrava o scroll de fundo enquanto um sheet inferior ainda está aberto.
- **Cenário de falha:** `BookingDetailModal` (`isOpen` estável → efeito não re-roda) + sheet de serviços que também seta `overflow='hidden'`. Fechar só o de serviços roda o cleanup dele (`overflow=''`) com o principal ainda aberto → a página atrás do modal rola. Mesmo vazamento com o alerta global (`useUI().showAlert`, também um `BottomSheetModal`) empilhado sobre qualquer modal. Presentational, auto-resolve ao fechar o modal de baixo.
- **Fix mínimo:** Tornar o lock stack-aware: um contador module-level de sheets abertos; incrementar e setar `overflow='hidden'` ao abrir, decrementar ao fechar e restaurar o overflow previamente salvo só quando o contador chega a 0 (não hard-codar `''`).

---

## Infraestrutura e Estabilidade

### A25 · MEDIUM · CONFIRMED — Rejeição não tratada em qualquer tick de cron derruba o processo da API
- **Categoria:** crash · **Área:** Infraestrutura · **Local:** `backend/src/index.ts:362`
- **Resumo:** Os 8 runners de cron executam `await redis.set/redis.del` **fora** do `try/catch` e os jobs têm queries de topo (`findMany`) sem `try/catch`; os callbacks de `setInterval`/`setTimeout` são fire-and-forget e não há `process.on('unhandledRejection'/'uncaughtException')`. Um erro transitório de DB/Redis num tick vira rejeição não tratada e, no modo default do Node (v15+), encerra o servidor.
- **Cenário de falha:** Failover do Redis (`maxRetriesPerRequest=3`) faz o `redis.set(lockKey,...)` que abre cada runner rejeitar com `MaxRetriesPerRequestError` fora do `try` → rejeição não tratada → Node aborta. Idêntico para `prisma.payment.findMany` de topo em `sicoobReconciliation.ts:114` (fora de try/catch). Com 8 jobs de 60s–5min, coincidir com um blip de infra derruba (e pode crash-loop) a API por uma falha recuperável.
- **Fix mínimo:** Adicionar `process.on('unhandledRejection', err => console.error(...))` (e opcionalmente `'uncaughtException'`) no bootstrap para logar sem abortar, e/ou envolver o corpo de cada runner (o `redis.set/del` inclusive) em `try/catch`, de modo que uma falha de tick nunca escape como rejeição não tratada.

---

## Lacunas de cobertura

Funcionalidades óbvias que as áreas auditadas **podem não ter coberto** e valem uma passada dedicada:

1. **Autorização / RBAC / IDOR:** nenhum achado sobre endpoints admin sem gate de papel, ou cliente acessando dados/reservas/pagamentos de outro cliente (ownership). Vale auditar os middlewares de `role` e a checagem de posse por recurso.
2. **Webhooks (Stripe/Sicoob):** só o *crash* da reconciliação (A25) foi tocado. Idempotência dos handlers de webhook, verificação de assinatura e ordem/duplicidade de eventos não foram auditadas a fundo.
3. **Reembolso / estorno / restauração de créditos:** cálculo do valor reembolsado e restauração de créditos/sessões ao cancelar ou deletar reserva não aparece (só métricas afetadas por CANCELLED/REFUNDED em A2).
4. **Double-booking / colisão de slot:** só o teto FIXO (A8). A correção do lock multi-slot em si — dois clientes distintos reservando o **mesmo** horário simultaneamente — não foi reauditada.
5. **Rate limiting / anti-abuso:** os `send-code` de OTP (registro, login, esqueci-senha) sem limite aparente — enumeração de contas e flood de e-mail.
6. **Upload de foto de perfil:** validação de tipo/tamanho/origem do arquivo e sanitização não cobertas.
7. **Fuso horário de forma sistêmica:** vários bugs de TZ foram achados pontualmente (A9, A11, A17, A18). É provável haver mais em outros cálculos de data — uma varredura dedicada de conversões UTC↔SP se justifica.
8. **Acessibilidade além de modais:** só focus-trap/scroll (A23/A24). Labels de formulário, contraste de cor e navegação por teclado nas páginas principais não foram auditados.
9. **PWA / offline / push lifecycle:** expiração e renovação de push subscription, comportamento offline e sincronização não foram cobertos.
10. **Cobertura de testes dos caminhos de dinheiro:** pricing, parcelamento/juros (A1), cobrança de extras (A7) e subscribe (A4) careceriam de testes automatizados de regressão.
11. **Prisma drift / migrations:** consistência entre `schema.prisma` e as migrations (histórico conhecido do projeto) não foi verificada nesta rodada.

