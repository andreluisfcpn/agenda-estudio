# Roteiro de capturas de tela (manifesto)

Este arquivo lista **todas as imagens de passo a passo** referenciadas pelos guias de uso. As imagens são capturadas no app de produção (https://app.buzios.digital) ou em ambiente local, salvas no caminho indicado, e passam a aparecer automaticamente no guia correspondente (que já referencia o arquivo).

## Como capturar

1. Recrie dados de teste (um contrato com parcelas, gravações finalizadas etc.) — veja [tecnico/setup-dev.md](tecnico/setup-dev.md) e o script de limpeza em [tecnico/deploy.md](tecnico/deploy.md).
2. Faça login no papel indicado (cliente ou admin).
3. Navegue até a rota e deixe a tela no **estado** descrito.
4. Capture (viewport sugerido: **desktop 1280×800**; para telas marcadas "mobile", use **390×844**).
5. Salve em `docs/images/<area>/<arquivo>` com o nome exato da tabela.

> ⚠️ **Nunca** capture telas mostrando valores de chaves/segredos. Na seção **Integrações** das Configurações, mascare as credenciais antes de capturar.

## Cliente (`docs/images/cliente/`)

| Arquivo | Rota | Estado a capturar |
| --- | --- | --- |
| `login-01-tela-login.png` | `/login` | Formulário de login (e-mail + senha) |
| `login-02-cadastro-otp.png` | `/login` | Etapa de cadastro com campo de código (OTP) |
| `login-03-google.png` | `/login` | Botão "Entrar com Google" em destaque |
| `pwa-01-instalar-prompt.png` | qualquer | Banner/prompt de instalação do PWA |
| `dashboard-01-visao-geral.png` | `/dashboard` | Painel com stats, próximos 7 dias e faturas |
| `dashboard-02-fatura-aberta.png` | `/dashboard` | Card de fatura aberta com contador regressivo |
| `agenda-01-grade.png` | `/calendar` | Grade semanal com horários livres/ocupados por tier |
| `agenda-02-modal-agendamento.png` | `/calendar` | Modal de novo agendamento (tier, horário, contrato) |
| `agenda-03-pagamento.png` | `/calendar` | Checkout do agendamento avulso (PIX/cartão) |
| `agenda-04-hold-contador.png` | `/calendar` | Slot reservado com contador de reserva (hold) |
| `contrato-01-wizard-plano.png` | `/calendar` → wizard | Passo 1 do ContractWizard (escolha de plano/tier) |
| `contrato-02-wizard-agenda.png` | wizard | Passo 2 (Fixa/Flex + data do 1º episódio) |
| `contrato-03-wizard-extras.png` | wizard | Passo 3 (serviços extras por gravação) |
| `contrato-04-wizard-pagamento.png` | wizard | Passo 4 (resumo + plano de pagamento + termos) |
| `contrato-05-lista.png` | `/my-contracts` | Lista de contratos com abas ativos/arquivados |
| `contrato-06-parcela-modal.png` | `/my-contracts` | Modal "Pagar parcela" aberto sobre o contrato |
| `contrato-07-renovar.png` | `/my-contracts` | Modal de renovação |
| `contrato-08-cancelar.png` | `/my-contracts` | Modal de solicitação de cancelamento |
| `contrato-09-servico.png` | `/my-contracts` | Modal de contratação de serviço (ex.: Gestão de Redes) |
| `gravacoes-01-lista.png` | `/my-bookings` | Lista de gravações (próximas e passadas) |
| `gravacoes-02-detalhe-metricas.png` | `/my-bookings` | Detalhe expandido com aba de métricas |
| `gravacoes-03-grafico.png` | `/my-bookings` | Gráfico de métricas por rede (recharts) |
| `pagamentos-01-faturas.png` | `/meus-pagamentos` | Faturas em aberto + histórico |
| `pagamentos-02-cartoes.png` | `/meus-pagamentos` | Cartões salvos (definir padrão / remover) |
| `pagamentos-03-modal-pix.png` | `/meus-pagamentos` | Modal de pagamento na aba PIX (QR code) |
| `pagamentos-04-modal-cartao.png` | `/meus-pagamentos` | Modal de pagamento na aba Cartão |
| `notif-01-sino-desktop.png` | qualquer (desktop) | Dropdown do sino de notificações |
| `notif-02-bottom-sheet-mobile.png` | qualquer (**mobile** 390px) | Notificações em bottom-sheet |
| `pwa-02-banner-atualizar.png` | qualquer | Banner "Nova versão disponível" |
| `pwa-03-offline.png` | qualquer | Indicador de modo offline |

## Admin (`docs/images/admin/`)

| Arquivo | Rota | Estado a capturar |
| --- | --- | --- |
| `hoje-01-grade.png` | `/admin/today` | Grade do dia com sessões |
| `hoje-02-acoes-rapidas.png` | `/admin/today` | Sessão expandida com check-in/concluir/falta |
| `hoje-03-finalizar-gravacao.png` | `/admin/today` | Modal "Finalizar gravação" (métricas por rede) |
| `agendamentos-01-tabela.png` | `/admin/bookings` | Tabela de agendamentos com filtros |
| `agendamentos-02-criar.png` | `/admin/bookings` | Modal de criar agendamento |
| `agendamentos-03-editar.png` | `/admin/bookings` | Modal de editar agendamento |
| `clientes-01-lista.png` | `/admin/clients` | Lista de clientes com filtros por segmento |
| `clientes-02-perfil.png` | `/admin/clients/:id` | Perfil do cliente (contratos/pagamentos/notas) |
| `contratos-01-lista.png` | `/admin/contracts` | Lista de contratos com filtros |
| `contratos-02-detalhe.png` | `/admin/contracts/:id` | Detalhe do contrato (financeiro + bookings) |
| `contratos-03-servicos.png` | `/admin/contracts/:id` | Edição de serviços do contrato |
| `contratos-04-cancelamento.png` | `/admin/contracts` | Resolução de cancelamento (multa/isenção) |
| `financeiro-01-fechamento.png` | `/admin/finance` | Fechamento mensal (bruto/taxas/líquido) |
| `relatorios-01-resumo.png` | `/admin/reports` | Cards de resumo (sessões, receita, taxas) |
| `relatorios-02-ocupacao.png` | `/admin/reports` | Ocupação por horário/dia |
| `relatorios-03-audiencia.png` | `/admin/reports` | Métricas de audiência |
| `config-01-gerais.png` | `/admin/configuracoes?sec=gerais` | Seção Gerais |
| `config-02-horarios.png` | `?sec=horarios` | Seção Horários |
| `config-03-financeiro.png` | `?sec=financeiro` | Seção Financeiro (preços/descontos) |
| `config-04-politicas.png` | `?sec=politicas` | Seção Políticas |
| `config-05-servicos.png` | `?sec=servicos` | Seção Serviços (add-ons) |
| `config-06-pagamentos.png` | `?sec=pagamentos` | Seção Métodos de pagamento |
| `config-07-integracoes.png` | `?sec=integracoes` | Seção Integrações (**mascarar chaves**) |
