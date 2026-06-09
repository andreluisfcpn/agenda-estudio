// ─── E-mail service ──────────────────────────────────────────────────────────
// Sends transactional e-mail via a provider chosen by the admin in Settings
// (business config): SMTP (nodemailer) or Resend (HTTP API). Secrets (SMTP
// password / Resend API key) are stored encrypted and decrypted here at send
// time. In development, when ALLOW_OTP_BYPASS=true and no provider is configured,
// it falls back to a console mock so login can be exercised without an inbox.

import { config } from '../config/index.js';
import { getConfigString } from './businessConfig.js';
import { decryptConfigSafe } from '../utils/crypto.js';
import { DEFAULT_OTP_EMAIL_HTML, DEFAULT_OTP_EMAIL_SUBJECT } from './emailTemplates.js';

export interface SendEmailInput {
    to: string;
    subject: string;
    html: string;
}

const isDev = config.nodeEnv !== 'production';
const devBypass = () => isDev && process.env.ALLOW_OTP_BYPASS === 'true';

function consoleMock(to: string, subject: string): void {
    console.log(`\n\n======================================================`);
    console.log(`📧 MOCK EMAIL (dev — provedor não configurado)`);
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`======================================================\n\n`);
}

async function resolveFrom(): Promise<string> {
    const fromName = (await getConfigString('email_from_name')) || (await getConfigString('studio_name')) || 'Estúdio Búzios Digital';
    const fromAddress = (await getConfigString('email_from_address')) || (await getConfigString('studio_email')) || 'contato@buzios.digital';
    return `${fromName} <${fromAddress}>`;
}

/** Send an e-mail using the admin-selected provider. Throws on misconfiguration in production. */
export async function sendEmail({ to, subject, html }: SendEmailInput): Promise<void> {
    const provider = ((await getConfigString('email_provider')) || 'smtp').toLowerCase();
    const from = await resolveFrom();

    if (provider === 'resend') {
        const apiKey = decryptConfigSafe(await getConfigString('email_resend_api_key'));
        if (!apiKey) {
            if (devBypass()) return consoleMock(to, subject);
            throw new Error('E-mail (Resend) não configurado: defina a API key em Configurações → E-mail.');
        }
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to, subject, html }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Falha no envio (Resend ${res.status}): ${body.slice(0, 300)}`);
        }
        return;
    }

    // Default: SMTP via nodemailer
    const host = await getConfigString('email_smtp_host');
    const port = parseInt((await getConfigString('email_smtp_port')) || '587', 10);
    const user = await getConfigString('email_smtp_user');
    const pass = decryptConfigSafe(await getConfigString('email_smtp_password'));
    const secure = (await getConfigString('email_smtp_secure')) === 'true';

    if (!host || !user || !pass) {
        if (devBypass()) return consoleMock(to, subject);
        throw new Error('E-mail (SMTP) não configurado: defina host, usuário e senha em Configurações → E-mail.');
    }

    const { default: nodemailer } = await import('nodemailer');
    const transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
    await transporter.sendMail({ from, to, subject, html });
}

function renderTemplate(tpl: string, vars: Record<string, string>): string {
    return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => vars[key] ?? '');
}

/** Render the configurable OTP template and deliver it. Logs the code in dev for easy testing. */
export async function deliverOtpEmail(to: string, name: string, code: string): Promise<void> {
    const studioName = (await getConfigString('studio_name')) || 'Estúdio Búzios Digital';
    const subjectTpl = (await getConfigString('login_email_subject')) || DEFAULT_OTP_EMAIL_SUBJECT;
    const htmlTpl = (await getConfigString('login_email_html')) || DEFAULT_OTP_EMAIL_HTML;
    const vars = { code, name: name || '', studio_name: studioName };

    // Dev convenience: always surface the code in the log, even with a real provider.
    if (isDev) console.log(`\n[OTP] código para ${to}: ${code}\n`);

    await sendEmail({
        to,
        subject: renderTemplate(subjectTpl, vars),
        html: renderTemplate(htmlTpl, vars),
    });
}
