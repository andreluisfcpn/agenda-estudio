# Clientes

> Rotas: **`/admin/clients`** (lista) e **`/admin/clients/:id`** (perfil) · Menu: **Clientes** · Acesso: Admin

Cadastro e segmentação da base de clientes, com um perfil detalhado por pessoa.

## Lista de clientes

- **Abas/filtros** por segmento: com contrato ativo, ex-clientes, sem contrato, sem serviço (add-on).
- **Busca** por nome, e-mail ou telefone.
- Cada linha mostra nome, contato, contagem de agendamentos/contratos e última interação.

![Lista de clientes](../images/admin/clientes-01-lista.png)
<!-- TODO screenshot: /admin/clients lista com filtros por segmento -->

### Ações

- **Ver perfil** → abre `/admin/clients/:id`.
- **Criar cliente** → modal com nome, e-mail, telefone.
- **Editar** / **Excluir** (a exclusão cancela contratos associados; confirme com atenção).

## Perfil do cliente

Em `/admin/clients/:id` você vê tudo do cliente em abas:

1. **Contratos** — ativos, arquivados e cancelados.
2. **Agendamentos** — sessões com tier, data, status e preço.
3. **Pagamentos** — histórico (pago/pendente/vencido), com possibilidade de cobrar parcelas.
4. **Notas** — observações internas do admin.

![Perfil do cliente](../images/admin/clientes-02-perfil.png)
<!-- TODO screenshot: /admin/clients/:id com abas de contratos/pagamentos/notas -->

### A partir do perfil você pode

- Criar **novo contrato** ou **agendamento** para o cliente.
- Editar os **dados** do cliente.
- Ligar/desligar **cobrança automática** no cartão salvo.

## Dicas e erros comuns

- A **exclusão** de um cliente é destrutiva (cancela contratos). Prefira marcar como inativo quando possível.
- O resumo financeiro do cliente vem de `GET /api/users/:id/payment-overview` (ver [API](../tecnico/api.md)).

## Ver também

- [Contratos](contratos.md) · [Financeiro](financeiro.md)
