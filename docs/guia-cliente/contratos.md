# Contratos

> Rota: **`/meus-contratos`** · Menu: **Meus Contratos**

Aqui você contrata um plano, acompanha créditos e parcelas, paga, renova, cancela e contrata serviços extras.

## Contratar um plano (assistente)

O assistente de contratação (ContractWizard) começa pela [Agenda](agenda-e-agendamento.md) (ou em **Novo Contrato**) e tem 4 passos:

1. **Plano** — escolha o tier (Comercial/Audiência/Sábado) e a fidelidade (3 ou 6 meses, com desconto). Dê um **nome ao projeto**.

   ![Passo 1 — plano](../images/cliente/contrato-01-wizard-plano.png)
   <!-- TODO screenshot: wizard passo 1 (plano/tier) -->

2. **Agenda** — **Fixa** (mesmo dia/horário toda semana) ou **Flex** (créditos para agendar quando quiser). Escolha a data do 1º episódio.

   ![Passo 2 — agenda](../images/cliente/contrato-02-wizard-agenda.png)
   <!-- TODO screenshot: wizard passo 2 (Fixa/Flex + data) -->

3. **Extras** — serviços por gravação (Cortes por Editor, Cortes com IA, Roteiro & Pautas, YouTube SEO). Opcional.

   ![Passo 3 — extras](../images/cliente/contrato-03-wizard-extras.png)
   <!-- TODO screenshot: wizard passo 3 (serviços extras) -->

4. **Resumo e pagamento** — confira o valor, escolha o **plano de pagamento** (mensal ou à vista) e o **método** (PIX/cartão), aceite os termos e **vá para o pagamento**. O desconto do à vista vale só no **PIX**; à vista no **cartão** é o total sem esse desconto, em 1× (o parcelamento só aparece quando estiver disponível no cartão). No PIX, gere o QR code; em sandbox há o botão "Simular pagamento". Ao confirmar, o contrato é **ativado**.

   ![Passo 4 — pagamento](../images/cliente/contrato-04-wizard-pagamento.png)
   <!-- TODO screenshot: wizard passo 4 (resumo + pagamento + termos) -->

## Plano personalizado

No assistente de contratação, **Plano Personalizado** monta um plano com os dias e horários que você escolher. São as mesmas 4 etapas:

1. **Plano** — nome do projeto, faixa (Comercial, Audiência ou Sábado) e duração: **1, 3, 6, 9 ou 12 ciclos** (1 ciclo = 4 semanas). O plano começa **a partir de amanhã**.
2. **Agenda** — gravações **toda semana**: escolha os dias (Sábado só aos sábados; Comercial e Audiência de segunda a sexta) e o horário de cada dia, entre os horários do estúdio. O quadro mostra o desconto por volume: a partir de 12 gravações no plano (30%) e a partir de 24 (40%).
3. **Serviços** — extras por gravação, opcionais, com o mesmo desconto do plano.
4. **Resumo** — plano de cobrança **Mensal** (uma cobrança a cada ciclo) ou **Integral** (tudo de uma vez, com desconto no PIX; no cartão, pagamento único em 1× — "em até N× sem juros" só aparece quando o parcelamento no cartão estiver disponível), forma de pagamento (PIX ou cartão), cupom e aceite dos termos. No PIX, pedimos o seu CPF/CNPJ se ainda não estiver no perfil.

Ao clicar em **Ir para pagamento**, a agenda é conferida. Se algum horário já estiver ocupado, você vê a lista com a sugestão de outro horário no mesmo dia e pode **aceitar as sugestões** ou **ajustar a agenda**. Em seguida, **seus horários ficam reservados por 10 minutos até a confirmação do pagamento** (o contador aparece na tela). Pagou → o plano é ativado. Se sair sem pagar, dá para concluir em **Meus Contratos** enquanto o prazo não acabar; depois disso a reserva é desfeita e os horários voltam a ficar livres.

## Acompanhar seus contratos

A página lista seus contratos em abas (ativos / finalizados / cancelados). Cada card mostra tier, tipo, duração, status, créditos (Flex), serviços e a lista de parcelas.

- **Finalizados** reúne os contratos **Concluídos** (todas as gravações feitas, sem nada agendado nem crédito sobrando), os **Expirados** e os planos já totalmente usados.
- O contrato **avulso** fica **Concluído** depois da gravação. Se ele tiver uma remarcação liberada, continua em **Ativos** até você remarcar ou o prazo acabar.
- Um plano **Concluído** ainda pode ser **renovado** nos últimos 7 dias da vigência. As parcelas pendentes dele continuam em [Pagamentos](pagamentos.md), na aba **Plano**.

![Lista de contratos](../images/cliente/contrato-05-lista.png)
<!-- TODO screenshot: /meus-contratos lista -->

## Pagar uma parcela (na hora)

1. Expanda o contrato e vá até **Parcelas & Pagamentos**.
2. Clique numa parcela **PENDENTE** (ela mostra "Pagar" e uma seta).
3. O modal **Pagar parcela** abre **sobre o contrato** — escolha PIX ou cartão e conclua.
4. A parcela vira **PAGA** ali mesmo, sem sair da página.

![Pagar parcela](../images/cliente/contrato-06-parcela-modal.png)
<!-- TODO screenshot: modal "Pagar parcela" sobre o contrato -->

## Renovar

Use **Renovar** para continuar com os mesmos termos ao fim do contrato.

![Renovar contrato](../images/cliente/contrato-07-renovar.png)
<!-- TODO screenshot: modal de renovação -->

## Cancelar

Em **Solicitar cancelamento**, você abre um pedido — o estúdio avalia e pode aplicar multa ou isentar, conforme as políticas. O contrato fica como "cancelamento pendente" até a resolução.

Antes de enviar, a confirmação mostra o que vai acontecer: as gravações agendadas de hoje em diante são **canceladas na hora** (e não voltam, mesmo se a multa for isenta); créditos Flex não usados deixam de valer; a multa possível é um percentual do **que você já pagou** no contrato (o valor aparece na confirmação); e as parcelas pendentes são anuladas quando o estúdio concluir. O pedido não pode ser desfeito pelo app.

![Cancelar contrato](../images/cliente/contrato-08-cancelar.png)
<!-- TODO screenshot: modal de solicitação de cancelamento -->

## Contratar um serviço

Serviços recorrentes (ex.: **Gestão de Redes Sociais**, **Gestão de Tráfego**) são contratados (ou renovados) pelos cartões de oferta no topo de **Meus Contratos**. O assistente tem 4 passos:

1. **Visão geral** do serviço.
2. **Fidelidade** (ex.: 3 ou 6 meses, com o desconto de cada uma) e **forma de cobrança**:
   - **Mensal** — uma mensalidade por mês;
   - **À vista** — pagamento único.
3. **Forma de pagamento**:
   - **Mensal + PIX** — paga a 1ª mensalidade agora; as demais, uma por mês.
   - **Mensal + Cartão** — **Pagar mês a mês** (N× de R$ X/mês, uma cobrança por mês). Quando o parcelamento no cartão estiver disponível, aparece também **Parcelar o total em até N× sem juros** (o total do período cobrado agora, em até tantas vezes quantos forem os meses da fidelidade). No momento o cartão não parcela, então a opção não aparece e o mensal no cartão é sempre mês a mês.
   - **À vista** — **PIX** com o desconto PIX, ou **cartão em 1×** (sem desconto PIX e sem parcelas).
   - O cupom de desconto é aplicado sobre a cobrança de agora.
4. **Pagamento**: **conclua em até 10 minutos** (o contador aparece no topo). Se o tempo acabar, a contratação é cancelada e o assistente volta para você escolher a forma de pagamento de novo.

Se você fechar a tela sem pagar, o sistema pergunta **"Sair sem pagar?"**. Saindo, a contratação aparece em **Meus Contratos** como **Aguardando pagamento**, com o contador e o botão **Pagar Agora** (abre direto a cobrança dessa contratação). Passados os 10 minutos ela some e você pode contratar de novo. Se uma contratação anterior do mesmo serviço já foi paga (ou está com pagamento em processamento), o assistente avisa em vez de criar outra.

![Contratar serviço](../images/cliente/contrato-09-servico.png)
<!-- TODO screenshot: modal de contratação de serviço -->

## Dicas e erros comuns

- **Créditos Flex:** 1 por semana; grave ao menos 1×/semana para não perder crédito.
- **Boleto** só aparece se o estúdio liberar para o seu contrato.
- **Aguardando pagamento**: o banner mostra o prazo (mm:ss, ou hh:mm:ss acima de 1 hora — renovações têm 3 dias). **Pagar Agora** abre a cobrança já com a forma de pagamento do contrato (um PIX continua PIX).
- O **valor final** é sempre calculado pelo servidor (cotação autoritativa).

## Ver também

- [Agenda e agendamento](agenda-e-agendamento.md) · [Pagamentos](pagamentos.md) · [Minhas Gravações](minhas-gravacoes.md)
