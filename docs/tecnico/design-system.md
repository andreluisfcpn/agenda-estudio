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
- Indigo/violeta (`#6366f1`, `#818cf8`, `#4f46e5`) e gradientes azul-violeta são
  **proibidos** — substituir por `--accent-gradient-go` ou tokens teal.
- Contraste: nunca `--text-muted` sobre `--bg-elevated` em texto pequeno (4.3:1).

## 2. Superfícies e inputs

Profundidade: página (`--bg-primary`) → card (`--bg-secondary`/`--bg-card`) →
modal (`--sheet-bg`) → input raised (`--bg-elevated`).

- Input em página: `.form-input` (fundo `--input-bg`).
- Input dentro de sheet/card: `.form-input form-input--raised`.
- Label pequeno uppercase de modal: `.admin-field__label` dentro de `.admin-field`.

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

Regra: **inline style só para valor verdadeiramente dinâmico** (cor vinda de
adminMeta, width %). Estrutura repetida = classe.

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

## 6. Acessibilidade (mínimo por página)

- Todo clicável é `<button>`/`<a>` (ou `role="button"` + `tabIndex` + Enter/Espaço).
- Botão ícone-só → `aria-label`. Touch target ≥44px no mobile.
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
