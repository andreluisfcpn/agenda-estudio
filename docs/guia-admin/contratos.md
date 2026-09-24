# Contratos

> Rotas: **`/admin/contracts`** (lista) e **`/admin/contracts/:id`** (detalhe) · Menu: **Contratos** · Acesso: Admin

Gestão dos contratos: criar, editar, cobrar parcelas, editar serviços e resolver cancelamentos.

## Lista de contratos

- **Filtros** por status: Todos, Ativos, Aguard. pagamento, Pausados, Concluídos, Expirados, Cancelados. Depois de uma ação (editar, renovar, criar), a lista recarrega sem sumir e mostra um discreto "Atualizando…".
- **Busca** por cliente ou nome do contrato.
- Colunas: cliente/projeto, tipo e tier, gravações (com duração e desconto), pagamento (forma e plano), vigência, status e ações. No **avulso** aparecem "Sessão única", "Pagamento único" e a data da gravação.
- **Vence em Nd** aparece na vigência dos planos ativos ou concluídos que vencem em até 30 dias (o KPI "Vencendo (30d)" conta os mesmos). O avulso nunca "vence".

![Lista de contratos](../images/admin/contratos-01-lista.png)
<!-- TODO screenshot: /admin/contracts lista com filtros -->

### Ações na lista

- **Criar contrato** → assistente em 4 etapas (ver [Novo contrato Fixo/Flex](#novo-contrato-fixoflex-em-4-etapas)).
- **Editar** → status (Ativo, Expirado, Concluído, Cancelado), data de fim, créditos Flex restantes, link do contrato, método de pagamento, liberar boleto. "Aguardando cancelamento" não é escolhido aqui: ele vem do pedido do cliente. Num contrato pausado, aguardando pagamento ou em cancelamento, o status atual aparece como "(atual)" e só muda se você escolher outro.
- **Ver detalhe** → `/admin/contracts/:id`.
- **Cancelar** → cancela e devolve créditos quando aplicável.
- **Renovar (+3 meses)** → planos ativos, concluídos ou expirados. Nunca aparece no avulso.

### Novo contrato (Fixo/Flex) em 4 etapas

1. **Plano:** cliente, nome do projeto, tipo (Fixo ou Flex), faixa e pacote (3 ou 6 meses).
2. **Agenda:** data de início e link do contrato (opcional; se preenchido, precisa ser um endereço completo `https://…`). No **Fixo**, os dias e horários vêm da grade da faixa (ver [Horários válidos de contrato](#horários-válidos-de-contrato)): não há horário pré-preenchido, e ao trocar a faixa ou o dia o que deixou de valer é limpo. Sem dia e horário válidos (ou se a grade não carregar), o **Próximo** fica bloqueado.
3. **Serviços:** serviços por gravação (opcional).
4. **Resumo:** confira os dados, escolha plano de cobrança, forma de pagamento, boleto e cupom, e clique em **Criar Contrato**.

Ao criar um **Fixo**, a agenda é verificada antes:

- **Horário inválido** (fora da grade): o assistente volta à etapa **Agenda** com a mensagem e o campo de horário destacado. Não é conflito.
- **Dia da semana lotado no período inteiro:** o assistente volta à **Agenda** com o aviso "Sem vaga às …", a **previsão** da próxima data com vaga (botão **Começar em DD/MM**) e os **outros dias da semana** com o mesmo horário livre (botão para trocar o dia).
- **Conflitos em algumas datas:** abre o modal **Conflitos de Agenda** com as substituições automáticas.

Depois de criado, abre a folha **Cobrar 1ª parcela** (PIX/cartão do cliente presente ou **Deixar pendente**). A lista só é atualizada quando essa folha é fechada.

## Detalhe do contrato

Em `/admin/contracts/:id`:

- **Vigência, duração e plano** seguem o tipo. No **avulso**: data e horário da gravação, "Sessão única" e "Pagamento único" (mais "cartão em Nx" se foi parcelado). Nos planos: início – fim, "N meses · X% fidelidade" (ou "sem desconto") e "Mensal (Nx)" ou "Integral".
- **Financeiro:** valor total, pago, pendente, % de cobrança e tabela por parcela (com cobrança inline das pendentes). O status da parcela aparece em português (Pago, Pendente, Falhou, Estornado, Cancelado) e a forma vem do provedor da cobrança (Sicoob → PIX, Stripe → Cartão, com "em Nx" quando parcelado).
- **Remarcação do avulso:** a gravação em falta justificada ou "Não realizado" mostra o selo "Remarcação liberada até DD/MM", "Remarcada" ou "Prazo encerrado". Enquanto a remarcação estiver liberada, o contrato não fica Concluído.
- **Agendamentos:** sessões do contrato (concluir/editar).
- **Serviços:** serviços por episódio e mensais do contrato.

![Detalhe do contrato](../images/admin/contratos-02-detalhe.png)
<!-- TODO screenshot: /admin/contracts/:id financeiro + bookings -->

### Editar serviços

Adicione/remova serviços do contrato pelo seletor. As mudanças valem **para o futuro** (não recobram gravações passadas).

![Editar serviços do contrato](../images/admin/contratos-03-servicos.png)
<!-- TODO screenshot: edição de serviços no detalhe do contrato -->

## Status "Concluído"

O contrato vira **Concluído** automaticamente quando não resta nada a fazer nele, e volta a **Ativo** sozinho se isso mudar (por exemplo, ao reabrir uma gravação finalizada ou devolver um crédito):

- **Avulso:** quando a gravação é finalizada, ou quando fica em **falta sem direito a remarcar** (sem justificativa, prazo de remarcação vencido ou nova falta depois de remarcar). Enquanto houver remarcação liberada, ou se a gravação foi marcada como **Não realizado**, ele continua **Ativo**.
- **Fixo, Flex e Personalizado:** quando a última gravação é finalizada e não sobra sessão agendada nem crédito.
- Um plano concluído **continua renovável** (botão Renovar e aviso de "contrato expirando") e as parcelas pendentes continuam sendo cobradas normalmente.
- Contratos **pausados, aguardando pagamento, em cancelamento, cancelados ou expirados** nunca mudam sozinhos. **Serviços** não entram nessa regra.
- O **avulso** tem vigência de um dia (a data da gravação), é pagamento único e **não** aparece no aviso de "contrato expirando".

## Resolver cancelamento

Quando um cliente solicita cancelamento, o contrato fica em **PENDING_CANCELLATION** e as gravações dele de hoje em diante já são canceladas na hora. Na lista, resolva:

- **Cobrar multa** — gera uma cobrança de multa de *X*% (Políticas → multa de cancelamento) sobre o **total que o cliente já pagou** no contrato (sem nada pago, não há multa). A multa fica pendente para o cliente pagar; ela **não** é cobrada automaticamente no cartão.
- **Isentar** — cancela sem multa.
- Nos dois casos o contrato vira **Cancelado**, as parcelas pendentes são anuladas e a recorrência no cartão (se houver) é encerrada.

## Confirmações das ações do contrato

Toda ação que muda o contrato abre uma confirmação que lista o que vai acontecer. As **vermelhas** (com o selo "Irreversível") não têm volta; as **âmbar** podem ser desfeitas.

| Ação | Tom | O que acontece |
|---|---|---|
| **Cancelar contrato** (ícone 🚫) | vermelho | Contrato → Cancelado; gravações de hoje em diante canceladas (horários liberados); parcelas pendentes anuladas; **sem multa e sem estorno** do que já foi pago. |
| **Cobrar multa** | vermelho | Ver "Resolver cancelamento". |
| **Isentar multa** | âmbar | Ver "Resolver cancelamento". |
| **Pausar** | âmbar | **Fixo:** gravações futuras canceladas; ao **Retomar**, a vigência é estendida pelos dias em pausa e as gravações do dia/horário fixos são recriadas. **Flex/Personalizado:** as gravações agendadas são mantidas. Parcelas pendentes não são cobradas automaticamente durante a pausa. |
| **Marcar pago** (detalhe do contrato) | âmbar | Parcela → Pago com a data de hoje; o sistema confirma gravação/contrato, o cupom e avisa o cliente, como num pagamento online. Depois disso ela só pode virar "Estornado". Se já havia PIX/boleto emitido, oriente o cliente a não pagá-lo. |
| **Renovar / Retomar** | neutro | Confirmação simples. |

Se a ação falhar, a mensagem aparece dentro da própria confirmação, que continua aberta.

![Resolver cancelamento](../images/admin/contratos-04-cancelamento.png)
<!-- TODO screenshot: ação de resolução de cancelamento (multa/isenção) -->

## Horários válidos de contrato

Os horários de um contrato (Fixo, primeira gravação do Flex e Personalizado) vêm da **grade de horários** configurada em **Configurações** (horários, faixas e dias de funcionamento). Nada é digitado à mão:

- **Sábado** grava só aos sábados, nos horários da grade.
- **Comercial** e **Audiência** gravam só de **segunda a sexta**.
- A faixa superior pode usar os horários da inferior: **Audiência** oferece 10:00, 13:00 e 15:30 (comerciais) além de 18:00 e 20:30. **Comercial** só oferece os comerciais.
- Um horário fora da grade é recusado com a mensagem **"Horário inválido: … Horários válidos: …"**. Isso não é conflito de agenda: basta escolher um dos horários listados.
- Ao mudar a grade em Configurações, os contratos novos passam a usar a grade nova. Os contratos que já existem não mudam.

## Contrato personalizado: cobrança

- **Criado pelo admin** (em nome do cliente): o contrato já nasce **Ativo**, com as sessões confirmadas e todas as parcelas pendentes. **Nenhuma cobrança é gerada na criação.** Em seguida abre a folha de cobrança (cartão ou QR PIX, que pede o CPF do cliente se faltar). Você também pode escolher **Deixar pendente** para o cliente pagar depois. Se algum horário já estiver ocupado, essa sessão é pulada e aparece no retorno.
- **Criado pelo cliente**: o contrato fica em **Aguardando pagamento** por **10 minutos**, com os horários reservados. Só a 1ª parcela é cobrada na hora. Se o pagamento não for feito no prazo, o contrato e as sessões são apagados automaticamente e os horários voltam a ficar livres.

### Contrato personalizado: o assistente

Admin e cliente usam o **mesmo assistente** (Plano → Agenda → Serviços → Resumo); o admin tem todas as opções:

1. **Plano:** cliente, nome do contrato, faixa, duração de **1 a 12 ciclos** (1 ciclo = 4 semanas) e data de início.
2. **Agenda:** frequência **Semanal**, **Quinzenal** (semanas 1 e 3 ou 2 e 4), **Mensal** (semanas do mês) ou **Datas livres** (calendário). Os dias e horários vêm da grade da faixa: **Sábado** só aos sábados; no calendário, dias sem gravação na faixa aparecem riscados e não podem ser escolhidos. O quadro de desconto mostra a regra que é cobrada: por **nº de gravações** do plano (a partir de 12 → desconto de 3 meses; a partir de 24 → desconto de 6 meses, valores de Configurações).
3. **Serviços:** só os serviços **por gravação** (os mensais ficam de fora), em todas as gravações ou como créditos por ciclo.
4. **Resumo:** plano de cobrança **Mensal** ou **Integral**, forma de pagamento e cupom (validado para o cliente escolhido).

Ao clicar em **Criar contrato**, a agenda é verificada: se houver horários ocupados, aparece a tela de **conflitos** com a sugestão de outro horário no mesmo dia (**Aceitar sugestões**) ou **Ajustar a agenda**. Dia lotado sem sugestão = a ocorrência é pulada. Um horário fora da grade volta para a etapa **Agenda** com a mensagem "Horário inválido". Depois de criado abre a folha de cobrança (ver acima); a lista só atualiza quando ela fecha.

## Dicas e erros comuns

- **Liberar boleto** é por contrato (`boletoAllowed`) — por padrão fica desligado.
- Cobrança de parcela usa o mesmo fluxo de pagamento do cliente (ver [Pagamentos técnico](../tecnico/pagamentos.md)).
- O ciclo de vida completo (estados) está em [modelo-de-dados.md](../tecnico/modelo-de-dados.md#ciclo-de-vida-do-contrato).

## Ver também

- [Clientes](clientes.md) · [Financeiro](financeiro.md) · [Contratos (cliente)](../guia-cliente/contratos.md)
