// ─── Notification Event Catalog ─────────────────────────
// SINGLE source of truth for every notification EVENT the system can emit:
// default title/message (NO emoji — the frontend renders a lucide icon per
// type), severity, push default, actionUrl and the interpolation variables.
// Consumed by:
//   - modules/notifications/templateStore.ts (merges DB overrides over defaults)
//   - notifyEvent() (persisted call sites) + routes.ts computed rules
//   - admin API (GET events) + admin UI (edit templates)
// The admin edits only OVERRIDES (notification_templates table); defaults here
// keep propagating unless explicitly overridden.

import { NotificationType } from '../generated/prisma/client.js';

export interface NotificationEventVariable {
    name: string;    // used as {name} in title/message
    label: string;   // PT label for the admin UI chip
    example: string; // sample value for preview + test send
}

export interface NotificationEventDef {
    eventKey: string;
    label: string;
    description: string;
    group: 'pagamentos' | 'sessoes' | 'contratos' | 'creditos' | 'admin';
    audience: 'client' | 'admin';
    kind: 'persisted' | 'computed';
    type: NotificationType;
    // 'dynamic' = severity is decided by the caller at runtime (an admin override
    // to a fixed value flattens it — the UI labels a null override as "automática").
    severity: 'critical' | 'warning' | 'info' | 'dynamic';
    pushDefault: boolean;
    actionUrl: string;
    defaultTitle: string;
    defaultMessage: string;
    variables: NotificationEventVariable[];
}

const V = {
    valor: { name: 'valor', label: 'Valor', example: 'R$ 250,00' },
    hora: { name: 'hora', label: 'Hora', example: '20:30' },
    data: { name: 'data', label: 'Data', example: '12/07' },
    // Rótulo do dia no fuso SP (spDayLabel). O valor real depende do evento, então cada evento que usa
    // diaLabel sobrescreve o exemplo (Prévia/Enviar teste do admin): 24h → 'amanhã (16/09)', 2h → 'hoje (16/09)'.
    diaLabel: { name: 'diaLabel', label: 'Dia (rótulo)', example: 'hoje (16/09)' },
    contrato: { name: 'contrato', label: 'Nome do contrato', example: 'Plano Fixo 3 meses' },
    servico: { name: 'servico', label: 'Nome do serviço', example: 'Gestão de Redes Sociais' },
    quantidade: { name: 'quantidade', label: 'Quantidade', example: '2' },
    restantes: { name: 'restantes', label: 'Créditos restantes', example: '3' },
    dias: { name: 'dias', label: 'Dias', example: '3' },
    total: { name: 'total', label: 'Total (R$)', example: 'R$ 480,00' },
    diasMax: { name: 'diasMax', label: 'Dias em atraso (máx.)', example: '12' },
    cliente: { name: 'cliente', label: 'Nome do cliente', example: 'Maria Silva' },
    // Remarcação do avulso (D4/D5): último dia da janela e a nova data escolhida.
    prazo: { name: 'prazo', label: 'Prazo para remarcar (DD/MM)', example: '22/09' },
    novaData: { name: 'novaData', label: 'Nova data (DD/MM)', example: '19/09' },
} as const;

export const NOTIFICATION_EVENT_CATALOG: NotificationEventDef[] = [
    // ── Pagamentos (cliente) ──────────────────────────────
    {
        eventKey: 'payment_confirmed', label: 'Pagamento confirmado',
        description: 'Enviada quando um pagamento do cliente é confirmado (PIX, boleto ou cartão).',
        group: 'pagamentos', audience: 'client', kind: 'persisted',
        type: 'PAYMENT_CONFIRMED', severity: 'info', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Pagamento confirmado',
        defaultMessage: 'Seu pagamento de {valor} foi confirmado!',
        variables: [V.valor],
    },
    {
        eventKey: 'payment_failed', label: 'Pagamento recusado',
        description: 'Enviada quando um pagamento é recusado (webhook do provedor).',
        group: 'pagamentos', audience: 'client', kind: 'persisted',
        type: 'PAYMENT_FAILED', severity: 'critical', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Pagamento não concluído',
        defaultMessage: 'Seu pagamento foi recusado. Tente novamente em Meus Pagamentos.',
        variables: [],
    },
    {
        eventKey: 'payment_expired', label: 'Cobrança expirada',
        description: 'Enviada quando um PIX ou boleto é cancelado ou expira antes do pagamento.',
        group: 'pagamentos', audience: 'client', kind: 'persisted',
        type: 'PAYMENT_FAILED', severity: 'critical', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Cobrança expirada',
        defaultMessage: 'Seu PIX/boleto foi cancelado ou expirou. Gere uma nova cobrança em Meus Pagamentos.',
        variables: [],
    },
    {
        eventKey: 'auto_charge_authentication', label: 'Cobrança automática — autenticação',
        description: 'Cobrança automática exige autenticação do banco (3DS).',
        group: 'pagamentos', audience: 'client', kind: 'persisted',
        type: 'PAYMENT_FAILED', severity: 'warning', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Cobrança automática requer sua confirmação',
        defaultMessage: 'Seu banco pediu autenticação para a cobrança automática. Pague manualmente na aba Pagamentos para concluir.',
        variables: [],
    },
    {
        eventKey: 'auto_charge_failed', label: 'Cobrança automática — falha',
        description: 'A cobrança automática no cartão salvo não foi concluída.',
        group: 'pagamentos', audience: 'client', kind: 'persisted',
        type: 'PAYMENT_FAILED', severity: 'critical', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Cobrança automática não concluída',
        defaultMessage: 'Não conseguimos cobrar sua parcela no cartão cadastrado. Pague manualmente na aba Pagamentos ou atualize seu cartão.',
        variables: [],
    },
    // ── Sessões (cliente) ─────────────────────────────────
    {
        eventKey: 'booking_reminder_24h', label: 'Lembrete de sessão (24h antes)',
        description: 'Enviado exatamente 24 horas antes da gravação (mesmo horário, na véspera). Sessões marcadas com menos de 24h de antecedência não recebem este lembrete.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_REMINDER', severity: 'warning', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Sessão {diaLabel}',
        defaultMessage: 'Lembrete: você tem uma gravação {diaLabel} às {hora}.',
        variables: [{ ...V.diaLabel, example: 'amanhã (16/09)' }, V.data, V.hora],
    },
    {
        eventKey: 'booking_reminder_2h', label: 'Lembrete de sessão (2h antes)',
        description: 'Enviado exatamente 2 horas antes da gravação.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_REMINDER', severity: 'critical', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Sessão em 2 horas',
        defaultMessage: 'Sua gravação é {diaLabel} às {hora} — prepare-se!',
        variables: [{ ...V.diaLabel, example: 'hoje (16/09)' }, V.hora],
    },
    {
        eventKey: 'daily_confirmation_paid', label: 'Confirmação do dia (paga)',
        description: 'Aviso matinal (7h) confirmando a gravação do dia já paga.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_CONFIRMED', severity: 'info', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Gravação confirmada',
        defaultMessage: 'Sua gravação de hoje às {hora} está confirmada. Até logo!',
        variables: [V.hora],
    },
    {
        eventKey: 'daily_confirmation_unpaid', label: 'Confirmação do dia (pague para confirmar)',
        description: 'Aviso matinal (7h) de gravação do dia ainda não paga.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_UNCONFIRMED', severity: 'warning', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Pague para confirmar',
        defaultMessage: 'Sua gravação de hoje às {hora} ainda não está paga. Pague para confirmar.',
        variables: [V.hora],
    },
    // ── Remarcação do avulso (cliente) — D4/D5 ────────────
    // Tipos NÃO efêmeros de propósito (BOOKING_CANCELLED / SYSTEM): a limpeza diária apaga os tipos
    // efêmeros (BOOKING_REMINDER, BOOKING_CONFIRMED, BOOKING_UNCONFIRMED…) em 48h, e estes avisos valem
    // pela janela inteira (7 dias) ou pedem ação do estúdio. Abertura/lembrete/expiração dividem a tag
    // de push `BOOKING_CANCELLED-<booking>`: o mais recente substitui o anterior na bandeja.
    {
        eventKey: 'avulso_makeup_opened', label: 'Remarcação liberada (avulso)',
        description: 'Enviada quando o estúdio justifica a falta de uma gravação avulsa ou marca a gravação como não realizada: o cliente pode remarcar sem novo pagamento até o prazo.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_CANCELLED', severity: 'critical', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Você pode remarcar sua gravação',
        defaultMessage: 'A gravação de {data} pode ser remarcada sem novo pagamento até {prazo}. Escolha o novo horário em Minhas Gravações.',
        variables: [V.data, V.prazo],
    },
    {
        eventKey: 'avulso_makeup_reminder', label: 'Lembrete de remarcação (avulso)',
        description: 'Lembrete nos 2 últimos dias da janela de remarcação sem novo pagamento (no máximo 1 por dia).',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_CANCELLED', severity: 'critical', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Remarque sua gravação: {dias} dia(s) restante(s)',
        defaultMessage: 'A gravação de {data} pode ser remarcada sem novo pagamento até {prazo}, às 23h59. Escolha o novo horário em Minhas Gravações.',
        variables: [{ ...V.dias, example: '2' }, V.data, V.prazo],
    },
    {
        eventKey: 'avulso_makeup_expired', label: 'Prazo de remarcação encerrado — falta',
        description: 'Enviada quando termina, sem remarcação, a janela de uma falta justificada: o valor pago é perdido.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_CANCELLED', severity: 'critical', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Prazo de remarcação encerrado',
        defaultMessage: 'O prazo para remarcar a gravação de {data} terminou em {prazo}. Como ela não foi remarcada, o valor pago não é reembolsável.',
        variables: [V.data, V.prazo],
    },
    {
        eventKey: 'avulso_makeup_expired_studio', label: 'Prazo de remarcação encerrado — não realizada',
        description: 'Enviada quando termina, sem remarcação, a janela de uma gravação que o estúdio não realizou: o valor continua garantido e o estúdio entra em contato.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'BOOKING_CANCELLED', severity: 'critical', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Vamos combinar sua gravação',
        defaultMessage: 'O prazo para remarcar a gravação de {data} terminou em {prazo}. Seu valor continua garantido: o estúdio vai entrar em contato para combinar a nova data.',
        variables: [V.data, V.prazo],
    },
    {
        eventKey: 'avulso_makeup_rescheduled', label: 'Gravação remarcada pelo estúdio (avulso)',
        description: 'Enviada ao cliente quando o estúdio remarca a gravação avulsa perdida (falta justificada ou não realizada), sem novo pagamento. Não é enviada quando o próprio cliente remarca.',
        group: 'sessoes', audience: 'client', kind: 'persisted',
        type: 'SYSTEM', severity: 'warning', pushDefault: true, actionUrl: '/minhas-gravacoes',
        defaultTitle: 'Gravação remarcada',
        defaultMessage: 'O estúdio remarcou sua gravação de {data} para {novaData} às {hora}, sem novo pagamento.',
        variables: [V.data, V.novaData, V.hora],
    },
    // ── Créditos FLEX (cliente) ───────────────────────────
    {
        eventKey: 'flex_credit_lost', label: 'Crédito FLEX perdido',
        description: 'Enviada quando um crédito de gravação FLEX é perdido por não uso.',
        group: 'creditos', audience: 'client', kind: 'persisted',
        type: 'FLEX_CREDITS_LOW', severity: 'critical', pushDefault: true, actionUrl: '/meus-contratos',
        defaultTitle: 'Crédito de gravação perdido',
        defaultMessage: 'Você perdeu {quantidade} crédito(s) do contrato "{contrato}" por não usar a tempo. Restam {restantes}.',
        variables: [V.quantidade, V.contrato, V.restantes],
    },
    {
        eventKey: 'flex_credit_at_risk', label: 'Crédito FLEX em risco',
        description: 'Aviso de que há crédito FLEX a expirar nesta janela.',
        group: 'creditos', audience: 'client', kind: 'persisted',
        type: 'FLEX_CREDITS_LOW', severity: 'warning', pushDefault: true, actionUrl: '/meus-contratos',
        defaultTitle: 'Grave esta semana para não perder o crédito',
        defaultMessage: 'Faltam {dias} dia(s) para você usar o crédito da semana do contrato "{contrato}".',
        variables: [V.dias, V.contrato],
    },
    // ── Contratos (cliente) ───────────────────────────────
    {
        eventKey: 'contract_activated', label: 'Contrato ativado',
        description: 'Enviada quando um contrato (Fixo/Flex/Custom) é ativado.',
        group: 'contratos', audience: 'client', kind: 'persisted',
        type: 'CONTRACT_ACTIVATED', severity: 'info', pushDefault: false, actionUrl: '/meus-contratos',
        defaultTitle: 'Contrato ativado',
        defaultMessage: 'Seu contrato "{contrato}" foi ativado! Seus agendamentos já estão confirmados.',
        variables: [V.contrato],
    },
    {
        eventKey: 'service_activated', label: 'Serviço ativado',
        description: 'Enviada quando um serviço avulso (ex.: Gestão de Redes) é ativado.',
        group: 'contratos', audience: 'client', kind: 'persisted',
        type: 'CONTRACT_ACTIVATED', severity: 'info', pushDefault: false, actionUrl: '/meus-contratos',
        defaultTitle: 'Serviço ativado',
        defaultMessage: 'Seu serviço "{servico}" foi ativado com sucesso!',
        variables: [V.servico],
    },
    // ── Admin (persisted) ─────────────────────────────────
    {
        eventKey: 'admin_booking_confirmed', label: 'Admin — sessão confirmada',
        description: 'Notifica o admin quando um cliente confirma uma sessão.',
        group: 'admin', audience: 'admin', kind: 'persisted',
        type: 'BOOKING_CONFIRMED', severity: 'info', pushDefault: false, actionUrl: '/admin/today',
        defaultTitle: 'Sessão confirmada',
        defaultMessage: '{cliente} confirmou a sessão de {data} às {hora}.',
        variables: [V.cliente, V.data, V.hora],
    },
    {
        eventKey: 'admin_booking_cancelled', label: 'Admin — sessão cancelada',
        description: 'Notifica o admin quando um cliente cancela uma sessão.',
        group: 'admin', audience: 'admin', kind: 'persisted',
        type: 'BOOKING_CANCELLED', severity: 'warning', pushDefault: false, actionUrl: '/admin/today',
        defaultTitle: 'Sessão cancelada',
        defaultMessage: '{cliente} cancelou a sessão de {data} às {hora}.',
        variables: [V.cliente, V.data, V.hora],
    },
    {
        eventKey: 'admin_makeup_rescheduled', label: 'Admin — gravação avulsa remarcada',
        description: 'Notifica os admins quando uma gravação avulsa perdida (falta justificada ou não realizada) é remarcada sem novo pagamento (quem remarcou não é notificado).',
        group: 'admin', audience: 'admin', kind: 'persisted',
        type: 'SYSTEM', severity: 'info', pushDefault: false, actionUrl: '/admin/today',
        defaultTitle: 'Gravação remarcada',
        defaultMessage: 'A gravação de {cliente} de {data} foi remarcada para {novaData} às {hora}.',
        variables: [V.cliente, V.data, V.novaData, V.hora],
    },
    {
        eventKey: 'admin_makeup_expired_studio', label: 'Admin — não realizada sem remarcação',
        description: 'Avisa o admin quando termina a janela de uma gravação avulsa que o estúdio não realizou e o cliente não remarcou: resolver com o cliente (o admin ainda pode remarcar).',
        group: 'admin', audience: 'admin', kind: 'persisted',
        type: 'BOOKING_CANCELLED', severity: 'critical', pushDefault: true, actionUrl: '/admin/contracts',
        defaultTitle: 'Gravação não realizada sem remarcação',
        defaultMessage: '{cliente} não remarcou a gravação de {data} (não realizada pelo estúdio) até {prazo}. Entre em contato para combinar a nova data.',
        variables: [V.cliente, V.data, V.prazo],
    },
    // ── Computed (cliente) ────────────────────────────────
    {
        eventKey: 'computed_contract_expiring', label: 'Contrato expirando',
        description: 'Alerta recorrente enquanto um contrato do cliente está perto do fim.',
        group: 'contratos', audience: 'client', kind: 'computed',
        type: 'CONTRACT_EXPIRING', severity: 'dynamic', pushDefault: true, actionUrl: '/meus-contratos',
        defaultTitle: 'Contrato expirando',
        defaultMessage: 'Seu contrato "{contrato}" expira em {dias} dia(s).',
        variables: [V.contrato, V.dias],
    },
    {
        eventKey: 'computed_payment_overdue', label: 'Faturas vencidas (agregada)',
        description: 'Resumo das faturas vencidas do cliente (uma notificação com o total).',
        group: 'pagamentos', audience: 'client', kind: 'computed',
        type: 'PAYMENT_OVERDUE', severity: 'dynamic', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Você tem faturas vencidas',
        defaultMessage: 'Você tem {quantidade} fatura(s) vencida(s) totalizando {total}.',
        variables: [V.quantidade, V.total, V.diasMax],
    },
    {
        eventKey: 'computed_payment_failed', label: 'Pagamento com cartão falhou (recorrente)',
        description: 'Alerta recorrente enquanto houver um pagamento com cartão em falha.',
        group: 'pagamentos', audience: 'client', kind: 'computed',
        type: 'PAYMENT_OVERDUE', severity: 'critical', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Pagamento com cartão falhou',
        defaultMessage: 'Seu último pagamento com cartão falhou. Atualize o cartão ou tente novamente.',
        variables: [],
    },
    {
        eventKey: 'computed_cancellation_pending', label: 'Cancelamento em análise',
        description: 'Alerta enquanto um pedido de cancelamento do cliente está em análise.',
        group: 'contratos', audience: 'client', kind: 'computed',
        type: 'CANCELLATION_PENDING', severity: 'warning', pushDefault: true, actionUrl: '/meus-contratos',
        defaultTitle: 'Cancelamento em análise',
        defaultMessage: 'Seu pedido de cancelamento do contrato "{contrato}" está em análise.',
        variables: [V.contrato],
    },
    {
        eventKey: 'computed_contract_awaiting', label: 'Contrato aguardando pagamento',
        description: 'Alerta enquanto um contrato aguarda o pagamento inicial (com prazo).',
        group: 'contratos', audience: 'client', kind: 'computed',
        type: 'CONTRACT_AWAITING_PAYMENT', severity: 'dynamic', pushDefault: true, actionUrl: '/meus-pagamentos',
        defaultTitle: 'Contrato aguardando pagamento',
        defaultMessage: 'Seu contrato "{contrato}" aguarda o pagamento para ser ativado.',
        variables: [V.contrato],
    },
    // ── Computed (admin) ──────────────────────────────────
    {
        eventKey: 'computed_contract_expiring_admin', label: 'Admin — contrato de cliente expirando',
        description: 'Alerta para o admin sobre contratos de clientes perto do fim.',
        group: 'admin', audience: 'admin', kind: 'computed',
        type: 'CONTRACT_EXPIRING', severity: 'dynamic', pushDefault: false, actionUrl: '/admin/contracts',
        defaultTitle: 'Contrato expirando',
        defaultMessage: 'O contrato "{contrato}" de {cliente} expira em {dias} dia(s).',
        variables: [V.cliente, V.contrato, V.dias],
    },
    {
        eventKey: 'computed_payment_overdue_admin', label: 'Admin — cliente com faturas vencidas',
        description: 'Resumo por cliente das faturas vencidas (uma por cliente).',
        group: 'admin', audience: 'admin', kind: 'computed',
        type: 'PAYMENT_OVERDUE', severity: 'dynamic', pushDefault: false, actionUrl: '/admin/finance',
        defaultTitle: 'Cliente com faturas vencidas',
        defaultMessage: '{cliente} tem {quantidade} fatura(s) vencida(s) totalizando {total}.',
        variables: [V.cliente, V.quantidade, V.total, V.diasMax],
    },
    {
        eventKey: 'computed_payment_failed_admin', label: 'Admin — pagamento de cliente falhou',
        description: 'Alerta para o admin sobre pagamento com cartão de cliente em falha.',
        group: 'admin', audience: 'admin', kind: 'computed',
        type: 'PAYMENT_OVERDUE', severity: 'critical', pushDefault: false, actionUrl: '/admin/finance',
        defaultTitle: 'Pagamento de cliente falhou',
        defaultMessage: 'O pagamento de {valor} de {cliente} falhou.',
        variables: [V.cliente, V.valor],
    },
    {
        eventKey: 'computed_booking_unconfirmed_admin', label: 'Admin — sessão não confirmada',
        description: 'Alerta para o admin sobre sessão do dia ainda não confirmada.',
        group: 'admin', audience: 'admin', kind: 'computed',
        type: 'BOOKING_UNCONFIRMED', severity: 'critical', pushDefault: false, actionUrl: '/admin/today',
        defaultTitle: 'Sessão não confirmada',
        defaultMessage: '{cliente} tem uma sessão {diaLabel} às {hora} ainda não confirmada.',
        variables: [V.cliente, V.hora, { ...V.diaLabel, example: 'hoje' }], // em runtime recebe 'hoje'
    },
    {
        eventKey: 'computed_cancellation_pending_admin', label: 'Admin — cancelamento pendente',
        description: 'Alerta para o admin sobre pedido de cancelamento a resolver.',
        group: 'admin', audience: 'admin', kind: 'computed',
        type: 'CANCELLATION_PENDING', severity: 'warning', pushDefault: false, actionUrl: '/admin/contracts',
        defaultTitle: 'Cancelamento pendente',
        defaultMessage: '{cliente} solicitou o cancelamento do contrato "{contrato}".',
        variables: [V.cliente, V.contrato],
    },
    {
        eventKey: 'computed_contract_awaiting_admin', label: 'Admin — contrato aguardando pagamento',
        description: 'Alerta para o admin sobre contrato de cliente aguardando pagamento.',
        group: 'admin', audience: 'admin', kind: 'computed',
        type: 'CONTRACT_AWAITING_PAYMENT', severity: 'dynamic', pushDefault: false, actionUrl: '/admin/contracts',
        defaultTitle: 'Contrato aguardando pagamento',
        defaultMessage: 'O contrato "{contrato}" de {cliente} aguarda pagamento.',
        variables: [V.cliente, V.contrato],
    },
];

export const NOTIFICATION_EVENT_BY_KEY: Record<string, NotificationEventDef> = Object.fromEntries(
    NOTIFICATION_EVENT_CATALOG.map(e => [e.eventKey, e]),
);

/** Extract the {placeholder} names referenced in a text. */
export function extractPlaceholders(text: string): string[] {
    return Array.from(text.matchAll(/\{(\w+)\}/g), m => m[1]!);
}
