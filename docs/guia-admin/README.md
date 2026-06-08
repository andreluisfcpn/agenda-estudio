# Guia do admin

Esta trilha cobre a **operação do estúdio**: conduzir a agenda do dia, gerenciar clientes e contratos, acompanhar finanças e relatórios, e configurar as regras do negócio.

> Todas as páginas de admin exigem login com papel **ADMIN**. As rotas ficam sob `/admin/*` e aparecem no menu lateral apenas para administradores.

## Mapa da operação

1. **[Hoje](hoje.md)** — a tela do dia a dia: confirmar presença, concluir sessões e **finalizar gravações** (registrar métricas de transmissão).
2. **[Agendamentos](agendamentos.md)** — CRUD completo de agendamentos, com filtros e cobrança.
3. **[Clientes](clientes.md)** — lista segmentada de clientes e o perfil detalhado de cada um.
4. **[Contratos](contratos.md)** — gerenciar contratos, editar serviços, cobrar parcelas e resolver cancelamentos.
5. **[Financeiro](financeiro.md)** — fechamento mensal (bruto, taxas, líquido, inadimplência).
6. **[Relatórios](relatorios.md)** — ocupação, receita por tier, audiência e ranking de clientes.
7. **[Configurações](configuracoes.md)** — as 7 seções que controlam preços, horários, políticas, serviços, métodos de pagamento e integrações.

## Ações que só o admin faz

- Confirmar/concluir sessões e marcar **falta** (que devolve crédito Flex).
- Criar agendamentos e contratos **sem cobrança imediata** (offline).
- Liberar **boleto** para um contrato específico.
- Resolver pedidos de cancelamento (**cobrar multa** ou **isentar**).
- Editar **preços, descontos, taxas, horários e políticas** do negócio.
- Configurar **integrações** de pagamento (Stripe e Cora).

## Relacionado

- Como o sistema cobra, reconcilia e aplica efeitos de pagamento: [tecnico/pagamentos.md](../tecnico/pagamentos.md).
- Quais notificações o sistema gera: [tecnico/notificacoes.md](../tecnico/notificacoes.md).
