# Auditoria da API Pix Sicoob (produção) × nossa implementação

**Data:** 2026-09-08
**Fonte:** documentação de produção lida ao vivo no Portal Developers Sicoob
(`developers.sicoob.com.br/portal/apis` → **Pix Recebimentos**), cruzada campo-a-campo com
`backend/src/lib/sicoobService.ts`, `pixGateway.ts`, `sicoobReconciliation.ts` e o handler de
webhook (`modules/webhooks/routes.ts`).
**Escopo:** só auditoria (nenhuma mudança de código). Dev/homologação intocados.

---

## 1. Veredito

**A implementação está CONFORME a API Pix Recebimentos de produção do Sicoob.** Todos os pontos
que exercitamos (auth, base, cobrança imediata, consulta, webhook, conciliação) batem com o
contrato de produção — inclusive uma particularidade do Sicoob (`brcode` em vez de `pixCopiaECola`),
que já tratamos por fallback. Não há bug bloqueante para produção. Restam **decisões de refinamento**
(expiração de cobrança não paga, parse de erros, registro de webhook) e o **onboarding** de produção.

---

## 2. Conformidade — doc de produção × nossa implementação

| # | Aspecto | Doc de produção (Pix Recebimentos) | Nossa implementação | Status |
|---|---|---|---|---|
| 1 | **Base URL** | `https://api.sicoob.com.br/pix/api/v2` | Idêntico (`SICOOB_URLS.production.api`) | ✅ |
| 2 | **Autenticação** | TLS mútuo (mTLS) + OAuth2 (padrão Bacen) | OAuth2 `client_credentials` via mTLS; token em `auth.sicoob.com.br/.../cooperado/.../token` | ✅ |
| 3 | **Cert-bound token** | mesmo certificado no token e nas chamadas | Mesmo par cert+chave no token e em toda chamada de produção | ✅ |
| 4 | **Header `client_id`** | não listado como parâmetro (auth é do esquema global) | Enviamos `client_id` em toda chamada | ✅ (superset seguro) |
| 5 | **Endpoint criar cobrança** | `PUT /cob/{txid}` (param único: `txid` path; body `application/json`) | `PUT /cob/{txid}` com `txid` 26–35 alfanum | ✅ |
| 6 | **Corpo da cobrança** | `calendario*`, `devedor`, `loc`, `valor*`, `chave*`, `solicitacaoPagador`, `infoAdicionais` | Enviamos `calendario`, `devedor`, `valor`, `chave`, `solicitacaoPagador` (omitimos `loc`/`infoAdicionais`, opcionais) | ✅ |
| 7 | **Consultar cobrança** | `GET /cob/{txid}` | Idêntico (`sicoobGetCob`) | ✅ |
| 8 | **Resposta da cobrança** | `txid*`, `revisao*`, `status*`, **`brcode`**, `pix[]`, `calendario`, `valor`, `chave`… | Lemos `pixCopiaECola \|\| brcode`, `status`, `pix[]` | ✅ |
| 9 | **Campo do copia-e-cola** | **`brcode`** (não `pixCopiaECola`) — igual ao sandbox | Fallback `pixCopiaECola \|\| brcode` pega o `brcode` | ✅ (fallback essencial) |
| 10 | **Enum de `status`** | `ATIVA`, `CONCLUIDA`, `REMOVIDA_PELO_USUARIO_RECEBEDOR`, `REMOVIDA_PELO_PSP` | Conciliação: `=== 'CONCLUIDA'` (pago) + `startsWith('REMOVIDA')` (cancelado) | ✅ (cobre todos) |
| 11 | **Webhook — registrar** | `PUT /webhook/{chave}` com corpo `{ "webhookUrl": "…" }` | `PUT /webhook/{encode(pixKey)}` com `{ webhookUrl }` | ✅ (nome do campo confere) |
| 12 | **Webhook — consultar/remover** | `GET`/`DELETE /webhook/{chave}` | Idênticos (`sicoobGetWebhook`/`sicoobDeleteWebhook`) | ✅ |
| 13 | **Webhook — recebimento** | Sicoob acrescenta `/pix` à URL; payload `{pix:[{txid,endToEndId,valor,horario,devolucoes}]}` | Expomos `/sicoob` **e** `/sicoob/pix`; parse `body.pix[]` por `txid`; **re-verifica via `GET /cob`** (não confia no corpo) | ✅ |
| 14 | **Conferência de valor** | `valor.original` (string "0.00"); `pix[].valor` recebido | Compara `pix[]`/`original` × `payment.amount` (tolerância 1 centavo) | ✅ |
| 15 | **Escopos** | `cob.read/write`, `cobv.*`, `lotecobv.*`, `pix.read/write`, `webhook.read/write`, `payloadlocation.*` | `cob.read cob.write pix.read webhook.read webhook.write` | ✅ (subconjunto correto p/ cobrança imediata) |
| 16 | **Rate limit** | ~25/s (Pix) | uso << limite | ✅ |

---

## 3. Achados / decisões (nenhum bloqueante)

**A. Cobrança imediata expirada e não paga fica presa em PENDING** *(refinamento)*
A cobrança imediata expira em `calendario.expiracao` (usamos 3600s = 1h). Uma cob **não paga** que
expira normalmente **permanece com `status: ATIVA`** (não vira `REMOVIDA`). Como
`reconcileSicoobCancellation` só marca `FAILED` quando o status começa com `REMOVIDA`, uma cobrança
expirada-sem-pagamento **não é marcada FAILED** — fica `PENDING` até o sweep de 72h desistir.
→ **Decisão:** marcar `FAILED` quando `now > cob.calendario.criacao + expiracao` e não pago (mais
limpo), ou aceitar o sweep de 72h. Impacto: só a exibição do pagamento pendente; sem risco financeiro.

**B. Formato de erro RFC 7807 não é parseado** *(robustez)*
A API retorna erros no padrão Bacen (`Problema` / `Violações` — `type/title/status/detail/violacoes[]`).
Nosso handling é genérico: em `status >= 400` lançamos com o **corpo cru** na mensagem. Funciona (a
info está lá), mas poderíamos extrair `violacoes[].razao` para mensagens melhores ao admin/cliente.
→ **Decisão:** parse opcional do `Problema` para logs/erros mais claros.

**C. Webhook não é auto-registrável pela UI** *(do relatório anterior — segue válido)*
`sicoobRegisterWebhook` existe mas **sem rota/endpoint** (a Cora tem). Sem registrar, a confirmação
depende do cron de conciliação (~2 min); com webhook, é instantânea. `PUT /webhook/{chave}` exige
mTLS autenticado → registrar via backend. Ver `docs/tecnico/sicoob-pix-producao.md` §5.1.

**D. Sem devolução (refund) PIX** *(decisão de feature)*
Não usamos `PUT /pix/{e2eid}/devolucao/{id}` (nem o escopo `pix.write`). Se o negócio precisar de
**estorno via PIX**, requer o escopo `pix.write` + o e2eid (vem no webhook/`GET /pix`). Hoje não há
essa necessidade declarada.

**E. Segurança adicional no webhook** *(opcional, defesa em profundidade)*
Bacen: as notificações trafegam por canal mTLS; o Sicoob permite **whitelist de IP** e/ou **mTLS** no
webhook, sob configuração do suporte. Já somos seguros sem isso (re-verificamos toda notificação via
`GET /cob` autenticado). Recomendável solicitar a whitelist de IP como camada extra.

---

## 4. Go-live de produção (config, não código — o código está pronto)

1. **Certificado** ICP-Brasil **A1 e-CNPJ** do estúdio (chave pública ao portal; privada conosco).
2. **App de produção** no portal (Meus Aplicativos → Nova Aplicação): vincular a chave pública +
   **escopos** `cob.read cob.write pix.read webhook.read webhook.write` → anotar o `client_id`.
3. **Chave PIX** do estúdio cadastrada na conta Sicoob.
4. **Painel** (Integrações → Sicoob → Produção): `client_id`, cert `.pem`, chave `.key`, chave PIX → Testar.
5. **Registrar webhook** com a URL **sem `/pix`** (o Sicoob acrescenta) → `.../api/webhooks/sicoob`.
6. **Trava de ambiente** (nova): em produção (`NODE_ENV=production`) o painel **precisa** estar em
   "produção" — senão o PIX Sicoob fica bloqueado (comportamento seguro pretendido).

---

## 5. Conclusão

O contrato da API de produção foi verificado **campo a campo** contra a implementação e **bate**.
Nenhuma correção de código é obrigatória para operar em produção. Os itens A–E são refinamentos/
decisões de negócio, não bugs. O caminho para produção é essencialmente **onboarding** (§4).
