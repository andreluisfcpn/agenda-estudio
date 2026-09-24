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

- **Preço do Pacote 2h** (por faixa): campo em R$ (ver [Campos em R$](#campos-em-r)). A prévia "Preços com Desconto" do card acompanha o valor enquanto você digita. Nada é gravado até clicar em **Salvar Alterações**; **Descartar** volta ao valor salvo.
- **Taxas de Gateway**: as taxas fixas (Stripe por transação, Cora por cobrança) aparecem em R$ (ex.: R$ 0,39). Por baixo continuam gravadas em centavos, então o histórico de taxas e o relatório financeiro não mudam. As taxas percentuais continuam com o campo −/+ e o sufixo %.

![Financeiro](../images/admin/config-03-financeiro.png)
<!-- TODO screenshot: seção Financeiro com preços e descontos -->

## 4. Políticas (`?sec=politicas`)
Multa de cancelamento (%), janela de remarcação e demais regras de agendamento.

![Políticas](../images/admin/config-04-politicas.png)
<!-- TODO screenshot: seção Políticas -->

## 5. Serviços (`?sec=servicos`)
Serviços extras (add-ons): nome, preço e se são **mensais** ou **por gravação** (ex.: Cortes com IA, Cortes por Editor, Roteiro & Pautas, YouTube SEO, Gestão de Redes Sociais). O preço (mensal ou por episódio) usa o mesmo campo em R$ das faixas.

**Remover** abre uma confirmação vermelha. O sistema confere na hora se o serviço já foi usado: se nenhum contrato ou gravação tem o serviço, ele é **apagado**; se algum tem, ele só fica **Inativo** (o histórico é preservado). Nos dois casos ele some da landing e das contratações, e os contratos/gravações existentes não mudam. Num card novo, ainda não salvo, o botão é **Descartar** e só apaga o rascunho.

![Serviços](../images/admin/config-05-servicos.png)
<!-- TODO screenshot: seção Serviços (add-ons) -->

## 6. Pagamentos (`?sec=pagamentos`)
Habilita/desabilita métodos (PIX, Cartão, Boleto), define rótulos, ordem e em quais **contextos** cada método aparece (`avulso,contract,invoice`).

![Pagamentos](../images/admin/config-06-pagamentos.png)
<!-- TODO screenshot: seção Métodos de pagamento -->

## 7. Integrações (`?sec=integracoes`)
Credenciais das integrações de pagamento (**Stripe** e **Cora**), com ambiente (sandbox/produção) e botão de **testar conexão**. As credenciais são **criptografadas** no banco.

- **Desligar** o interruptor de um provedor pede confirmação (âmbar): os clientes deixam de ver a forma de pagamento **na hora** (Stripe → Cartão; Sicoob → PIX, a menos que a Cora esteja ativa; Cora → Boleto e PIX, a menos que o Sicoob esteja ativo). Cobranças já emitidas por ele só voltam a ser conferidas quando você reativar; as credenciais continuam salvas. Ligar é imediato.
- **Remover** um webhook da Cora pede confirmação (vermelha). Sem o webhook deste sistema, os pagamentos pela Cora passam a ser confirmados só pela conferência automática (a cada 2 minutos). Para voltar, use **Registrar Webhook na Cora**.

> ⚠️ Ao capturar screenshots desta seção, **mascare as chaves**. Nunca exponha credenciais.

![Integrações](../images/admin/config-07-integracoes.png)
<!-- TODO screenshot: seção Integrações (chaves MASCARADAS) -->

## Campos em R$

Todos os valores em dinheiro do painel usam o mesmo campo, que funciona como app de banco:

- **Os dígitos entram da direita para a esquerda.** Para R$ 350,00, digite `3 5 0 0 0`. Se digitar só `350`, o valor fica R$ 3,50.
- Ao clicar no campo, o valor inteiro é selecionado, e o que você digitar substitui o valor anterior.
- **Backspace** apaga o último dígito (R$ 350,00 → R$ 35,00).
- **Colar** aceita `R$ 1.500,00`, `1.500,00`, `1500` e `450.00`.
- No celular, abre o teclado numérico.

Onde aparece: faixas de preço, serviços, taxas fixas de gateway e o **Valor do Agendamento** avulso no modal "Novo Agendamento". Nesse modal, o valor só é aplicado quando você sai do campo, para o cupom não ser revalidado a cada tecla.

**Cupons** (Novo/Editar cupom): o mesmo campo é usado no **valor fixo** do desconto e no **valor mínimo** da cobrança. O valor mínimo pode ficar vazio, o que significa sem mínimo. O desconto percentual continua como número inteiro de 1 a 100. O modal do cupom tem 3 etapas:

1. **Cupom**: código, descrição, tipo e valor.
2. **Regras**: aplicação, validade, limites, valor mínimo e se o cupom está ativo.
3. **Elegibilidade**: quem pode usar o cupom, com um resumo antes de salvar.

Na edição, o código não muda, e você pode clicar numa etapa no topo para ir direto a ela. Um código repetido leva de volta à etapa 1. O limite de usos não pode ficar abaixo dos usos já feitos.

## Dicas e erros comuns

- Cada seção **salva separadamente** — confira o aviso de "alterações não salvas" antes de trocar de seção.
- Mudanças de **preço/desconto** valem para **novos** contratos/agendamentos; não recobram os existentes.
- A configuração pública (preços, métodos, business config) é exposta por endpoints `GET .../public` consumidos pelo frontend (ver [API](../tecnico/api.md)).

## Ver também

- [Pagamentos (técnico)](../tecnico/pagamentos.md) · [Modelo de dados](../tecnico/modelo-de-dados.md)
