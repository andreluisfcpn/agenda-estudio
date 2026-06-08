# Pagamentos

> Rota: **`/meus-pagamentos`** · Menu: **Pagamentos**

Suas faturas, histórico e formas de pagamento.

## Faturas e histórico

- **Em aberto** — faturas pendentes, com **contador regressivo** quando estão reservando um horário.
- **Histórico** — pagas, vencidas e recusadas, com filtro por status.

![Faturas](../images/cliente/pagamentos-01-faturas.png)
<!-- TODO screenshot: /meus-pagamentos faturas + histórico -->

## Pagar uma fatura

Clique numa fatura pendente para abrir o pagamento. O modal traz as abas disponíveis:

- **PIX** — gera um **QR code** e o copia-e-cola; o pagamento é detectado automaticamente.

  ![Pagamento PIX](../images/cliente/pagamentos-03-modal-pix.png)
  <!-- TODO screenshot: modal de pagamento aba PIX (QR code) -->

- **Cartão** — informe os dados do cartão (ou use um cartão salvo); pode haver parcelamento.

  ![Pagamento cartão](../images/cliente/pagamentos-04-modal-cartao.png)
  <!-- TODO screenshot: modal de pagamento aba Cartão -->

- **Boleto** — quando liberado pelo estúdio para o seu contrato.

## Cartões salvos

Gerencie os cartões usados para pagamento: definir **padrão** ou **remover**. Cartões salvos permitem cobrança das próximas parcelas com mais rapidez (e cobrança automática, se ativada).

![Cartões salvos](../images/cliente/pagamentos-02-cartoes.png)
<!-- TODO screenshot: lista de cartões salvos -->

## Dicas e erros comuns

- **PIX não confirmou?** Em alguns minutos o sistema reconcilia automaticamente; a fatura atualiza sozinha.
- **Cartão recusado** gera um alerta para você tentar novamente.
- O **valor** mostrado é o oficial calculado pelo servidor.
- Para pagar a **parcela de um contrato sem sair da página**, veja [Contratos → Pagar uma parcela](contratos.md#pagar-uma-parcela-na-hora).

## Ver também

- [Contratos](contratos.md) · [Painel](dashboard.md) · [Notificações e PWA](notificacoes-e-pwa.md)
