# Agendamentos

> Rota: **`/admin/bookings`** · Menu: **Agendamentos** · Acesso: Admin

Gestão completa (CRUD) de todos os agendamentos do estúdio, com filtros, busca e cobrança.

## Visão geral

- KPIs no topo: total, confirmados, concluídos, cancelados, receita.
- **Filtros** por período e status; **busca** por nome/e-mail do cliente (agendamentos de cliente excluído aparecem só com o nome).
- Tabela com data, horário, cliente, tier, status, preço, contrato e ações.

![Tabela de agendamentos](../images/admin/agendamentos-01-tabela.png)
<!-- TODO screenshot: /admin/bookings tabela com filtros -->

## Criar um agendamento

1. Clique em **Criar/Novo agendamento**.
2. Selecione o **cliente** e, se houver, o **contrato**.
3. Escolha **data** e **horário**.
4. (Opcional) ajuste o **preço** e decida **cobrar agora** (PIX/cartão) ou criar **sem cobrança** (offline).
5. **Salvar**.

![Criar agendamento](../images/admin/agendamentos-02-criar.png)
<!-- TODO screenshot: modal de criação de agendamento -->

## Editar um agendamento

Na linha desejada, use **Editar** para alterar data, horário, preço, status e notas. Você também pode mudar o status direto (ex.: `CONFIRMED` → `COMPLETED`/`CANCELLED`/`FALTA`). **Falta** e **Não realizado** pedem o motivo antes de gravar; **Cancelado** pede a confirmação de perigo (veja [Cancelar e excluir](#cancelar-e-excluir)).

### Remarcar a falta do avulso

Numa gravação **avulsa** em **Falta justificada** ou **Não realizado**, use **Remarcar** (em vez de editar a data à mão): o sistema confere horário livre, bloqueios e a mesma faixa, e reaproveita o pagamento já feito. O prazo é até o fim do 7º dia após a gravação perdida; em **Não realizado** o admin pode remarcar mesmo depois do prazo. Se você editar o status de uma falta com remarcação liberada para "Confirmado"/"Concluído", o direito conta como **usado**; se cancelar a reserva, o direito é retirado.

![Editar agendamento](../images/admin/agendamentos-03-editar.png)
<!-- TODO screenshot: modal de edição de agendamento -->

## Cancelar e excluir

As duas ações abrem um diálogo vermelho de confirmação com a lista do que vai acontecer de fato. Nada é gravado antes de você clicar em **Cancelar agendamento** / **Excluir agendamento**; se a API recusar, o erro aparece dentro do próprio diálogo.

- **Cancelar** (escolher **Cancelado** no status da linha, no **Editar** ou o botão **Cancelar** da tela [Hoje](hoje.md)) mantém o registro com status cancelado.
  - Sessão ainda não realizada (Reservado/Confirmado): o horário volta a ficar livre e, em Flex/Avulso (e Personalizado com créditos), **1 crédito volta** para o contrato.
  - Sessão já concluída, em falta ou não realizada: só o status muda; o crédito já usado **não volta** e a remarcação liberada de um avulso é retirada.
  - Nenhum pagamento é estornado automaticamente.
- **Excluir definitivo** (lixeira) apaga a linha como se nunca tivesse existido: some da agenda, do histórico do cliente e das métricas. Em sessão ainda não realizada, libera o horário e **devolve o crédito** (Flex/Avulso/Personalizado com créditos). Um pagamento ligado a ela continua no Financeiro, sem o vínculo. Para manter o histórico, prefira **Cancelado**.
- No select de status da linha, navegar com as setas do teclado só pré-seleciona (antes cada passo gravava um status). Aperte **Enter** (ou saia do campo) para aplicar e **Esc** para desistir. Com o mouse, escolher na lista aplica na hora.

## Dicas e erros comuns

- Para **finalizar com métricas**, use a tela [Hoje](hoje.md) (modal de finalização) — é o caminho pensado para o pós-gravação.
- Mudanças de status que afetam crédito Flex (não realizado/cancelamento) são refletidas no contrato do cliente. A **falta** consome a sessão (não devolve crédito).
- Toda mudança de status recalcula o status do contrato: ele fica **Concluído** quando não resta nada a fazer e volta a **Ativo** se uma gravação for reaberta (ver [Contratos](contratos.md)).

## Ver também

- [Hoje](hoje.md) · [Contratos](contratos.md) · [Clientes](clientes.md)
