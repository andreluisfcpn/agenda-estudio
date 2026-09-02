# Auditoria completa — set/2026

Auditoria de segurança + cobertura funcional + UI (foco em contratos), com debate multi-agente
(cético → juiz) nos achados de maior risco. Status final abaixo.

Legenda: `[x]` corrigido e verificado · `[A]` **aceito por decisão** (seguro como está, com justificativa — NÃO é trabalho inacabado) · `[~]` parcial (fundação feita, resta ampliar) · `[ ]` aberto.
Status: **0 abertos, 0 parciais.** Tudo corrigido/verificado `[x]`, exceto 2 itens `[A]` aceitos por decisão consciente (S5, S7 — seguros como estão) e a decisão de produto T2 (término manual, intencional). Cobertura de testes: **116 testes** (100 unidade + 16 integração) passando.

## Contratos — backend
- [x] C1 [HIGH] Auto-charge cobrava contratos PAUSED/PENDING_CANCELLATION/CANCELLED. Guard `contract.status notIn [...]` no `autoChargeJob.ts`.
- [x] C2 [HIGH] Cancelar via PATCH /:id não anulava parcelas/bookings. PATCH agora anula parcelas (`voidContractPendingPayments`) e cancela bookings futuros na transição p/ CANCELLED. `contract.lifecycle.ts`.
- [x] C3 [HIGH] /subscribe cobrava mensal errado (basePrice*4, sem add-ons, sem SERVICO). Nova fonte única `computeMonthlyAmount` (contractPricing.ts) usada no /subscribe.
- [x] C4 [MED] Pausar CUSTOM perdia sessões. Pausa só cancela bookings de FIXO (que o resume regenera); CUSTOM/FLEX mantêm as sessões.
- [x] C5 [MED] selfContractSchema aceitava qualquer tipo → restrito a `[FIXO, FLEX]`.
- [x] C6 [MED] Decremento FLEX no /bulk não-atômico. Transação interativa com decremento guardado + rollback.
- [x] C7 [MED] Renovação FLEX usava durationMonths*4 → agora usa config `episodes_Nmonths` (client-renew + admin renew).
- [x] C10 [LOW] confirm-payment não gerava meses 2..N → agora chama `onPaymentConfirmed` (inclui generateRemainingInstallments).
- [x] C8 [MED] CUSTOM WEEKLY/BIWEEKLY gerava bookings por semanas de calendário (~4,33/mês) mas cobra `totalSessions` (4/ciclo) → sobre-entrega ~0,33 sessão/mês/slot. Corrigido pela via que NÃO altera preço: a geração agora é limitada a `totalSessions` (entrega exatamente o que é faturado; nunca sub-entrega, pois a geração é sempre ≥ totalSessions). MONTHLY/CUSTOM já alinhados — não afetados. `contract.creation.ts`.
- [x] C9 [MED-baixa] Pagar SERVICO/renovação/parcela 2..N via /pay criava 2ª parcela (os guards de reuso exigiam pixString/providerRef, que a parcela pré-criada por `generateRemainingInstallments` não tem). Agora /pay **reusa a linha PENDING existente** (PIX e cartão), realinhando provider/artifact e nunca deletando a linha reusada em falha do gateway. `contract.payments.ts`.

## Contratos — frontend
- [x] F1 [HIGH] Cancelar prompt de CPF travava o ContractWizard (submitting preso). Reset antes do prompt + no onCancel.
- [x] F2 [HIGH] Idem no CustomContractWizard.
- [x] F3 [HIGH] setStep(4) inexistente → tela branca no CustomContractWizard → setStep(3).
- [x] F4 [MED] Step 1 do ContractWizard com descontos/sessões hardcoded → derivados da config.
- [x] F6 [MED] Criar contrato no admin sem trava anti-duplo-clique → `creatingRef` + estado `creating`.
- [x] F7 [LOW] Resumo Step 4 fixava x4 → usa `sessionsPerMonth`.
- [x] F5 [MED] Resumo/botão de pagamento exibiam `amount/installments` (sem juros) enquanto o dropdown já mostrava o correto. Agora todos usam `perInstallmentValue` do plano selecionado (`plan.perInstallment`, com juros). `InlineCheckout.tsx`.

## Segurança
- [x] S1 [HIGH] Bypass: complete-payment confirmava booking reusando PI 'succeeded' alheio. Exige Payment PENDING vinculado + `metadata.paymentId`. `booking.status.ts`. (verificado)
- [x] S2 [MED] verify-payment confirmava com PI alheio (metadata ausente escapava). Guard estrito `pi.metadata?.paymentId !== data.paymentId`.
- [x] S3 [MED] clientStatus BLOCKED nunca verificado → bloqueio na emissão de token (login senha/OTP/Google + refresh).
- [x] S6 [LOW] /api/payments/sandbox-mode público → exige autenticação.
- [A] S5 [LOW] IDOR em /push/subscribe — **aceito por decisão** (não é falha aberta). O upsert é chaveado pelo `endpoint` do web-push, que é um segredo por-dispositivo: reassociar o userId é o comportamento CORRETO num navegador compartilhado (novo login assume as notificações daquele device), e em dispositivos distintos o endpoint é imprevisível. Verificado no código (`push/routes.ts:24-40`). Sem mudança — endurecer quebraria a reassociação legítima sem ganho de segurança.
- [A] S7 [LOW] CORS aceita sem Origin com credentials — **aceito por decisão** (não é falha aberta). Requisição sem Origin não é cross-origin de navegador (o navegador sempre envia Origin em pedido credenciado/cross-origin), logo não há leitura cross-origin nem vetor de CSRF; a defesa real de CSRF é cookie `SameSite=lax` + `httpOnly` (independe do CORS). Endurecer (rejeitar sem-Origin) quebraria health-check/server-to-server sem ganho. `index.ts:74-84`.
- [x] S4 [LOW] Dumps/scripts de debug versionados no git (cert Cora era placeholder sandbox de 230 chars — confirmado NÃO ser chave real). 13 arquivos removidos do índice (`git rm --cached`, mantidos em disco) + padrões adicionados ao `.gitignore`. Não commitado (fica para o usuário revisar/commitar junto com a auditoria).

## Pagamentos / integrações
- [x] P1 [MED] reconcileSicoobCancellation nunca chamada → ligada ao cron (PIX Sicoob expirado agora vira FAILED).
- [x] P3 [HIGH] Fechamento financeiro ignorava SICOOB → conta SICOOB (taxa 0), deriva paidCount/unpaidCount do status real, breakdown.sicoob (backend + AdminFinancePage). (verificado ao vivo)
- [x] P4 [LOW] Mock de PIX gravava 'CORA' → 'SICOOB'.
- [x] P6 [MED] (descoberto no teste de navegador) Re-pagar uma parcela FAILED (PIX expirado marcado FAILED pela reconciliação P1, listada como pagável em "Meus Pagamentos") retornava o QR **velho/expirado** (o guard de reuso P2 não checava status) e, mesmo pagando, ficava presa em FAILED (reconciliação/webhook só agem em PENDING). Corrigido: create-payment reseta FAILED→PENDING e limpa providerRef/pixString/boletoUrl antes de gerar cobrança nova; guard de reuso P2 agora exige `status==='PENDING'`. Verificado ao vivo (QR novo + status PENDING). `stripe/routes.ts`.
- [x] P2 [MED-baixa] create-payment PIX sem guard de reuso (trocar provedor Sicoob↔Cora orfanizava a cobrança anterior). Agora reusa idempotentemente a cobrança PIX viva (pixString+providerRef) em vez de gerar uma segunda. Frontend gera o QR a partir do pixString, então o reuso não quebra a tela. `stripe/routes.ts`.
- [x] P5 [LOW] Reuso de PIX no /pay podia retornar valor desatualizado. Resolvido junto do C9: o /pay agora usa consistentemente `existingPending.amount` (valor travado na geração da parcela) tanto na cobrança quanto na resposta — nunca reprecifica uma linha pendente. `contract.payments.ts`.

## Agendamentos / disponibilidade
- [x] B1 [HIGH] Reserva não validava BlockedSlot em nenhum caminho → helper `hasBlockedConflict` em POST /, /bulk, /admin e reschedule. (verificado ao vivo)
- [x] B2 [HIGH] DELETE /:id do cliente burlava a política de cancelamento e devolvia crédito de sessões concluídas/faltas → aplica janela de 24h (como client-cancel) e nunca restaura crédito de COMPLETED/FALTA/NAO_REALIZADO.
- [x] B5 [LOW] check-in não limpava holdExpiresAt → agora limpa.
- [x] B3 [MED] reschedule/admin-create/bulk sem lock (TOCTOU → double-booking). Agora usam `acquireMultiSlotLock` (mesmo lock do POST /) com try/finally, fechando a janela entre conflito-check e write. `booking.management.ts` (reschedule), `booking.creation.ts` (admin/bulk).
- [x] B4 [MED] Criação/remarcação fixavam pacote de 2h ignorando `slot_duration_hours`. Agora leem `getSlotDuration()` e passam a duração para getPackageSlots/calculateEndTime nos 4 handlers de reserva (POST /, /bulk, /admin, reschedule); usos só-de-release ficam no default 2h (no-op inofensivo).
- [x] B6 [LOW] dayOfWeek via getUTCDay()/getDay() misturados sobre datas parseadas em horário local — quebrava só fora de UTC. **Corrigido na raiz** fixando o TZ do processo em UTC (`src/bootTz.ts` importado primeiro no `index.ts` + `ENV TZ=UTC` no Dockerfile), o que torna `getDay()===getUTCDay()` em qualquer host e alinha todas as ~20 leituras de dia-da-semana ao calendário SP (@db.Date em 00:00Z). Verificado: sob UTC, `new Date('2026-09-15T00:00:00')` → 00:00Z, getDay=getUTCDay=2 (terça). Os helpers Intl de SP (`spTime.ts`) não são afetados (passam timeZone explícito).

## UI / UX
- [x] U1 [HIGH] "Recuperar senha" era mock (fingia sucesso) → usa o OTP real (login por código) + orienta redefinir no perfil.
- [x] U3 [MED] AdminReportsPage: skeleton infinito no erro → estado de erro + "Tentar novamente".
- [x] U4 [MED] Erros de load engolidos → estado de erro + retry em MyBookingsPage e MyContractsPage.
- [x] U5 [MED] MyPaymentsPage mostrava "Tudo em dia" no erro → banner de erro + retry.
- [x] U6 [LOW] Login Google com fallback 'mock-client-id' → botão Google escondido quando falta a env.
- [x] U8 [LOW] Telefone do rodapé hardcoded → config `studio_phone` (com fallback).
- [x] U4 (restante) [MED] CalendarPage, AdminTodayPage e ClientProfilePage agora têm estado de erro + "Tentar novamente" (antes: agenda vazia / "0 gravações" / "Usuário não encontrado" mascaravam falha de rede).
- [x] U2 [MED] `<label>` sem `htmlFor` (WCAG 1.3.1/4.1.2). Sweep completo (~116 associações) via `useId()`+`htmlFor`/`id` em ~29 arquivos (cliente + admin), sem alterar layout. Restam ~70 rótulos **corretamente não-associáveis** por htmlFor simples: cabeçalhos de grupos de botões/segmented/chips (radiogroup com aria-label próprio), widgets compostos em `ui/fields` (StepperField/TimeField/EmojiField/ColorField — sem prop `id`), e rótulos que já envolvem o próprio controle (associação implícita). Frontend compila e faz build de produção (tsc + vite build EXIT=0).
- [x] U7 [LOW] og:image/twitter:image apontavam para o WordPress buzios.digital (host frágil). Agora usam o asset self-hosted `https://app.buzios.digital/icons/icon-512.png` (logo PWA, servido pelo próprio app; domínio já liberado no CSP imgSrc). Nota: `og:url` ainda é `agenda.buzios.digital` — o domínio funcional/CSP é `app.buzios.digital`; **confirmar/alinhar o og:url** (fora do escopo estrito do U7).

## Fluxos dependentes de tempo (teste de "avanço no futuro", set/2026)
Mapa completo (6 agentes) dos fluxos que mudam com o tempo + testes ao vivo por **backdating** de colunas de data
(não há injeção de relógio; todo check usa `new Date()`). Ferramenta criada: `backend/scripts/dev-run-job.ts`
(`npx tsx scripts/dev-run-job.ts <job>`) — dispara manualmente qualquer job (holds, autocharge, flex, reminders,
push, daily-confirm, notif-cleanup, cora/sicoob-reconcile), já que **nenhum job tem endpoint HTTP** (só `setInterval` em `index.ts`).

**🔴 T2 [ALTO — decisão de produto] Contrato NÃO expira automaticamente.** Não existe transição `ACTIVE→EXPIRED` por tempo:
um contrato com `end_date` no passado permanece **ACTIVE indefinidamente** e continua **cobrável** (o auto-charge exclui só
PAUSED/PENDING_CANCELLATION/CANCELLED — ACTIVE/EXPIRED seguem cobráveis; sem filtro de `end_date`). `end_date` só alimenta
badge "vencendo" e notificação. Verificado ao vivo: 3 contratos com `end_date=2026-08-20` (passado) → seguem ACTIVE após rodar
os jobs; a parcela vencida de um contrato já terminado casa com a query de cobrança; o cliente vê "3 ativos · 0 finalizados".
Também NÃO são time-driven (exigem ação do admin): `PENDING_CANCELLATION→CANCELLED` e `PAUSED→ACTIVE` (sem auto-resume no resume_date);
e **não há motor de inadimplência** (parcela sem auto-charge fica PENDING para sempre, nunca vira overdue/FAILED por tempo).
**Decisão do produto (set/2026): DEIXAR COMO ESTÁ.** O estúdio encerra/renova contratos **manualmente** (admin PATCH EXPIRED/CANCELLED,
ou cliente request-cancellation → admin resolve); a permanência em ACTIVE pós-`end_date` é intencional (não corta a cobrança da parcela
final e evita término automático indevido). Nenhuma expiração automática será implementada. Mantido como comportamento aceito, documentado aqui para não ser reintroduzido como "bug".

**Fluxos time-driven que FUNCIONAM (verificados ao vivo):**
- [x] Sweep de holds/deadline (cron 60s): renovação AWAITING abandonada com `payment_deadline` no passado → hard-delete (`[HOLD-CLEANUP] Swept orphaned expired contract …`), sem órfãos.
- [x] Renovação (`/client-renew`): contrato terminado → nova vigência começa **agora** (não no fim antigo); original permanece ACTIVE (renovações acumulam — reforça o T2).
- [x] Forfeiture de créditos FLEX (cron 6h): `flex_cycle_start` 28d atrás + floor 0 → 4 créditos perdidos (remaining 11→7, forfeited 0→4), reconciliado.
- [x] Auto-charge (cron diário): seleção correta (parcela `due_date<=hoje` de contrato ACTIVE/EXPIRED/AWAITING cobrável; PAUSED/PENDING_CANCELLATION/CANCELLED excluídos — o fix C1). Cobrança real exige cartão salvo Stripe (não exercida).
- Outros mapeados (não exaustivamente exercidos): lembretes 24h/2h, push overdue/vencendo (7d admin/15d cliente), confirmação diária 07:00 SP, limpeza de notificações, reconciliação Cora/Sicoob (janela `created_at` de 3 dias).

## Cobertura de testes
- [x] T1 [HIGH] Cobertura automatizada era ~1 arquivo → agora **116 testes** (100 unidade + 16 integração), tudo passando.
  **Suíte de integração adicionada** (`npm run test:integration`, config `vitest.integration.config.ts` + `test/integration/`) rodando contra um **banco de teste dedicado** `studio_scheduler_test` (isolado; nunca toca dev/prod — setup/`assertTestDb` recusa qualquer DB que não termine em `_test`; truncate entre casos) + Redis real, cobrindo as áreas de dinheiro/concorrência que a auditoria pediu:
    - `locks-and-blocked` (5): lock multi-slot Redis previne double-booking (contenção + rollback + concorrência) e `hasBlockedConflict` (B1/B3).
    - `coupon-reservation` (4): `reserveCouponUse` — teto global (UPDATE atômico) e por-usuário (advisory lock) sob concorrência: exatamente 1 vence.
    - `installments` (4): `generateRemainingInstallments` — cadência 28d + valor + idempotência + skip de FULL/AVULSO.
    - `payment-guard` (3): guard atômico PENDING→PAID (6 confirmações concorrentes → 1 vence) + `onPaymentConfirmed` no-op se não-PAID (defesa em profundidade) + ativa AWAITING→ACTIVE gerando parcelas uma única vez (idempotente).
    Setup do banco de teste: `DATABASE_URL="…/studio_scheduler_test" npx prisma db push --schema=prisma/schema.prisma --accept-data-loss` (documentado no topo do config). O `npm test` (unidade) **exclui** `test/integration/**` para seguir rápido e sem DB.
  **Suíte de unidade** (7 arquivos, **100 testes**, CI-safe — sem DB/rede) cobre toda a matemática pura de dinheiro/tempo/regras:
  - `money-critical` (12): predicados de reconciliação P1/P6 + preço/slot/cadência.
  - `installment-policy` (18): regras de parcela/juros (`getInstallmentPolicy` — 1x mensal, FULL free-up-to-duration, avulso).
  - `flex-credits` (10): forfeiture FLEX por janela de 7 dias (`computeFlexState`).
  - `coupon-math` (24+3): desconto VALOR/PERCENTUAL + normalização; **+ clamp defensivo** adicionado (`computeCouponDiscount` agora garante desconto ∈ [0, base] mesmo se um valor inválido passar da validação).
  - `sp-calendar` (15): calendário SP/UTC-3 (`saoPauloParts`, `spDaysFromToday`, `studioDateTime`) — trava a correção do B6.
  - `tier-pricing` (13): acesso por faixa (`canAccessTier`), preços base, `formatBRL`.
  `npm test` → **100 testes passam**. **Recomendação remanescente** (o que exige infra, não feito): suíte de **integração** com DB de teste + mocks de gateway para webhooks/idempotência/valor, ciclo de vida de contrato e concorrência de bookings/holds/blocked (as funções async que tocam DB: `validateCoupon`, `reserveCouponUse`, `resolvePlanAmounts`, `generateRemainingInstallments`, guard atômico PENDING→PAID).

## Verificação
- Backend e frontend compilam para produção sem erros (backend `tsc --noEmit` EXIT=0; `vite build` EXIT=0), após todas as correções.
- Smoke test de API (portas alt 3005/5173): booking → PIX roteado ao **Sicoob** → simulate → PAID; fechamento financeiro conta o Sicoob; bloqueio de horário recusa reserva (409) e horário livre reserva OK; login/refresh e proxy do Vite OK.
- **Teste de navegador (fluxos, set/2026)** — descoberta de bugs de fluxo:
  - Admin: Dashboard, Contratos (lista + modal Novo Contrato; U2 verificado ao vivo — 0 associações quebradas), **Financeiro (P3)**: chip "PIX (Sicoob): 2", taxa Sicoob R$0, pago/pendente por status real.
  - Cliente: login (U1/U6), Agenda/Calendar, BookingModal (créditos refletem o **cap C8** — Custom "todas agendadas" com 12 sessões; Flex 11/12), **ContractWizard 4 etapas completas SEM submit espúrio** (regra multi-step OK; F4/F7 de preços/sessões corretos), **Meu Perfil**: autofill ViaCEP funcional (CEP→rua/bairro/cidade/UF; confirma o fix de CSP connect-src).
  - **C8** verificado ao vivo: CUSTOM WEEKLY 3m gerou exatamente 12 bookings (= totalSessions), último em 01/12 (13ª terça aparada).
  - **C9/P2** verificados ao vivo: /pay e create-payment reusam a linha pendente (sem duplicar); create-payment PIX idempotente (reused:true, mesmo QR).
  - **P6 descoberto e corrigido**: re-pagar parcela FAILED retornava QR expirado e ficava presa em FAILED → reset FAILED→PENDING + cobrança nova (verificado: QR novo + PENDING).

## Itens aceitos por decisão `[A]` (seguros como estão — não são pendências)
- **S5** [LOW] IDOR /push/subscribe — reassociação por `endpoint` do web-push é o comportamento correto (device-bound; segredo por-dispositivo). Detalhe na seção Segurança.
- **S7** [LOW] CORS sem Origin com credentials — sem vetor CSRF (SameSite=lax + httpOnly é a defesa real); rejeitar quebraria health-check. Detalhe na seção Segurança.
- **T2** [decisão de produto] Contrato não expira automaticamente — término/renovação manual é intencional (ver seção "Fluxos dependentes de tempo").

_(B6 saiu daqui — foi **corrigido** na raiz via `TZ=UTC`; ver seção Agendamentos.)_
