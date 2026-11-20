import type { DatabaseSync } from 'node:sqlite';
import { EVENT, PROGRAM, eventDetails, googleCalUrl, mapsUrl } from '../src/shared/event.js';
import { validEmail } from '../src/shared/identity.js';

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const FROM = { name: 'Gala Huawei Digital Power', email: 'invitaciones@galadigitalpower.com.ar' };
const REPLY = { name: 'Gala Huawei Digital Power', email: 'gala@galadigitalpower.com.ar' };

const baseUrl = () => (process.env.PUBLIC_URL || 'https://galadigitalpower.com.ar').replace(/\/+$/, '');
export const checkinUrl = (checkinToken: string) => `${baseUrl()}/checkin.html?c=${encodeURIComponent(checkinToken)}`; // same URL the ticket page encodes

const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Dark layout of src/email/save-the-date-noche.html: tables + inline styles, Arial, no web fonts.
export function ticketEmail({ name, pin, ticketToken }: { name: string; pin: string; ticketToken: string }) {
  const base = baseUrl();
  const ticketUrl = `${base}/ticket.html?t=${encodeURIComponent(ticketToken)}`;
  const cal = googleCalUrl({ pin, url: ticketUrl }, base + '/');
  const first = name.replace(/\s*\(demo\)$/, '').trim().split(/\s+/)[0] || '';
  const qr = `${base}/api/ticket/${encodeURIComponent(ticketToken)}/qr.png`;
  const F = 'font-family:Arial,Helvetica,sans-serif;';
  const btn = (href: string, label: string, primary: boolean) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 12px;"><tr><td align="center" bgcolor="${primary ? '#D4AF6A' : '#0B0708'}" style="border:1px solid #D4AF6A;border-radius:6px;">`
    + `<a href="${esc(href)}" style="display:block;padding:14px 28px;${F}font-size:15px;font-weight:bold;color:${primary ? '#0B0708' : '#D4AF6A'};text-decoration:none;">${esc(label)}</a></td></tr></table>`;
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>Tu entrada · Gala Digital Power 2026</title>
<style>@media (max-width:620px){.wrap{width:100%!important}.pad{padding-left:24px!important;padding-right:24px!important}}</style></head>
<body style="margin:0;padding:0;background:#050303;">
<div style="display:none;max-height:0;overflow:hidden;">Tu QR y tu PIN para la Gala Digital Power 2026. Lunes 30 de noviembre · 18:30.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#050303" style="background:#050303;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#0B0708" style="width:600px;max-width:600px;background:#0B0708;">
<tr><td align="center" style="padding:28px 0 4px;line-height:0;"><img src="${base}/email/huawei-white.png" width="96" alt="Huawei" style="display:block;width:96px;height:auto;border:0;margin:0 auto;"></td></tr>
<tr><td class="pad" align="center" style="padding:10px 48px 0;${F}color:#F3E8DA;">
<p style="margin:0;font-size:13px;letter-spacing:5px;">TU ENTRADA</p>
<h1 style="margin:14px 0 0;${F}font-size:34px;line-height:1.1;font-weight:normal;letter-spacing:2px;"><span style="color:#D4AF6A;">GALA</span> <span style="font-size:18px;letter-spacing:5px;">DIGITAL POWER</span> <span style="color:#D4AF6A;">2026</span></h1>
<p style="margin:22px 0 0;font-size:17px;line-height:1.5;">Hola ${esc(first)}, ¡tu lugar está confirmado!</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="#F7F1E8" style="margin:22px auto 0;background:#F7F1E8;border-radius:8px;"><tr><td style="padding:10px;line-height:0;"><img src="${qr}" width="220" height="220" alt="Tu código QR" style="display:block;width:220px;height:220px;border:0;"></td></tr></table>
<p style="margin:22px 0 4px;font-size:12px;letter-spacing:4px;color:#D4AF6A;">TU PIN</p>
<p style="margin:0;font-size:36px;font-weight:bold;letter-spacing:10px;color:#F3E8DA;">${esc(pin)}</p>
<p style="margin:18px 0 26px;font-size:15px;line-height:1.5;">Muestra este QR en la acreditación. Usa tu PIN para jugar en las pantallas.</p>
${btn(ticketUrl, 'Ver mi entrada', true)}${btn(cal, 'Agregar a Google Calendar', false)}
</td></tr>
<tr><td class="pad" style="padding:26px 48px 0;${F}color:#F3E8DA;font-size:15px;line-height:1.6;">
<p style="margin:0;"><b style="color:#D4AF6A;">${esc(EVENT.when)}</b></p>
<p style="margin:4px 0 0;"><a href="${esc(mapsUrl())}" style="color:#F3E8DA;text-decoration:underline;">${esc(EVENT.venue)}</a></p>
<p style="margin:24px 0 8px;font-size:12px;letter-spacing:4px;color:#D4AF6A;">AGENDA</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${PROGRAM.map(([t, l]) => `<tr><td width="64" valign="top" style="padding:3px 0;${F}font-size:14px;font-weight:bold;color:#D4AF6A;">${esc(t)}</td><td style="padding:3px 0;${F}font-size:14px;color:#F3E8DA;">${esc(l)}</td></tr>`).join('')}</table>
<p style="margin:24px 0 0;"><b style="color:#D4AF6A;">Dress code:</b> ${esc(EVENT.dress)}</p>
</td></tr>
<tr><td class="pad" align="center" style="padding:30px 48px 32px;${F}font-size:12px;line-height:1.6;color:#A99C8E;">Recibes este correo porque te inscribiste en la Gala Digital Power 2026.<br>¿Dudas? Escríbenos a <a href="mailto:${REPLY.email}" style="color:#A99C8E;">${REPLY.email}</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    `Hola ${first}, ¡tu lugar está confirmado!`, '',
    `Tu PIN: ${pin}`, 'Muestra tu QR en la acreditación. Usa tu PIN para jugar en las pantallas.', '',
    `Ver mi entrada (QR y PIN): ${ticketUrl}`, `Agregar a Google Calendar: ${cal}`, '',
    EVENT.when, `${EVENT.venue}`, `Cómo llegar: ${mapsUrl()}`, '',
    'AGENDA', ...PROGRAM.map(([t, l]) => `${t} · ${l}`), '',
    `Dress code: ${EVENT.dress}`, '',
    'Recibes este correo porque te inscribiste en la Gala Digital Power 2026.', `¿Dudas? Escríbenos a ${REPLY.email}`,
  ].join('\n');
  return { html, text };
}

export type MailResult = { ok: true } | { ok: false; skipped?: 'no_key' };

// Never throws: a mail problem must not break registration or check-in.
// Brevo has no per-message tracking switch in this endpoint (it is an account setting), so none is sent.
export async function sendTicketEmail({ to, name, pin, ticketToken }: { to: string; name: string; pin: string; ticketToken: string }): Promise<MailResult> {
  const key = process.env.BREVO_API_KEY;
  if (!key) return { ok: false, skipped: 'no_key' };
  if (!validEmail(to)) return { ok: false }; // legacy rows from before the ASCII-only rule
  const redirect = process.env.MAIL_REDIRECT_TO;
  const { html, text } = ticketEmail({ name, pin, ticketToken });
  try {
    const res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: FROM, replyTo: REPLY, to: [{ email: redirect || to }],
        subject: (redirect ? `[PRUEBA → ${to}] ` : '') + 'Tu entrada · Gala Digital Power 2026',
        htmlContent: html, textContent: text, headers: { 'X-Mailin-Tag': 'ticket' },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) { console.error('mail: brevo', res.status, (await res.text().catch(() => '')).slice(0, 200)); return { ok: false }; }
    return { ok: true };
  } catch (e) {
    console.error('mail: send failed', (e as Error).name);
    return { ok: false };
  }
}

const inflight = new Set<Promise<unknown>>();
export const mailIdle = () => Promise.allSettled([...inflight]); // tests await this; production ignores it

// Emails a guest's ticket and stamps registration.email_sent_at on success. Without `force` it never sends twice.
// `to` overrides the roster email (approved verification requests use the request's address). Fire-and-forget: callers don't await.
export function mailGuest(db: DatabaseSync, guestId: number, opts: { to?: string; force?: boolean } = {}): Promise<MailResult> {
  const r = db.prepare('SELECT g.name, g.email, r.pin, r.ticket_token, r.email_sent_at FROM registration r JOIN guest g ON g.id = r.guest_id WHERE r.guest_id = ?')
    .get(guestId) as { name: string; email: string | null; pin: string; ticket_token: string; email_sent_at: number | null } | undefined;
  const to = opts.to || r?.email;
  if (!r || !to || (r.email_sent_at && !opts.force)) return Promise.resolve({ ok: false });
  const p = sendTicketEmail({ to, name: r.name, pin: r.pin, ticketToken: r.ticket_token }).then((res) => {
    if (res.ok) try { db.prepare('UPDATE registration SET email_sent_at = ? WHERE guest_id = ?').run(Date.now(), guestId); } catch {} // db closed (shutdown)
    return res;
  });
  inflight.add(p);
  p.finally(() => inflight.delete(p));
  return p;
}
