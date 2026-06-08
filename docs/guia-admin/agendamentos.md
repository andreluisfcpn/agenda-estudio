# Agendamentos

> Rota: **`/admin/bookings`** · Menu: **Agendamentos** · Acesso: Admin

Gestão completa (CRUD) de todos os agendamentos do estúdio, com filtros, busca e cobrança.

## Visão geral

- KPIs no topo: total, confirmados, concluídos, cancelados, receita.
- **Filtros** por período e status; **busca** por nome/e-mail do cliente.
- Tabela com data, horário, cliente, tier, status, preço, contrato e ações.

![Tabela de agendamentos](../images/admin/agendamentos-01-tabela.png)
<!-- TODO screenshot: /admin/bookings tabela com filtros -->

## Criar um agendamento

1. Clique em **Criar/Novo agendamento**.
2. Selecione o **cliente** e, se houver, o **contrato**.
3. Escolha **data** e **horário**.
4. (Opcional) ajuste o **preço** e decida **cobrar agora** (PIX/cartão) ou criar **sem cobrança** (offline).
5. **Salvar**.

![Criar agendamento](../images/admin/agendamentos-02-criar.png)
<!-- TODO screenshot: modal de criação de agendamento -->

## Editar um agendamento

Na linha desejada, use **Editar** para alterar data, horário, preço, status e notas. Você também pode mudar o status direto (ex.: `CONFIRMED` → `COMPLETED`/`CANCELLED`/`FALTA`).

![Editar agendamento](../images/admin/agendamentos-03-editar.png)
<!-- TODO screenshot: modal de edição de agendamento -->

## Excluir

- **Cancelar** (soft delete) mantém o registro com status cancelado.
- **Excluir definitivo** remove a linha — em contratos Flex, **devolve o crédito**.

## Dicas e erros comuns

- Para **finalizar com métricas**, use a tela [Hoje](hoje.md) (modal de finalização) — é o caminho pensado para o pós-gravação.
- Mudanças de status que afetam crédito Flex (falta/cancelamento) são refletidas no contrato do cliente.

## Ver também

- [Hoje](hoje.md) · [Contratos](contratos.md) · [Clientes](clientes.md)
