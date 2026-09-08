# Sicoob PIX em Produção — Documentação × Implementação

**Data:** 2026-09-03
**Escopo:** Análise de toda a documentação do Portal Developers Sicoob (API Pix / Pix
Recebimentos, Segurança, Aplicativos de Produção, Primeiros Passos, Sandbox) comparada
com a nossa implementação, para usar o PIX corretamente em produção.

**Arquivos da nossa implementação analisados:**
- `backend/src/lib/sicoobService.ts` — cliente OAuth2 + mTLS, cobranças, webhook helpers
- `backend/src/lib/sicoobReconciliation.ts` — conciliação (fonte de verdade via GET /cob)
- `backend/src/modules/webhooks/routes.ts` — handler do webhook Sicoob
- `backend/src/modules/integrations/*` — CRUD/teste de credenciais
- `frontend/src/components/IntegrationSettings.tsx` — UI de configuração

---

## 1. Veredito

**A implementação está CONFORME o padrão Sicoob/Bacen. Não há bug de código bloqueante
para produção.** O que falta é essencialmente **onboarding/configuração** (criar o
aplicativo de produção no Portal, certificado ICP-Brasil, chave PIX do estúdio, ativar
os escopos) — não código.

Há **1 melhoria de código recomendada (não bloqueante):** o registro do webhook
(`PUT /webhook/{chave}`) existe no serviço, mas não está ligado a nenhuma ação do admin
(a Cora tem botão "Registrar Webhook"; o Sicoob não). Mesmo **sem** o webhook, o PIX
funciona: a **conciliação por cron** confirma/expira os pagamentos pendentes via
`GET /cob/{txid}` a cada ~2 min. O webhook só torna a confirmação **instantânea**.

---

## 2. Conformidade — Requisito Sicoob × Nossa implementação

| # | Requisito (documentação Sicoob) | Nossa implementação | Status |
|---|---|---|---|
| 1 | **Auth:** OAuth2 `client_credentials` sobre **mTLS** | `sicoobAuth()` faz POST no token endpoint com cert+chave (mTLS) | ✅ |
| 2 | **Token URL:** `https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token` | Idêntico | ✅ |
| 3 | **API base:** `https://api.sicoob.com.br/pix/api/v2` | Idêntico | ✅ |
| 4 | **Cert-bound tokens** (proof-of-possession, RFC 8705 §3): o MESMO cert no token e em toda chamada de API | `sicoobAuth` e `sicoobFetch` usam o mesmo par cert+chave (Agent HTTPS) | ✅ |
| 5 | **Certificado:** ICP-Brasil **A1 e-CNPJ** do cooperado, EKU Client Authentication (1.3.6.1.5.5.7.3.2); chave pública no Portal, privada só com o cooperado | Config aceita `certificatePem` (público) + `privateKeyPem`; a privada nunca sai do nosso backend | ✅ (depende do cert real do estúdio) |
| 6 | **Escopos** (Pix Recebimentos): `cob.write cob.read pix.read webhook.read webhook.write` (+ cobv/lotecobv/payloadlocation/pix.write p/ recursos que **não** usamos) | `SICOOB_SCOPES = 'cob.read cob.write pix.read webhook.read webhook.write'` | ✅ (subconjunto correto p/ cobrança imediata) |
| 7 | **Endpoints:** `PUT/GET /cob/{txid}`, `PUT/GET/DELETE /webhook/{chave}` | Todos implementados; txid 26–35 alfanumérico | ✅ |
| 8 | **Webhook — URL de registro SEM `/pix`:** o Sicoob **acrescenta `/pix` automaticamente** e faz **POST** na URL final | Registramos `…/api/webhooks/sicoob`; expomos `POST /sicoob` **e** `POST /sicoob/pix` | ✅ |
| 9 | **Webhook — payload:** `{ "pix": [ { txid, endToEndId, valor, horario, devolucoes } ] }` | Handler faz parse de `body.pix[]`, casa por `txid` → `providerRef` | ✅ |
| 10 | **Webhook — canal seguro (mTLS/IP), payload sem assinatura** | **Nunca confiamos no corpo:** cada notificação dispara `GET /cob/{txid}` (autenticado) antes de dar baixa | ✅ (postura correta) |
| 11 | **Conferência de valor** antes de confirmar | `reconcileSicoobPayment` compara `valor` recebido/original × `payment.amount` (tolerância 1 centavo); baixa atômica PENDING→PAID | ✅ |
| 12 | **Rate limit** 25/s (Pix) | Uso nosso muito abaixo | ✅ |
| 13 | **TLS 1.2+ forward secrecy, sem cert self-signed** | HTTPS gerenciado (Dokploy) + cert ICP-Brasil | ✅ |

---

## 3. Checklist de Go-Live (PIX em produção)

Passos de **configuração** (não exigem alterar código):

1. **Certificado** — obter/usar o **ICP-Brasil A1 e-CNPJ** do estúdio (com EKU *Client
   Authentication*). Exportar a **chave pública** (`.pem`/`.crt`/`.cer`) e guardar a
   **chave privada** (`.key`). O Sicoob **nunca** pede a chave privada.
2. **Criar o aplicativo de produção** — Portal Developers → *Meus Aplicativos* → *Nova
   Aplicação*. Autenticar (cooperativa/conta + código no app Sicoob). **Vincular a chave
   pública** do certificado. Selecionar a API **Pix Recebimentos** com os escopos:
   `cob.read`, `cob.write`, `pix.read`, `webhook.read`, `webhook.write`.
3. **Anotar o `client_id` de produção**.
4. **Cadastrar a chave PIX do estúdio** na conta Sicoob (será o `chave` das cobranças).
5. **Configurar no admin** (Configurações → Integrações → Sicoob → aba **Produção**):
   `client_id`, **Certificado mTLS (.pem)** (público), **Chave Privada (.key)**, **Chave
   PIX**. Salvar → mudar o **ambiente para Produção** → **Testar** (deve autenticar
   OAuth+mTLS).
6. **Registrar o webhook** — URL **SEM `/pix`**:
   `https://<seu-domínio>/api/webhooks/sicoob`
   O Sicoob acrescenta `/pix` e passa a fazer POST em `…/api/webhooks/sicoob/pix`
   (que já tratamos). Ver §5 sobre **como** registrar (hoje não há botão).
7. **Ligar o interruptor** do provedor **Sicoob** (PIX) no admin.
8. **Produção:** garantir que `ALLOW_UNVERIFIED_WEBHOOKS` **não** esteja `true` (é flag
   de dev, afeta o Stripe; o webhook Sicoob já é seguro por re-verificação) e que
   `BACKEND_URL`/origem pública esteja correta.
9. **(Opcional, defesa em profundidade)** solicitar ao suporte Sicoob **whitelist de IP**
   e/ou **mTLS** no webhook.
10. **Teste de fumaça:** gerar uma cobrança real pequena, pagar pelo app do banco e
    confirmar que o pagamento vira **PAID** (instantâneo com webhook, ou em ≤2–3 min pela
    conciliação).

---

## 4. Detalhes que a documentação exige — e como já atendemos

- **Webhook (o ponto mais sensível):** o integrador cadastra a URL **sem** `/pix`; o
  Sicoob adiciona `/pix` e faz **POST** com um lote `{pix:[…]}`. Como as notificações
  Bacen **não são assinadas** (segurança é o canal mTLS/IP), a postura correta é **não
  confiar no corpo** — nós relê­mos `GET /cob/{txid}` (autenticado) antes de dar baixa.
  Isso já está implementado e é idêntico ao que fazemos com Cora/Stripe.
- **Cert-bound tokens:** o Resource Server valida que o certificado usado no TLS da
  chamada é o mesmo vinculado ao token. Por isso usamos **o mesmo par cert+chave** na
  obtenção do token **e** em todas as chamadas de API. ✅
- **Rede de segurança (cron):** `reconcilePendingSicoobPayments` varre pendentes das
  últimas 72h e confirma (CONCLUIDA / valor pago ≥ original) ou falha (REMOVIDA_*). Isso
  garante que o PIX funcione mesmo se um webhook se perder — ou se o webhook ainda não
  estiver registrado.

---

## 5. Lacuna de código (1) + recomendações

### 5.1 Webhook Sicoob não é auto-registrável pela UI *(recomendado, não bloqueante)*
`sicoobRegisterWebhook()` / `sicoobGetWebhook()` / `sicoobDeleteWebhook()` existem em
`sicoobService.ts` mas **não estão ligados a nenhuma rota/ação**. A Cora tem
`GET/POST/DELETE /api/integrations/cora/webhooks` + botão "Registrar Webhook na Cora";
o Sicoob **não** tem equivalente. Como `PUT /webhook/{chave}` exige mTLS autenticado, o
caminho natural é pelo nosso backend.

- **Impacto:** sem registrar o webhook, a confirmação depende do cron (~2–3 min). Com o
  webhook, é instantânea.
- **Correção sugerida:** espelhar as rotas da Cora em `integrations.webhooks.ts`
  (`POST/GET/DELETE /api/integrations/sicoob/webhooks`) e adicionar um botão "Registrar
  Webhook no Sicoob" no card Sicoob de `IntegrationSettings.tsx` (hoje só há a caixa de
  URL para copiar). ~40 linhas, sem descaracterizar nada.

### 5.2 Hardening
- `ALLOW_UNVERIFIED_WEBHOOKS` deve ser removido/`false` em produção.
- Solicitar **IP whitelist** e/ou **mTLS** no webhook ao suporte Sicoob.
- **Renovar o certificado A1 antes de expirar** (validade ~1 ano) — cert vencido → 401/403
  em toda a integração PIX.

### 5.3 Nit cosmético
No card Sicoob, os `FileUploadZone` de certificado/chave usam `provider="cora"` (apenas
cor do accent; o `onChange` grava corretamente em `sicoobForm`). Sem efeito funcional.

---

## 6. Referências (Portal Developers Sicoob)

- Catálogo de APIs → **API Pix** (Pix Recebimentos) — endpoints /cob, /webhook, payload
- **Segurança** — OAuth2 + mTLS (RFC 8705), cert-bound tokens, TLS 1.2+, ICP-Brasil A1
- **Aplicativos de Produção** — criação do app, upload da chave pública, escopos
- **Primeiros Passos** — fluxo Client Credentials + mTLS; cadastro
- **Sandbox** — credenciais públicas de teste (sem cert)
