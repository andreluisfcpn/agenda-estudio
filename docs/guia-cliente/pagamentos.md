# Pagamentos

> Rota: **`/meus-pagamentos`** · Menu: **Pagamentos**

Suas faturas, histórico e formas de pagamento.

## Faturas e histórico

- **Em aberto** — faturas pendentes, com **contador regressivo** quando estão reservando um horário.
- **Histórico** — pagas, vencidas e recusadas, com filtro por status.
- Cada cobrança diz o que é: **Parcela N/Total** (só as parcelas do plano em vigor — anuladas, extras de gravação e multa ficam fora da contagem), **Extra de gravação** ou **Multa de cancelamento (N%)**. A multa tem o botão **Pagar multa**, vence no dia da decisão do estúdio (horário de Brasília — a mesma data em Pagamentos, no Início e em Meus Contratos) e só conta como atrasada a partir do dia seguinte.
- **Cancelamento em análise**: as parcelas do plano desse contrato aparecem como **Suspensa**, sem botão de pagar, e não entram no total pendente — aguarde a decisão do estúdio.

![Faturas](../images/cliente/pagamentos-01-faturas.png)
<!-- TODO screenshot: /meus-pagamentos faturas + histórico -->

## Pagar uma fatura

Clique numa fatura pendente para abrir o pagamento. O modal abre na forma de pagamento do seu contrato (um contrato no PIX abre direto no PIX) e traz as abas disponíveis. Se a cobrança for de uma contratação aguardando pagamento, o topo do modal mostra **"Conclua o pagamento até HH:MM"** com o tempo restante; quando o prazo acaba, o modal fecha com o aviso **"Tempo esgotado…"** (se o pagamento tiver entrado no último instante, aparece **"Pagamento confirmado!"**).

- **PIX** — gera um **QR code** e o copia-e-cola; o pagamento é detectado automaticamente.
  - A tela mostra, tudo centralizado: o **valor**, o **QR code**, a contagem **"Expira em mm:ss"**, o código copia-e-cola e o botão **Copiar código PIX**. Numa reserva ou contratação que aguarda pagamento, o QR vale o mesmo tempo do prazo (10 minutos); nas parcelas, 1 hora.
  - Num pagamento **à vista**, o PIX tem desconto: a aba PIX já mostra o valor com o desconto **antes** de você gerar o código (mesmo que o contrato tenha sido criado no cartão).
  - Quando o prazo acaba, o QR some e aparece **"QR expirado"** com o botão **Gerar novo QR** (um clique gera outro código e a tela volta a acompanhar o pagamento). Nunca pague um código expirado.
  - Se a imagem do QR não carregar, use o **copia-e-cola**.

  ![Pagamento PIX](../images/cliente/pagamentos-03-modal-pix.png)
  <!-- TODO screenshot: modal de pagamento aba PIX (QR code) -->

- **Cartão** — informe os dados do cartão (ou use um cartão salvo).
  - No momento o pagamento no cartão é sempre em **1×** (o parcelamento no cartão não está disponível). O campo **Parcelamento** só aparece quando houver mais de uma opção; se você tinha escolhido parcelar, a tela avisa que o total é cobrado em 1×.
  - O valor mostrado em cada aba é exatamente o que será cobrado naquela forma. Numa cobrança **à vista com desconto PIX**, o desconto vale só no PIX: a tela avisa **"O desconto à vista vale só no PIX: R$ X no PIX. No cartão, o valor é R$ Y."** — o cartão nunca cobra mais que o preço de cartão.

  ![Pagamento cartão](../images/cliente/pagamentos-04-modal-cartao.png)
  <!-- TODO screenshot: modal de pagamento aba Cartão -->

- **Boleto** — aparece como terceira aba **só quando o estúdio aceita boleto** e a cobrança é uma fatura ou parcela de um contrato **já ativo**.
  - Não aparece em contratações com prazo de 10 minutos (gravação avulsa, contratação de plano, serviço ou personalizado) nem na renovação: o boleto compensa em até 3 dias úteis.
  - O boleto cobra o mesmo valor do cartão (o desconto à vista é só do PIX) e pede um CPF ou CNPJ válido no seu cadastro.
  - Se o estúdio desligar o boleto enquanto a tela está aberta, a aba some com um aviso e você paga por PIX ou cartão.

## Cartões salvos

Gerencie os cartões usados para pagamento: definir **padrão** ou **remover**. Cartões salvos permitem cobrança das próximas parcelas com mais rapidez (e cobrança automática, se ativada).

**Cobrança automática** (aba **Carteira**): a chave liga ou desliga a cobrança das parcelas de **todos os seus contratos** no cartão padrão, no dia do vencimento. Para ativar escolhendo o cartão — ou cadastrando um novo na hora —, use **Ativar cobrança automática** no contrato: veja [Contratos → Cobrança automática](contratos.md#cobrança-automática). O cartão padrão só mostra "Cobrança automática ativa" quando ela está ligada. Ela só funciona com cartão de **crédito**: com a chave ligada, um cartão de débito ou pré-pago não pode virar o padrão. Ela cobra **só as parcelas do plano**: a multa de cancelamento e os extras de gravação nunca são cobrados automaticamente.

**Remover** pede confirmação (vermelha): o cartão é apagado da carteira e não pode ser recuperado — para usá-lo de novo, cadastre outra vez. Pagamentos já feitos não mudam. Com a cobrança automática ligada, remover o cartão que ela cobra (o padrão) tem efeito sobre ela — a confirmação avisa antes:

- **Era o único cartão** → a cobrança automática é **desligada**; as próximas parcelas passam a ser pagas por você (PIX ou cartão na hora).
- **Há outro cartão salvo** → ela passa a usar o mais recente, que vira o **padrão** — desde que seja de **crédito**. Se ele for de débito ou pré-pago (ou não puder ser conferido naquele momento), a cobrança automática é **desligada**.
- Quando ela é desligada, aparece o aviso **"Cobrança automática desligada"** com o motivo, que fica na tela até você fechar, e a chave da Carteira aparece desligada (se não sobrou nenhum cartão, a chave só volta a aparecer depois que você cadastrar um). Para religar, deixe um cartão de crédito como padrão e ligue a chave de novo.

![Cartões salvos](../images/cliente/pagamentos-02-cartoes.png)
<!-- TODO screenshot: lista de cartões salvos -->

## Dicas e erros comuns

- **PIX não confirmou?** Em alguns minutos o sistema reconcilia automaticamente; a fatura atualiza sozinha.
- **Contador em "Em aberto"**: contratações aguardando pagamento mostram o prazo restante (mm:ss; acima de 1 hora, hh:mm:ss — renovações têm 3 dias). Ao zerar, a cobrança sai da lista.
- **Cartão recusado** gera um alerta para você tentar novamente.
- **"O pagamento foi aprovado no cartão, mas esta cobrança mudou de situação…"**: o cartão foi cobrado, mas a baixa não pôde ser feita sozinha. Não pague de novo — fale com o estúdio para confirmar o pagamento.
- O **valor** mostrado é o oficial calculado pelo servidor.
- Para pagar a **parcela de um contrato sem sair da página**, veja [Contratos → Pagar uma parcela](contratos.md#pagar-uma-parcela-na-hora).

## Ver também

- [Contratos](contratos.md) · [Painel](dashboard.md) · [Notificações e PWA](notificacoes-e-pwa.md)
