# Contratos

> Rotas: **`/admin/contracts`** (lista) e **`/admin/contracts/:id`** (detalhe) · Menu: **Contratos** · Acesso: Admin

Gestão dos contratos: criar, editar, cobrar parcelas, editar serviços e resolver cancelamentos.

## Lista de contratos

- **Filtros** por status (ativo/expirando/expirado/cancelado) e tipo (FIXO/FLEX/AVULSO/CUSTOM).
- **Busca** por cliente ou nome do contrato.
- Colunas: cliente, nome/ID, tipo, tier, início, fim, status, valor, créditos Flex, método de pagamento.

![Lista de contratos](../images/admin/contratos-01-lista.png)
<!-- TODO screenshot: /admin/contracts lista com filtros -->

### Ações na lista

- **Criar contrato** → escolha cliente, tier, tipo, duração e método de pagamento.
- **Editar** → status, data de fim, créditos Flex restantes, link do contrato, método de pagamento, liberar boleto.
- **Ver detalhe** → `/admin/contracts/:id`.
- **Cancelar** → cancela e devolve créditos quando aplicável.

## Detalhe do contrato

Em `/admin/contracts/:id`:

- **Financeiro:** valor total, pago, pendente, % de cobrança e tabela por parcela (com cobrança inline das pendentes).
- **Agendamentos:** sessões do contrato (concluir/editar).
- **Serviços:** serviços por episódio e mensais do contrato.

![Detalhe do contrato](../images/admin/contratos-02-detalhe.png)
<!-- TODO screenshot: /admin/contracts/:id financeiro + bookings -->

### Editar serviços

Adicione/remova serviços do contrato pelo seletor. As mudanças valem **para o futuro** (não recobram gravações passadas).

![Editar serviços do contrato](../images/admin/contratos-03-servicos.png)
<!-- TODO screenshot: edição de serviços no detalhe do contrato -->

## Resolver cancelamento

Quando um cliente solicita cancelamento, o contrato fica em **PENDING_CANCELLATION**. Na lista, resolva:

- **Cobrar multa** — aplica a multa definida nas políticas.
- **Isentar** — cancela sem multa.

![Resolver cancelamento](../images/admin/contratos-04-cancelamento.png)
<!-- TODO screenshot: ação de resolução de cancelamento (multa/isenção) -->

## Dicas e erros comuns

- **Liberar boleto** é por contrato (`boletoAllowed`) — por padrão fica desligado.
- Cobrança de parcela usa o mesmo fluxo de pagamento do cliente (ver [Pagamentos técnico](../tecnico/pagamentos.md)).
- O ciclo de vida completo (estados) está em [modelo-de-dados.md](../tecnico/modelo-de-dados.md#ciclo-de-vida-do-contrato).

## Ver também

- [Clientes](clientes.md) · [Financeiro](financeiro.md) · [Contratos (cliente)](../guia-cliente/contratos.md)
