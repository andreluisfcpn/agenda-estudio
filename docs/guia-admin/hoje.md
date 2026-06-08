# Hoje (agenda do dia)

> Rota: **`/admin/today`** · Menu: **Hoje** · Acesso: Admin

A tela do dia a dia da operação. Mostra as sessões da semana em uma grade e dá as ações rápidas para conduzir cada gravação: confirmar presença, concluir e registrar as métricas, ou marcar falta.

## Visão geral

- Um **relógio ao vivo** e o resumo do horário atual no topo.
- Grade de **segunda a sábado × faixas de horário**, com cada sessão exibindo cliente, tier, status e preço.

![Grade do dia](../images/admin/hoje-01-grade.png)
<!-- TODO screenshot: /admin/today com sessões na grade -->

## Ações rápidas por sessão

Clique em uma sessão para abrir as ações:

1. **Check-in** — confirma que o cliente chegou (status → `CONFIRMED`).
2. **Concluir** — finaliza a sessão e abre o modal de **Finalizar gravação** (abaixo).
3. **Falta** — registra que o cliente não compareceu. Em contratos **Flex**, isso **devolve o crédito**.

![Ações rápidas](../images/admin/hoje-02-acoes-rapidas.png)
<!-- TODO screenshot: sessão expandida com botões check-in/concluir/falta -->

## Finalizar gravação (métricas de transmissão)

Ao concluir uma sessão, registre os dados da gravação:

1. Informe a **duração** (minutos).
2. Marque se foi **transmissão ao vivo (livestream)**.
3. Se foi ao vivo, selecione as **redes** (YouTube, TikTok, Instagram, Facebook) e preencha, por rede: **visualizações, pico de audiência, curtidas e comentários**, além do **link** da transmissão.
4. Adicione notas (internas e/ou visíveis ao cliente).
5. **Salvar** — os dados aparecem para o cliente em [Minhas Gravações](../guia-cliente/minhas-gravacoes.md) (inclusive no gráfico), e o pagamento é liberado se estava em espera.

![Finalizar gravação](../images/admin/hoje-03-finalizar-gravacao.png)
<!-- TODO screenshot: modal Finalizar gravação com métricas por rede -->

## Dicas e erros comuns

- **Marcar falta por engano:** prefira corrigir pela tela de [Agendamentos](agendamentos.md) (editar status), já que a falta mexe em crédito Flex.
- **Métricas por rede só aparecem** se "transmissão ao vivo" estiver marcado.
- O cliente só vê o gráfico quando houver `streamMetrics` salvos.

## Ver também

- [Agendamentos](agendamentos.md) — para edições mais completas.
- [Minhas Gravações (cliente)](../guia-cliente/minhas-gravacoes.md) — o que o cliente vê.
