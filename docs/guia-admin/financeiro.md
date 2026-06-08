# Financeiro

> Rota: **`/admin/finance`** · Menu: **Financeiro** · Acesso: Admin

Fechamento mensal e acompanhamento de pagamentos.

## Visão geral

1. Selecione **ano** e **mês**.
2. Veja os KPIs do período: **bruto**, **taxas** (por provedor), **líquido** e **% de cobrança**.
3. A tabela lista cada pagamento: cliente, contrato, valor, status (`PAID`/`PENDING`/`FAILED`), taxa, líquido e vencimento.
4. **Filtre** por status e **busque** por cliente/contrato; os totais acompanham o filtro.

![Fechamento mensal](../images/admin/financeiro-01-fechamento.png)
<!-- TODO screenshot: /admin/finance com KPIs e tabela do mês -->

Os dados vêm de `GET /api/finance/closing/:year/:month` e `GET /api/payments/summary` (ver [API](../tecnico/api.md)).

## Dicas e erros comuns

- **Valores em centavos** no backend são exibidos formatados (R$) na tela.
- Pagamentos `PENDING` vencidos geram notificação de **pagamento vencido** (ver [notificacoes.md](../tecnico/notificacoes.md)).
- A reconciliação da Cora pode confirmar PIX/boleto cujo webhook falhou — então o status pode atualizar sozinho em alguns minutos (ver [pagamentos.md](../tecnico/pagamentos.md)).

## Ver também

- [Contratos](contratos.md) · [Relatórios](relatorios.md) · [Pagamentos (técnico)](../tecnico/pagamentos.md)
