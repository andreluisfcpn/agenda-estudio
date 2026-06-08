# Notificações e PWA

A central de alertas e o uso do app instalado (instalar, atualizar e modo offline).

## Notificações

O **sino** no topo mostra seus alertas (contratos a vencer, pagamentos pendentes/atrasados, sessões a confirmar, etc.), com um **badge** de não lidas. As mais importantes (críticas) aparecem primeiro.

- **No computador:** abre como um painel suspenso.

  ![Sino no desktop](../images/cliente/notif-01-sino-desktop.png)
  <!-- TODO screenshot: dropdown do sino (desktop) -->

- **No celular:** abre como uma **folha inferior (bottom-sheet)**, legível e fácil de tocar.

  ![Notificações no mobile](../images/cliente/notif-02-bottom-sheet-mobile.png)
  <!-- TODO screenshot: notificações em bottom-sheet (mobile 390px) -->

Toque numa notificação para ir direto à ação relacionada (ex.: pagar uma fatura). Você pode marcar como lida ou marcar todas de uma vez.

> Você pode optar por receber **apenas alertas essenciais** (críticos) nas preferências do perfil.

## Instalar o app

Quando o navegador oferecer, toque em **Instalar o app** para adicioná-lo à tela inicial. Depois disso ele abre **direto no sistema** e funciona como um aplicativo (ver [Primeiros passos](primeiros-passos.md#instalar-o-app-pwa)).

## Atualizar

Quando sair uma nova versão, aparece o aviso **"Nova versão disponível"**. Toque em **Atualizar** para carregar a versão mais recente (o app recarrega sozinho).

![Banner de atualização](../images/cliente/pwa-02-banner-atualizar.png)
<!-- TODO screenshot: banner "Nova versão disponível" -->

## Modo offline

Sem internet, o app mostra um **indicador de offline** e continua exibindo o que já estava carregado. As ações que exigem rede (pagar, agendar) voltam a funcionar quando a conexão retorna.

![Indicador offline](../images/cliente/pwa-03-offline.png)
<!-- TODO screenshot: indicador de modo offline -->

## Dicas

- Sua sessão fica salva ~30 dias — o app abre direto no painel.
- Se algo parecer desatualizado, toque em **Atualizar** quando o banner aparecer.

## Ver também

- [Primeiros passos](primeiros-passos.md) · [Painel](dashboard.md) · [Pagamentos](pagamentos.md)
