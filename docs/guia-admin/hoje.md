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
3. **Falta** — registra que o cliente não compareceu (motivo obrigatório). A falta **consome** a sessão: o crédito Flex/Personalizado **não** volta.
4. **Não realizado** — a gravação não aconteceu por causa do estúdio (motivo obrigatório). Em planos Flex/Personalizado o crédito **volta** para o cliente.

![Ações rápidas](../images/admin/hoje-02-acoes-rapidas.png)
<!-- TODO screenshot: sessão expandida com botões check-in/concluir/falta -->

## Falta justificada e "Não realizado" no avulso

Na gravação **avulsa** (paga à parte), o estúdio decide se a falta dá direito a remarcar:

- **Falta sem justificativa** (padrão): o cliente perde o valor na hora e o contrato avulso fica **Concluído**.
- **Falta justificada** (marque a opção no modal de Falta): o cliente pode **remarcar uma única vez, sem pagar de novo**, para uma data até o fim do **7º dia** após a gravação perdida (dia D+7, horário de Brasília; o prazo é a configuração *Prazo para Remarcar Falta Justificada — Avulso*). Ele recebe um aviso na hora e lembretes nos 2 últimos dias. Se o prazo passar sem remarcar, o valor é perdido e o contrato fica **Concluído**. Só dá para justificar enquanto o prazo não venceu; desmarcar a justificativa (enquanto a janela estiver aberta) retira o direito.
- **Não realizado** (culpa do estúdio): a mesma janela de 7 dias abre **automaticamente**. Se o cliente não remarcar, ele **não perde** o valor: o contrato continua ativo e todos os admins recebem um aviso para combinar com o cliente. O admin pode remarcar essa gravação **mesmo depois do prazo**.
- A remarcação reaproveita a **mesma reserva e o mesmo pagamento** (sem nova cobrança), no mesmo tipo de horário (faixa) da gravação original. Quando o cliente remarca, os admins são avisados.

**Na tela:**

- **Modal de Falta** (Hoje, Centro de Comando, Agendamentos e Editar agendamento): na gravação avulsa aparece a opção **"Falta justificada — o cliente pode remarcar sem novo pagamento até DD/MM"**, desmarcada por padrão. Ela fica desativada, com o motivo, quando o prazo já venceu ou a gravação já usou a remarcação. O modal de **Não realizado** avisa que a remarcação sem custo abre sozinha.
- **Bloco "Remarcação"** no painel da gravação (Hoje) e em cada gravação do **Detalhe do Contrato**: mostra *Remarcação liberada até DD/MM*, *Remarcada (falta em DD/MM)*, *Prazo encerrado — valor retido* (falta) ou *Prazo encerrado — resolver com o cliente* (não realizado), com os botões:
  - **Justificar falta** — para falta avulsa ainda sem justificativa, dentro do prazo (pede confirmação);
  - **Remarcar** — abre a escolha de dia e horário livre da mesma faixa. Num **não realizado**, o admin pode remarcar mesmo depois do prazo e sem limite de data (há o campo **Outra data**).
- **Agendamentos**: o mesmo status aparece como um selo abaixo do status (ex.: **Remarcar até DD/MM**, que abre a remarcação). Escolher **Falta** ou **Não realizado** no seletor de status abre o modal de motivo em vez de gravar direto.
- **Centro de Comando**: na agenda do dia, a falta justificada aparece como **Falta · remarcável até DD/MM**.

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

- **Marcar falta por engano:** corrija pela tela de [Agendamentos](agendamentos.md) (editar status). Voltar para "Confirmado" reabre o contrato; "Não realizado" devolve o crédito Flex/Personalizado.
- **Contrato "Concluído":** ao finalizar a última gravação (ou quando o avulso fica em falta sem direito a remarcar), o contrato vira **Concluído** sozinho. Reabrir a gravação o devolve para **Ativo**.
- **Métricas por rede só aparecem** se "transmissão ao vivo" estiver marcado.
- O cliente só vê o gráfico quando houver `streamMetrics` salvos.

## Ver também

- [Agendamentos](agendamentos.md) — para edições mais completas.
- [Minhas Gravações (cliente)](../guia-cliente/minhas-gravacoes.md) — o que o cliente vê.
