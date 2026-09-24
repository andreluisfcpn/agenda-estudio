# Pagamentos

> Rota: **`/meus-pagamentos`** · Menu: **Pagamentos**

Suas faturas, histórico e formas de pagamento.

## Faturas e histórico

- **Em aberto** — faturas pendentes, com **contador regressivo** quando estão reservando um horário.
- **Histórico** — pagas, vencidas e recusadas, com filtro por status.

![Faturas](../images/cliente/pagamentos-01-faturas.png)
<!-- TODO screenshot: /meus-pagamentos faturas + histórico -->

## Pagar uma fatura

Clique numa fatura pendente para abrir o pagamento. O modal abre na forma de pagamento do seu contrato (um contrato no PIX abre direto no PIX) e traz as abas disponíveis. Se a cobrança for de uma contratação aguardando pagamento, o topo do modal mostra **"Conclua o pagamento até HH:MM"** com o tempo restante; quando o prazo acaba, o modal fecha com o aviso **"Tempo esgotado…"** (se o pagamento tiver entrado no último instante, aparece **"Pagamento confirmado!"**).

- **PIX** — gera um **QR code** e o copia-e-cola; o pagamento é detectado automaticamente.
  - O QR mostra o **valor** e a contagem **"Expira em mm:ss"**. Numa reserva ou contratação que aguarda pagamento, ele vale o mesmo tempo do prazo (10 minutos); nas parcelas, 1 hora.
  - Quando o prazo acaba, o QR some e aparece **"QR expirado"** com o botão **Gerar novo QR** (um clique gera outro código e a tela volta a acompanhar o pagamento). Nunca pague um código expirado.
  - Se a imagem do QR não carregar, use o **copia-e-cola**.

  ![Pagamento PIX](../images/cliente/pagamentos-03-modal-pix.png)
  <!-- TODO screenshot: modal de pagamento aba PIX (QR code) -->

- **Cartão** — informe os dados do cartão (ou use um cartão salvo).
  - No momento o pagamento no cartão é sempre em **1×** (o parcelamento no cartão não está disponível). O campo **Parcelamento** só aparece quando houver mais de uma opção; se você tinha escolhido parcelar, a tela avisa que o total é cobrado em 1×.
  - O valor mostrado na aba Cartão é exatamente o que será cobrado. Numa cobrança **à vista com desconto PIX**, o desconto vale só no PIX: a tela avisa **"O desconto à vista vale só no PIX (R$ X). No cartão, o valor é R$ Y."**

  ![Pagamento cartão](../images/cliente/pagamentos-04-modal-cartao.png)
  <!-- TODO screenshot: modal de pagamento aba Cartão -->

- **Boleto** — quando liberado pelo estúdio para o seu contrato.

## Cartões salvos

Gerencie os cartões usados para pagamento: definir **padrão** ou **remover**. Cartões salvos permitem cobrança das próximas parcelas com mais rapidez (e cobrança automática, se ativada).

**Remover** pede confirmação (vermelha): o cartão é apagado da carteira e não pode ser recuperado — para usá-lo de novo, cadastre outra vez. Com a cobrança automática ligada, se for o último cartão as próximas parcelas passam a ser pagas por você; se for o padrão e houver outros, a cobrança automática usa o cartão salvo mais recente até você escolher um novo padrão. Pagamentos já feitos não mudam.

![Cartões salvos](../images/cliente/pagamentos-02-cartoes.png)
<!-- TODO screenshot: lista de cartões salvos -->

## Dicas e erros comuns

- **PIX não confirmou?** Em alguns minutos o sistema reconcilia automaticamente; a fatura atualiza sozinha.
- **Contador em "Em aberto"**: contratações aguardando pagamento mostram o prazo restante (mm:ss; acima de 1 hora, hh:mm:ss — renovações têm 3 dias). Ao zerar, a cobrança sai da lista.
- **Cartão recusado** gera um alerta para você tentar novamente.
- O **valor** mostrado é o oficial calculado pelo servidor.
- Para pagar a **parcela de um contrato sem sair da página**, veja [Contratos → Pagar uma parcela](contratos.md#pagar-uma-parcela-na-hora).

## Ver também

- [Contratos](contratos.md) · [Painel](dashboard.md) · [Notificações e PWA](notificacoes-e-pwa.md)
