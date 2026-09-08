# Planos FIXO e FLEX — os textos fazem sentido? (análise + testes)

**Data:** 2026-09-08
**Método:** 9 agentes (6 reconciliando cada texto contra o código + 3 debatendo a viabilidade do FLEX e desenhando os testes) + testes executados **no código** (11 unit novos + 5 integração time-travel, todos passando) e **no browser** (contador FLEX + detecção de conflito FIXO ao vivo).
**Estado:** análise + testes prontos e verdes; **nenhuma correção de produto foi feita** (só um seam de testabilidade). Os bugs abaixo estão documentados, não corrigidos.

---

## 1. Veredito por texto

| # | Texto (intenção) | Faz sentido? | Implementado? | Resumo |
|---|---|---|---|---|
| 1 | **FIXO** gera todos os dias futuros + 2ª etapa só com os dias ocupados p/ "trocar pra antes/depois" | Em parte | Parcial | A 2ª etapa **existe** (Wizard, Step 7), mas troca **horário no MESMO dia**, não outro dia (antes/depois). Dia lotado → grava **por cima** (overbooking). |
| 2 | **FLEX**: 1/semana, banca gravando adiantado, come crédito se atrasa | Em parte | **Sim** | Modelo de *banking* semanal — é a versão **limpa e correta** da sua intenção. "5 numa semana → 5 semanas livres" bate exato. "não come até o mês vigente" é fuzzy; o modelo é por-**semana**. |
| 3 | Correr o tempo pro futuro e ver se come os créditos | Sim | Parcial | Come **correto** p/ contratos ancorados (provado por 5 testes). Furo: **marcação em lote não ancora** `flexCycleStart` → job nunca confisca. |
| 4 | Contador "gasto vs esperado" + regra "semanas ≥ créditos" | Em parte | **Sim** | O contador existe (backend `shortfall` + UI "Usados/Restantes/Perdidos" + timeline semanal). Suas 2 formulações ("IF total<4", "semanas ≥ créditos") estão **embaralhadas/invertidas**; o código faz o mesmo conceito de forma limpa. |
| 5 | Remarcação (até 1 semana) bate de frente com o forfeiture | Sim | Parcial | **Tensão real e confirmada.** `reschedule_max_days=7` = janela FLEX de 7d. Remarcar **dentro do direito** pode cruzar a fronteira e **confiscar 1 crédito permanente**. |
| 6 | Renovação **1x só**, janela **até 7 dias à frente** | Sim | **Não** | Só bloqueia renovação **pendente** duplicada. Depois de paga, dá p/ renovar de novo, **sem limite** e **sem janela de 7 dias**. |
| 7 | Valor do 1º dia **÷ 7** = nº de créditos | (decisão de produto) | **Não** | Créditos vêm de config fixa (`episodes_3months=12` / `_6months=24`), **não** de valor÷7. Recomendação: **manter fixo** (mais previsível), descartar valor/7. |

**Conclusão geral:** os textos **fazem sentido** e correspondem, no essencial, ao que o sistema faz — o FLEX está bem implementado (banking semanal) e o contador existe. As divergências reais são: (a) o "swap" do FIXO é de horário no mesmo dia, não de outro dia; (b) o FLEX **pune** quem remarca dentro do direito e quem perde 1 semana e compensa depois (forfeiture monotônico/permanente); (c) renovação-única e valor/7 **não existem**.

---

## 2. Testes executados

### Código — unit (111 no total, **+11 novos**, todos ✔)
- `test/flex-forfeit.test.ts` (7): cobre `targetForfeit` (grandfather, monotônico, clamp, negativos) — antes só existia no script manual.
- `test/flex-credits.test.ts` (+4): banking **4→5** semanas, banking **2** semanas (o "contador" −1/−2), borda exata de fim de ciclo, múltiplas gravações no mesmo dia.

### Código — integração time-travel (**5 novos**, todos ✔) — `test/integration/flex-credit-expiry.test.ts`
Roda o **job real** (`runFlexCreditExpiryJob`) contra o DB `_test`, "correndo o tempo":
- **I1**: 1 gravação, +5 semanas → confisca **4**, `remaining=7`, notifica. ✔
- **banking**: 5 gravações na 1ª semana, +5 semanas → confisca **0** (bancou 5 semanas). ✔ *(seu caso exato "5 numa semana")*
- **I2**: grandfather na 1ª rodada (só grava o floor, sem perda) → depois confisca **1/semana** → idempotente. ✔
- **I4**: janela fechando sem gravação → **aviso** "em risco", sem confiscar. ✔
- **GAP FALTA**: 5 faltas (no-show) contam como gravação → **não confisca** (documenta o bug). ✔
- Seam necessário: `runFlexCreditExpiryJob(now = new Date())` — injeção de tempo, **retrocompatível** (o cron chama sem args).

### Browser (servidores locais, cliente logado)
- **Contador FLEX** (Meus Contratos → Plano Flex): "**Créditos: 11 restantes de 12**", "**Usados 1 · Restantes 11**", **timeline de 12 semanas** (Gravada / Esta semana / Perdida / Futura) e as regras em texto — é o "gasto vs esperado" que você descreveu. ✔
- **Conflito FIXO** (`POST /api/contracts/check-fixo` ao vivo): `available:false`, **12 conflitos**, e as alternativas são **todas do mesmo dia** (`altDatesAllSameDay:true`; ex.: 15/09 14:00 → sugere 15/09 **13:00**). Confirma que o swap **não** oferece outro dia (antes/depois). ✔

---

## 3. Bugs / gaps priorizados

**ALTO**
- **FIXO — overbooking silencioso**: sem `@@unique(date,startTime)` no banco (só índice); dia lotado grava **por cima** do horário ocupado (cliente e admin). `contractFulfillment.ts:286`, `ContractWizard.tsx:1103`, `schema.prisma:44`.
- **FLEX — remarcação confisca crédito indevido**: os dois relógios têm âncoras diferentes; uma remarcação legítima (≤7d) que cruza a fronteira da janela gera `shortfall` e **forfeiture permanente** (monotônico). `booking.management.ts:602-614` × `flexCreditExpiryJob.ts:52`.
- **FLEX — lote não ancora o ciclo**: criação em lote não seta `flexCycleStart` → `computeFlexState` fica `started:false` → job **nunca confisca**. `contract.creation.ts`, `flexCredits.ts:54-63`.
- **FLEX — no-show conta como gravação**: job filtra só `!= CANCELLED`; `FALTA`/`NAO_REALIZADO` evitam o forfeiture (contradiz "se não gravar, come crédito"). ⚠ Corrigir **isolado** agrava a colisão com a remarcação — tem de vir junto. `flexCreditExpiryJob.ts:21`.

**MÉDIO**
- **FLEX — 84 dias (12 janelas) vs ~90-92 dias de calendário**: a partir do dia 84 o modelo exige as 12 gravações; a "cauda" do mês vigente é confiscada e novos bookings são barrados por "créditos esgotados". `flexCredits.ts:67`, `booking.creation.ts:108`.
- **Renovação** sem trava "1x" nem janela "7 dias" (só bloqueia pendente duplicada). `contract.payments.ts:544-550`.
- **Timezone**: `getUTCDay` (check/admin) vs `getDay` local (fulfillment/renovação) — fora de UTC o dia validado pode diferir do gerado. `contract.checks.ts:20` × `contractFulfillment.ts:274`.
- **FIXO admin**: não deixa escolher a alternativa (só read-only + "Forçar Criação"); texto "Remanejamento no fim do ciclo" é enganoso (não há remanejamento). `CreateContractModal.tsx:586-605`.
- **Renovação FIXO** regenera bookings **sem** checagem de conflito. `paymentEffects.ts:154`.

**BAIXO / produto**
- Valor/7 não implementado — recomenda-se **descartar** (contagem fixa é mais previsível).
- `check-fixo` faz N consultas por slot/dia (custoso p/ 12-24 semanas; não afeta correção).

---

## 4. Recomendações (do debate)
- **Manter o core** de banking semanal do FLEX (é o mais correto).
- **Reconciliar remarcação × forfeiture**: usar a **data-âncora original** para o pace, **ou** tornar o forfeiture não-monotônico/recuperável até o fim do contrato, **ou** dar de fato os **14 dias** de tolerância que você imaginou.
- **Clampar `weeksElapsed` pelo calendário** (até `endDate`), não por `total×7`.
- Contar só **COMPLETED/CONFIRMED** como gravação para o pace — **junto** com a reconciliação da remarcação (senão fica mais punitivo).
- Re-derivar `cycleStart` da **1ª booking não-cancelada** (e ancorar no lote), não só rebaixar.
- **FIXO**: `@@unique(date,startTime)` + oferecer troca de **outro dia** (antes/depois) + admin poder escolher + rodar o conflito também na **renovação**.
- **Renovação**: flag/contador "renovado 1x" + janela de 7 dias, se realmente desejado.
