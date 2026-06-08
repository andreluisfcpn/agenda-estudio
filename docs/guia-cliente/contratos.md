# Contratos

> Rota: **`/my-contracts`** · Menu: **Meus Contratos**

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

4. **Resumo e pagamento** — confira o valor, escolha o **plano de pagamento** (mensal ou à vista) e o **método** (PIX/cartão), aceite os termos e **vá para o pagamento**. No PIX, gere o QR code; em sandbox há o botão "Simular pagamento". Ao confirmar, o contrato é **ativado**.

   ![Passo 4 — pagamento](../images/cliente/contrato-04-wizard-pagamento.png)
   <!-- TODO screenshot: wizard passo 4 (resumo + pagamento + termos) -->

## Acompanhar seus contratos

A página lista seus contratos em abas (ativos / arquivados / cancelados). Cada card mostra tier, tipo, duração, status, créditos (Flex), serviços e a lista de parcelas.

![Lista de contratos](../images/cliente/contrato-05-lista.png)
<!-- TODO screenshot: /my-contracts lista -->

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

![Cancelar contrato](../images/cliente/contrato-08-cancelar.png)
<!-- TODO screenshot: modal de solicitação de cancelamento -->

## Contratar um serviço

Serviços recorrentes (ex.: **Gestão de Redes Sociais**) podem ser assinados a partir do contrato. Escolha a duração e o método de pagamento.

![Contratar serviço](../images/cliente/contrato-09-servico.png)
<!-- TODO screenshot: modal de contratação de serviço -->

## Dicas e erros comuns

- **Créditos Flex:** 1 por semana; grave ao menos 1×/semana para não perder crédito.
- **Boleto** só aparece se o estúdio liberar para o seu contrato.
- O **valor final** é sempre calculado pelo servidor (cotação autoritativa).

## Ver também

- [Agenda e agendamento](agenda-e-agendamento.md) · [Pagamentos](pagamentos.md) · [Minhas Gravações](minhas-gravacoes.md)
