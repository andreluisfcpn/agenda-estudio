// ─── Default e-mail templates ───────────────────────────────────────────────
// Single source for the default OTP login e-mail (subject + HTML). Imported by
// both the business-config catalog (as the editable default) and the email
// service (as a hard fallback). Kept dependency-free to avoid import cycles.
//
// Template placeholders (replaced at send time): {{code}}, {{name}}, {{studio_name}}

export const DEFAULT_OTP_EMAIL_SUBJECT = 'Seu código de acesso — {{studio_name}}';

// Table-based, inline-styled HTML for broad e-mail-client compatibility (Gmail,
// Outlook, Apple Mail). Brand: Estúdio Búzios Digital (teal accent on dark).
export const DEFAULT_OTP_EMAIL_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>{{studio_name}}</title></head>
<body style="margin:0; padding:0; background-color:#0b1620; font-family:'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b1620; padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background-color:#10212e; border:1px solid #1d3340; border-radius:16px; overflow:hidden;">
        <tr>
          <td style="background:linear-gradient(135deg,#0e6f86,#11819b); padding:28px 32px; text-align:center;">
            <div style="font-size:20px; font-weight:800; letter-spacing:0.5px; color:#ffffff;">{{studio_name}}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 6px; font-size:16px; color:#e8eef2; font-weight:700;">Olá, {{name}} 👋</p>
            <p style="margin:0 0 24px; font-size:14px; line-height:1.6; color:#9fb3c0;">Use o código abaixo para acessar a sua conta. Ele é válido por <strong style="color:#e8eef2;">5 minutos</strong>.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr><td align="center">
                <div style="display:inline-block; background-color:#0b1620; border:1px solid #1d3340; border-radius:12px; padding:18px 28px; font-size:38px; font-weight:800; letter-spacing:10px; color:#33c4e0; font-family:'Courier New', monospace;">{{code}}</div>
              </td></tr>
            </table>
            <p style="margin:24px 0 0; font-size:13px; line-height:1.6; color:#7d93a1;">Se você não solicitou este código, ignore este e-mail — nenhuma ação é necessária.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 32px; border-top:1px solid #1d3340; text-align:center;">
            <p style="margin:0; font-size:12px; color:#5f7585;">© {{studio_name}} · Este é um e-mail automático.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
