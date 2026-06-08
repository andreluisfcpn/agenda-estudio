# Configurações

> Rota: **`/admin/configuracoes`** · Menu: **Configurações** · Acesso: Admin

Página única com **7 seções** que controlam as regras do negócio. Cada seção tem seu próprio botão de salvar e detecta alterações não salvas. Você pode chegar direto numa seção pela query string `?sec=<seção>` (ex.: `?sec=financeiro`). As rotas antigas `/admin/pricing`, `/admin/services` e `/admin/integrations` redirecionam para as seções correspondentes.

## 1. Gerais (`?sec=gerais`)
Dados do estúdio: nome, logo, e-mail e informações de contato.

![Gerais](../images/admin/config-01-gerais.png)
<!-- TODO screenshot: seção Gerais -->

## 2. Horários (`?sec=horarios`)
Faixas de horário, rótulos de intervalo, dias de operação e duração do bloco. As constantes base (09:00–23:00, slots de 30 min, seg–sáb) estão em `config.studio` ([setup-dev.md](../tecnico/setup-dev.md)).

![Horários](../images/admin/config-02-horarios.png)
<!-- TODO screenshot: seção Horários -->

## 3. Financeiro (`?sec=financeiro`)
Preços por **tier** (Comercial/Audiência/Sábado), descontos de fidelidade e taxas (cartão/PIX/boleto).

![Financeiro](../images/admin/config-03-financeiro.png)
<!-- TODO screenshot: seção Financeiro com preços e descontos -->

## 4. Políticas (`?sec=politicas`)
Multa de cancelamento (%), janela de remarcação e demais regras de agendamento.

![Políticas](../images/admin/config-04-politicas.png)
<!-- TODO screenshot: seção Políticas -->

## 5. Serviços (`?sec=servicos`)
Serviços extras (add-ons): nome, preço e se são **mensais** ou **por gravação** (ex.: Cortes com IA, Cortes por Editor, Roteiro & Pautas, YouTube SEO, Gestão de Redes Sociais).

![Serviços](../images/admin/config-05-servicos.png)
<!-- TODO screenshot: seção Serviços (add-ons) -->

## 6. Pagamentos (`?sec=pagamentos`)
Habilita/desabilita métodos (PIX, Cartão, Boleto), define rótulos, ordem e em quais **contextos** cada método aparece (`avulso,contract,invoice`).

![Pagamentos](../images/admin/config-06-pagamentos.png)
<!-- TODO screenshot: seção Métodos de pagamento -->

## 7. Integrações (`?sec=integracoes`)
Credenciais das integrações de pagamento (**Stripe** e **Cora**), com ambiente (sandbox/produção) e botão de **testar conexão**. As credenciais são **criptografadas** no banco.

> ⚠️ Ao capturar screenshots desta seção, **mascare as chaves**. Nunca exponha credenciais.

![Integrações](../images/admin/config-07-integracoes.png)
<!-- TODO screenshot: seção Integrações (chaves MASCARADAS) -->

## Dicas e erros comuns

- Cada seção **salva separadamente** — confira o aviso de "alterações não salvas" antes de trocar de seção.
- Mudanças de **preço/desconto** valem para **novos** contratos/agendamentos; não recobram os existentes.
- A configuração pública (preços, métodos, business config) é exposta por endpoints `GET .../public` consumidos pelo frontend (ver [API](../tecnico/api.md)).

## Ver também

- [Pagamentos (técnico)](../tecnico/pagamentos.md) · [Modelo de dados](../tecnico/modelo-de-dados.md)
