# Design System — Admin (e base compartilhada)

> Referência consultada pelos "loops de melhoria" por página do admin.
> Regra de ouro: **mudança aditiva** em arquivo compartilhado com a área cliente
> (`index.css`, `modals.css`, `bottom-sheet.css`, `BottomSheetModal.tsx`) — nunca
> alterar valor de token/classe existente. Zona livre: `admin-area.css`.

## 1. Paleta e tokens

Tokens em `frontend/src/styles/index.css` (`:root`). **Nunca escrever hex novo em
TSX/CSS do admin** — usar token ou `constants/adminMeta.ts`.

| Papel | Token | Valor | Quando usar |
|---|---|---|---|
| Fundo da página | `--bg-primary` | `#001e26` | body |
| Card/superfície | `--bg-secondary` / `--bg-card` | `#00252d` / `#002e38` | cards, tabelas |
| Elevação/inputs raised | `--bg-elevated` | `#004250` | inputs dentro de sheet/card |
| Fundo de modal (sheet) | `--sheet-bg` | `#091E24` | só via BottomSheetModal |
| Acento (marca) | `--accent-primary` | `#11819B` | bordas, ícones, fundos de destaque |
| **Acento como TEXTO pequeno** | `--accent-text` | `#2FA8C2` | links/labels teal (accent-primary reprova 4.5:1) |
| Sucesso | `--success` / `--success-bg` | `#10b981` | confirmações, disponível |
| Aviso | `--warning` / `--warning-bg` | `#f59e0b` | pendências |
| Perigo | `--danger` / `--danger-bg` | `#ef4444` | erros, destrutivo |
| Info | `--info` / `--info-bg` | `#3b82f6` | neutro-informativo |
| CTA admin | `--accent-gradient-go` | verde→teal | botão primário (`.btn-admin-go`) |

Regras:
- `--status-*` (`available/reserved/confirmed/blocked/cancelled`) é vocabulário do
  **calendário de slots** — não reutilizar como "urgência" genérica; para isso use
  `--danger`/`--warning`.
- `adminMeta.ts` é o source of truth de cor/label/ícone de status e tier em
  componentes (StatusBadge). Os hex de lá são idênticos aos tokens semânticos.
  Status de PAGAMENTO → `PAYMENT_STATUS_META` (nunca `BOOKING_STATUS_META`); contrato
  inclui `AWAITING_PAYMENT` ("Aguard. pagamento") e `COMPLETED` ("Concluído", teal da marca);
  remarcação do avulso → `MAKEUP_STATUS_META`. `getMeta` e o fallback do `StatusBadge`
  procuram a chave em todos os mapas de status (`findStatusMeta`/`getStatusLabel`) —
  **nunca exibir chave crua em inglês** (desconhecida → "—", chave só no `title`).
- Provedor de cobrança exibido como forma de pagamento: `providerToMethod()` /
  `getPaymentBadge()` de `constants/paymentMethods.ts` (SICOOB/CORA → PIX, STRIPE → Cartão).
- Vigência/duração/plano de contrato: `describeContractTerms()` de `utils/contractStatus.ts`
  (avulso = data da gravação + "Sessão única" + "Pagamento único"; plural "mês/meses").
- Indigo/violeta (`#6366f1`, `#818cf8`, `#4f46e5`) e gradientes azul-violeta são
  **proibidos** — substituir por `--accent-gradient-go` ou tokens teal.
- Contraste: nunca `--text-muted` sobre `--bg-elevated` em texto pequeno (4.3:1).

## 2. Superfícies e inputs

Profundidade: página (`--bg-primary`) → card (`--bg-secondary`/`--bg-card`) →
modal (`--sheet-bg`) → input raised (`--bg-elevated`).

- Input em página: `.form-input` (fundo `--input-bg`).
- Input dentro de sheet/card: `.form-input form-input--raised`.
- Label pequeno uppercase de modal: `.admin-field__label` dentro de `.admin-field`.
- **Dinheiro (R$)**: sempre `components/ui/fields/CurrencyInput` (modo "banco": dígitos
  entram da direita — 3-0-0-0-0 = "300,00"; valor em **centavos**; colar "R$ 1.500,00",
  "1.500,00", "450.00" funciona). Props: `value: number|null`, `onChange(cents|null)`,
  `allowEmpty` (opcional → `null`), `max` (padrão R$ 9.999.999,99), `prefix` ('R$' |
  `false`), `id`, `className` (ex.: `form-input--raised`). Nunca reimplementar parse de
  moeda na tela — funções puras em `utils/currency.ts` (`parseBRLToCents`,
  `formatCentsInput`). CSS `.sf-money*` em `settings-fields.css`.

## 3. Modais

**Único componente: `BottomSheetModal`** (sheet com drag no mobile, dialog
centralizado no desktop, focus trap, portal). `ModalOverlay` e o par CSS
`.modal-overlay`/`.modal` estão **@deprecated**.

Prop `size` (desktop; mobile é sempre sheet full-width):

| size | max-width | Uso |
|---|---|---|
| `sm` (default) | 480px | confirmações, forms de 1-2 campos, sheets de cobrança |
| `md` | 640px | forms padrão (editar cliente/agendamento/contrato/cupom) |
| `lg` | 820px | wizards (CreateBooking, CreateContract, Coupon) |
| `xl` | 1000px | wizard denso (CustomContract) |

- `maxWidth` (string) está deprecated — remover ao tocar cada modal; vence `size`
  enquanto existir (retrocompat).
- **2 colunas só em `lg`/`xl` e apenas ≥768px**, via `.admin-grid-2`.
- Estrutura interna admin: `hideHeader` + `.admin-modal-head` → `.admin-modal-body`
  → ações em `.admin-actions-row`; título `.admin-modal-title` com `__icon`.
- Piloto de referência: `components/admin/bookings/EditBookingModal.tsx`.

### 3a. Confirmação de ação destrutiva — `DangerConfirmDialog`

`components/ui/DangerConfirmDialog.tsx` (sobre `BottomSheetModal size="sm"`; CSS em
`danger-dialog.css`). **Todo** diálogo de exclusão/ação destrutiva usa este componente
(direto ou via `showConfirm({ tone })` do `UIContext`). Regra de tom:

| tone | Quando | Visual |
|---|---|---|
| `danger` | **irreversível** (excluir, cancelar contrato, aplicar multa, remover cartão) | vermelho: ícone em círculo `--danger-bg`, borda/acento vermelho, selo "Irreversível", botão `.btn-danger-solid` |
| `warning` | **reversível**, mas com impacto (pausar, isentar multa, marcar pago, desativar gateway) | âmbar, botão `.btn-warning-solid`, sem selo |

- `confirmLabel` sempre verbo explícito ("Excluir cliente", nunca "Confirmar");
  `consequences` lista o que acontece de fato; `requireText="EXCLUIR"` para exclusões
  de alto impacto (sem diferenciar maiúsculas).
- `onConfirm` assíncrono: o diálogo aguarda com spinner e bloqueia Esc/fundo/Voltar;
  se lançar, a mensagem aparece **dentro** do diálogo (lance o erro em vez de só dar toast).
- Foco inicial no "Voltar"; botões `type="button"`; sem `<form>` (Enter no campo de
  digitação confirma só quando o texto confere).
- `showConfirm` **sem** `tone` mantém o diálogo genérico legado (fecha na hora) — só
  para confirmações neutras (renovar, retomar, enviar aviso).
- **Empilhado sobre outro sheet** (ex.: "Padrão" no `EventTemplateModal`, "Bloquear" no
  `EditClientModal`): renderize o `DangerConfirmDialog` com `zIndex={1100}` e ponha
  `preventClose` no sheet de baixo enquanto ele estiver aberto — o Esc do `BottomSheetModal`
  é global e fecharia os dois.
- Quando a lista recarrega com spinner (desmonta a tela), atualize o estado local no
  `onConfirm` em vez de recarregar, para não desmontar o diálogo no meio (ex.: Serviços).

### 3b. Padrão de wizard admin

Casca canônica do `CreateBookingModal`: `BottomSheetModal hideHeader` →
`.admin-modal-head` (título + `<WizardSteps>`) → `.admin-modal-body` (erro em
`.admin-alert--danger` no topo, **sempre visível**) → blocos `{step === N && (…)}` com o
rodapé `.admin-actions-row` DENTRO de cada bloco (`btn-admin-ghost`/`btn-admin-go`).

Estado com `hooks/useWizardStep(total)` → `{ step, next, back, goTo, reset, isFirst, isLast }`.
**Regras anti-submit espúrio (obrigatórias)**:
1. Sem `<form>`; todo `<button>` com `type="button"`.
2. Keys distintas nos botões do rodapé (`key="cancel|back|next|submit"`).
3. Avançar SEMPRE com `next()` (adia 1 tick com `setTimeout 0`); `back`/`goTo` são síncronos.
4. Guard no salvar: `if (!isLast) return;` — e validar TODAS as etapas (com `allowJump`
   é possível chegar ao fim sem passar pelas anteriores); erro de campo da API → `goTo(etapa do campo)`.
5. **Nunca** trava por tempo (ignorar cliques por N ms engole o salvar legítimo).
6. Testar com clique REAL de mouse (clique sintético não reproduz o bug).

`<WizardSteps steps current onStepClick={goTo} allowJump={isEdit} />`: sem `allowJump`,
só passos concluídos são clicáveis (voltar); com `allowJump` (modo edição), qualquer
passo diferente do atual ("Ir ao passo N: …").

## 4. Utilities admin (`admin-area.css`)

| Classe | Uso |
|---|---|
| `.admin-card` (`--lg`, `--interactive`, `--active`, `--accent`) | cards/seções |
| `.admin-kpi-grid` (`--compact`) | grid de KPIs auto-fit |
| `.admin-grid-2` / `.admin-grid-3` | grids que colapsam no mobile |
| `.admin-table--cards` + `data-label` em cada `<td>` | tabela→cards <768px |
| `.admin-field` + `.admin-field__label` | campo empilhado com label uppercase |
| `.admin-form-row` | campos lado a lado com wrap automático |
| `.admin-filter-bar` (+`__search`) | barra de busca/filtros da página |
| `.admin-pills` + `.admin-pill(--active)` | pills de filtro/segmento |
| `.admin-actions-row` | rodapé de ações (column-reverse + full-width ≤640px) |
| `.btn-admin-go` / `.btn-admin-ghost` | CTA primário / secundário (≥44px) |
| `.admin-icon-btn` (`--danger`) | ação ícone-só com touch target garantido |
| `.admin-status-select` | select compacto de status em linha de tabela |
| `.admin-alert--danger/--warning` | erro/aviso inline em modal |
| `.admin-modal-head/body/foot`, `.admin-modal-title(+__icon)` | estrutura de modal |
| `.admin-save-bar` (`--stacked`) | barra flutuante de salvar |
| `.admin-hover-bg` | hover de linha sem JS |
| `.admin-wizard-steps` (via componente `WizardSteps`) | passos de wizard (dots + conector, aria-current) |
| `.admin-section-header` (via componente `SectionHeader`) | cabeçalho numerado de seção de form |
| `.admin-avatar` (`--sm/--lg`) | círculo de iniciais (gradiente por tier segue inline) |
| `.admin-input-icon` | ícone lucide dentro de input (padding-left 36px) |
| `.admin-empty` (`__icon/__title/__hint` + CTA opcional) | empty state padrão |
| `.dash-kpi-grid/.dash-kpi-card`, `.dash-card-head` | dashboard (Centro de Comando) |

Componentes compartilhados do admin (`components/admin/`): `AdminPageHeader`,
`WizardSteps`, `SectionHeader`, `ChargeNowSheet` (sheet de cobrança imediata —
embrulha o InlineCheckout; nunca alterar as props repassadas a ele).

Regra: **inline style só para valor verdadeiramente dinâmico** (cor vinda de
adminMeta, width %). Estrutura repetida = classe.

## 4b. Componentes base (`components/ui/`, compartilhados admin + cliente)

- **`Tooltip`** (`ui/Tooltip.tsx`, CSS `tooltip.css`): `<Tooltip content placement?
  ('top'|'bottom'|'left'|'right') disabled? delay?=250 describe?=true>{um elemento focável}</Tooltip>`.
  Bolha em portal no `<body>` com `position: fixed` (não é cortada por `overflow`),
  inverte/limita às bordas, z-index `--z-tooltip` (1100, acima de `--z-modal`). Abre no
  hover de mouse/caneta e no foco por teclado (`:focus-visible`); **nunca no toque**.
  Fecha em pointerdown, Escape (só a dica — o modal por trás não fecha), scroll e resize.
  Compõe os handlers do filho (o filho precisa repassar `onPointer*`/`onFocus`/`onBlur`
  ao DOM). `describe={false}` quando o `aria-label` do gatilho já diz o mesmo.
  Substitui `title=` nativo e tooltips feitos só com CSS.
- **`DangerConfirmDialog`**: ver §3a.
- **`fields/CurrencyInput`**: ver §2.
- **`PixQrCode`** (`components/PixQrCode.tsx`, CSS `pix-qrcode.css` + classes
  `.checkout-*` de `checkout.css`): bloco PIX presentacional — valor, QR (usa
  `qrCodeDataUrl` do backend ou gera localmente com `qrcode`), contagem "Expira em mm:ss"
  (`useCountdown`, cores canônicas dos timers), copia-e-cola com feedback e, ao expirar,
  "QR expirado" + "Gerar novo QR" (`onRegenerate`). Sem imagem possível → orientação
  para usar o copia-e-cola (nunca spinner eterno). Não chama API nem faz polling.

## 4c. Navegação (Sidebar + barra inferior)

Fonte única: `config/nav.ts` (`CLIENT_NAV`/`ADMIN_NAV`). Página nova = UMA entrada lá.

- **Sidebar recolhida** (desktop, Ctrl+B): cada item (inclusive o expansível
  Configurações e o bloco do usuário) usa `<Tooltip placement="right"
  disabled={!collapsed} describe={false}>` + `aria-label` quando recolhida. Não recriar
  tooltip em CSS dentro da `.sidebar-nav` (o `overflow` corta).
- **Barra inferior** (mobile ≤768px, `BottomTabBar`): **no máximo 5 slots iguais**
  (`MOBILE_BAR_SLOTS`, `flex: 1 1 0`), **sem rolagem horizontal nem setas**. Lista com até
  5 itens (cliente) → todos na barra. Lista maior (admin) → só os itens `mobilePrimary: true`
  (máx. 4: Início, Agenda, Hoje, Sessões) + aba **"Mais"**, que abre um `BottomSheetModal`
  com o excedente agrupado por `section` (item ativo destacado; fecha ao navegar). Item novo
  sem `mobilePrimary` cai sozinho no "Mais". Rótulo da barra = `shortLabel ?? label`
  (curto: slot de ~72px a 360px).
- Item ativo = rota exata **ou aninhada** (`isNavItemActive`: `/admin/contracts/:id` ativa
  Contratos; na barra, a aba "Mais" fica ativa quando a rota pertence ao excedente).
- Contrato: manter a classe `.bottom-tab-bar-wrap` e a altura de 64px (`--bottom-tab-h`) —
  o `BottomSheetModal` mede o wrap para abrir acima da barra, e a save bar/banner PWA se
  posicionam por essa altura. Tooltip não aparece no toque (barra não usa Tooltip).

## 5. Animação

- **Somente `transform` e `opacity`** em animações (+ `color`/`border-color` em
  transitions de estado). Proibido `transition: all` e animar
  `width`/`height`/`max-height`/`box-shadow`.
- Durações: `--transition-fast` (100ms) micro-feedback, `--transition-base`
  (200ms) hover/fade, `--transition-slow` (350ms) entrada de modal. Teto: 350ms.
- Keyframes canônicos: `fade-in`, `rise-in` (index.css). Efeito "pulso/ripple":
  `today-ripple` (::after com scale/opacity). **Não injetar `<style>` via JS.**
- Reduced-motion: catch-all global cobre tudo em stylesheet (mais um motivo para
  não animar via JS). Nenhuma informação pode depender só de animação.
- framer-motion: exclusivo do BottomSheetModal. GSAP: não usar (removido).
- Hover só sob `@media (hover: hover)`; feedback de toque via `:active`.

## 5b. Ícones

**Emoji como ícone estrutural é proibido no admin** (botões, títulos de seção,
labels, badges de estado). Usar lucide-react, com `aria-hidden` quando decorativo.
Tamanhos: 13px (label de campo), 14-16px (botão/badge), 16-18px (ícone-só/título
de seção/KPI), 40-48px (empty state, com opacity .35 via `.admin-empty__icon`).

Mapa canônico (emoji → lucide): 🏁 `Flag` · ❌ `XCircle` · ✏️ `Pencil` · 🗑️ `Trash2` ·
limpar filtro `FilterX` · 📋 `ClipboardCheck` · 🚨/⚠️/🟠 `AlertTriangle` · 🔴 `AlertCircle`
(ou `Radio` p/ ao-vivo) · 🟡 `Clock` · 📈 `TrendingUp` · 🔜 `CalendarClock` · ✅ `CheckCircle2` ·
✓ `Check` · 🎯 `Target` · 📅 `CalendarDays` · 🏖️/😴 `Moon` · 📭 `Inbox` · 🔎 `Search` ·
🎟️ `TicketPercent` · 💰 `Wallet` (`CircleDollarSign` p/ multa) · 🆓 `HandCoins` · 🚫 `Ban` ·
🔄 `RefreshCw` · ⏸️/▶️ `Pause`/`Play` · 📂 `FolderOpen` · 💾 `Save` · ➕ `Plus` · 📄 `FileText` ·
📌 `Pin` · ⚡ `Zap` · ✨ `Sparkles` (`Wand2` p/ CUSTOM) · 💳 `CreditCard` · 👤 `UserRound` ·
👥 `Users` · 👋 `UserMinus` · 🧩 `Puzzle` · 🔗 `Link2` · 🔒 `Lock` · ⏰ `Clock` · 🏦 `Landmark` ·
🏢🎤🌟 **`TIER_META[tier].icon`** (nunca redeclarar TIER_EMOJI) · 📊 `BarChart3` · 👁️ `Eye` ·
💬 `MessageCircle` · 🌎 `Globe` · 🏆 `Trophy` · 📥 `Download` · ✂️ `Scissors` · ✉️ `Mail` ·
📝 `NotebookPen` · 🪪 `IdCard` · 📱 `Smartphone` · ⏳ em CTAs → remover (texto basta).

**Ficam como emoji**: toasts e texto corrido, 🥇🥈🥉 do ranking, dados vindos da
API/config (paymentMethods `emoji`, ícones de serviço/`EmojiField`).

## 6. Acessibilidade (mínimo por página)

- Todo clicável é `<button>`/`<a>` (ou `role="button"` + `tabIndex` + Enter/Espaço).
- Botão ícone-só → `aria-label`. Touch target ≥44px no mobile.
- Botão ícone-só → `aria-label` **+ `<Tooltip>`** (dica visível no desktop/teclado; no
  toque ela não aparece, então o ícone precisa ser reconhecível no contexto).
- Ação destrutiva → `DangerConfirmDialog` com o tom certo (§3a).
- `:focus-visible` visível (as utilities novas já trazem outline `--accent-text`).
- Erro de form → `role="alert"` (`.admin-alert--danger`).

## 7. Checklist dos loops por página

1. Zero hex/rgba hardcoded no `.tsx` (tokens ou adminMeta)
2. Zero indigo/violet
3. Sem `<style>` injetado via JS
4. Animações só transform/opacity, 150–300ms, reduced-motion ok
5. Hover/focus 100% CSS (nada de onMouseEnter para estilo)
6. Clicáveis semânticos + teclado
7. `aria-label` em ícone-só; dialog com título anunciado
8. Touch ≥44px no mobile
9. 375px sem scroll horizontal (tabelas `admin-table--cards`)
10. Skeleton no loading inicial
11. Empty state em lista filtrável
12. Modais com `size` correto, sem `maxWidth` mágico
13. Console limpo em 375/768/1440
14. Diff só de apresentação (zero mudança em hooks/API/payloads)

## 8. Área do Cliente (rodada 4)

A área do cliente mantém **identidade colorida própria** (decisão de produto): tom por página — violeta em Gravações/Resultados, teal em Contratos, verde/vermelho em Pagamentos e Dashboard (estado), ciano no Perfil. NÃO alinhar ao padrão neutro do admin.

### Tokens de acento (`client-area.css`, zona livre do cliente)
`--client-accent-violet #8b5cf6 · --client-accent-teal #2dd4bf · --client-accent-blue #3b82f6 · --client-accent-pink #ec4899 · --client-accent-purple #a855f7 · --client-accent-cyan #33c4e0`

### Hero do cliente
`client-hero` + `client-hero__header` (ícone + título). O icon-wrapper usa **modifiers** em vez de style inline: `--success / --danger / --violet / --teal / --cyan` (valores exatos migrados 1:1 — conferir git blame antes de alterar). Margens de `__greeting/__message` dentro do `__header` vêm do CSS (não repetir `style={{margin}}`).

### Hooks compartilhados
- `hooks/useIsMobile(768)` — detecção de viewport; o `BottomSheetModal` usa 640 DE PROPÓSITO (sheet vs dialog), não migrar.
- `hooks/useCountdown(deadline, onExpire)` — contagem regressiva 1s com `onExpire` em ref (o interval NÃO recicla quando o caller passa arrow function nova). Usado por HoldCountdownCell, PendingPaymentCard, AwaitingPaymentBanner e HoldBanner. Cores canônicas dos timers: `--danger` (≤60s), `--warning` (≤180s), `--warning-strong`/`--success` (calmo).

### Agenda (compartilhada admin+cliente)
`CalendarPage` é orquestrador (estado/fetch/modais); o DOM vive em `components/calendar/CalendarMobileView` e `CalendarDesktopView`; constantes em `calendarShared.ts` (DAYS/TIER_COLORS/GRID_ROWS). Slots passados = "Encerrado"; bloqueados pelo estúdio = "Bloqueado"; ocupados = "Ocupado". Estilos novos da grade vão ADITIVOS em `index.css` (nunca em admin-area.css).

### ErrorBoundary
Dois níveis (página no Layout + AppRoutes). Crash de render mostra fallback pt-BR com "Recarregar" em vez de tela branca.

### Exceções documentadas (NÃO migrar para tokens)
- `TIER_COLORS` (calendarShared): paleta vívida da grade escura, compartilhada com o admin — difere dos `--tier-*` de propósito.
- Hex do **recharts** (ResultsChart): `var()` não é confiável em presentation attribute SVG passado como prop.
- **Cores de marca** de plataformas (YouTube/TikTok/Instagram/Facebook): são dados, não tema.
- `SEVERITY_META` do NotificationBell (`#dc2626/#d97706/#3b82f6`): red-600 não tem token equivalente (--danger é red-500).
- Estilos **dinâmicos** (width % de progresso, background de avatar com foto) ficam inline.

### Rotas
URLs do cliente em português: `/minhas-gravacoes`, `/meus-contratos`, `/meus-pagamentos`, `/meus-resultados`, `/perfil`, `/calendar`, `/dashboard`. As antigas `/my-bookings` e `/my-contracts` são redirects permanentes em App.tsx — NÃO remover (bookmarks/PWA/notificações persistidas).
