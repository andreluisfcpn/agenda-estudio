# Relatórios

> Rota: **`/admin/reports`** · Menu: **Relatórios** · Acesso: Admin

Análises de uso e desempenho do estúdio.

## Visão geral

Selecione o período (últimos 7/30/90/365 dias). Os cartões de resumo mostram total de sessões, concluídas, canceladas, receita, % de cobrança e ticket médio.

![Resumo](../images/admin/relatorios-01-resumo.png)
<!-- TODO screenshot: /admin/reports cartões de resumo -->

## Seções

- **Ocupação por horário e por dia** — quais faixas e dias da semana são mais cheios.

  ![Ocupação](../images/admin/relatorios-02-ocupacao.png)
  <!-- TODO screenshot: gráficos de ocupação por horário/dia -->

- **Por tier** — distribuição de receita/sessões entre Comercial, Audiência e Sábado.
- **Audiência** — métricas das transmissões finalizadas (views, pico, chat, duração).

  ![Audiência](../images/admin/relatorios-03-audiencia.png)
  <!-- TODO screenshot: métricas de audiência -->

- **Ranking de clientes** — top clientes por receita.

Os dados vêm dos endpoints `GET /api/reports/{summary,occupancy,tiers,audience,ranking}` (ver [API](../tecnico/api.md)).

## Dicas

- As métricas de **audiência** dependem das gravações finalizadas com dados de transmissão (ver [Hoje → Finalizar gravação](hoje.md#finalizar-gravacao-metricas-de-transmissao)).

## Ver também

- [Financeiro](financeiro.md) · [Hoje](hoje.md)
