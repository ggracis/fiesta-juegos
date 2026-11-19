// Single source for the "add to calendar" links (Google + .ics) on the invitation and the ticket.
// The program below and the "Programa" list in src/index.html must be updated together; the final program is still pending from the client.
export const EVENT = {
  title: 'Gala Digital Power 2026 · Huawei',
  start: '20261130T213000Z', // 18:30 Buenos Aires (UTC-3)
  end: '20261201T030000Z', // 00:00
  tz: 'America/Argentina/Buenos_Aires',
  // Full postal form so Google Maps resolves the venue card, not just a text pin.
  location: 'Puerto Salguero, Av. Costanera Rafael Obligado 1221, C1425 Ciudad Autónoma de Buenos Aires, Argentina',
  venue: 'Puerto Salguero · Av. Costanera Rafael Obligado 1221, CABA',
  when: 'Lunes 30 de noviembre de 2026 · 18:30 a 00:00 h',
  intro: 'Te invitamos a ser parte de una noche especial, donde la innovación, las personas y las grandes conexiones nos impulsan hacia nuevos horizontes.',
  dress: 'A confirmar', // same text as DRESS CODE in src/index.html
};
export const PROGRAM = [
  ['18:30', 'Recepción y experiencias'],
  ['20:00', 'Últimas tecnologías Digital Power'],
  ['20:15', 'Menciones y reconocimientos'],
  ['20:30', 'Sorteo y premios'],
  ['20:45', 'Cena y networking'],
];

// Invitation page URL, honouring the Pages sub-path.
export const invitationUrl = () => new URL(import.meta.env.BASE_URL, location.origin).href;
const mapsUrl = () => 'https://maps.google.com/?q=' + encodeURIComponent(EVENT.location); // single param: no &amp; inside the HTML href

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ticket: { pin, url } on the ticket page (adds the personal block), undefined on the invitation.
// Returns { text, html }: Google Calendar renders the HTML (b, br, a, ul); .ics carries both (plain + X-ALT-DESC for Outlook).
export function eventDetails(ticket) {
  const inv = invitationUrl();
  const text = [
    EVENT.intro, '',
    ...(ticket ? ['🎟️ TU ENTRADA', `PIN para los juegos: ${ticket.pin}`, 'Presenta tu QR en la acreditación.', `Ver mi entrada (QR y PIN): ${ticket.url}`, ''] : []),
    `🕡 ${EVENT.when}`, `📍 ${EVENT.venue}`, `Cómo llegar: ${mapsUrl()}`, '',
    'PROGRAMA', ...PROGRAM.map(([t, l]) => `${t} · ${l}`), '',
    `Dress code: ${EVENT.dress}`,
    ...(ticket ? [] : [`Confirma tu asistencia y obtén tu entrada: ${inv}`]),
    `Invitación: ${inv}`,
  ].join('\n');
  const a = (href, label) => `<a href="${esc(href)}">${esc(label)}</a>`;
  const html = [
    `<i>${esc(EVENT.intro)}</i>`,
    ...(ticket ? [`<br><b>🎟️ TU ENTRADA</b><br>PIN para los juegos: <b>${esc(ticket.pin)}</b><br>Presenta tu QR en la acreditación.<br>${a(ticket.url, 'Ver mi entrada (QR y PIN)')}`] : []),
    `<br>🕡 <b>${esc(EVENT.when)}</b><br>📍 ${esc(EVENT.venue)} · ${a(mapsUrl(), 'Cómo llegar')}`,
    `<br><b>PROGRAMA</b><ul>${PROGRAM.map(([t, l]) => `<li><b>${t}</b> · ${esc(l)}</li>`).join('')}</ul>`,
    `<b>Dress code:</b> ${esc(EVENT.dress)}`,
    `<br>${ticket ? a(inv, 'Ver la invitación') : a(inv, 'Confirma tu asistencia y obtén tu entrada')}`,
  ].join('<br>');
  return { text, html };
}

export const googleCalUrl = (ticket) =>
  'https://calendar.google.com/calendar/render?action=TEMPLATE'
  + `&text=${encodeURIComponent(EVENT.title)}&dates=${EVENT.start}/${EVENT.end}&ctz=${encodeURIComponent(EVENT.tz)}`
  + `&details=${encodeURIComponent(eventDetails(ticket).html)}&location=${encodeURIComponent(EVENT.location)}`;

// RFC 5545: escape \ ; , and newlines; fold lines at 75 octets (continuation lines start with a space).
const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/[;,]/g, '\\$&').replace(/\r?\n/g, '\\n');
const fold = (line) => {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
};
export function icsUrl(ticket) {
  const d = eventDetails(ticket);
  const alarm = (trigger, text) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:${trigger}`, `DESCRIPTION:${icsText(text)}`, 'END:VALARM'];
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gala Digital Power 2026//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:gala-digital-power-2026@${location.hostname}`, `DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}`,
    `DTSTART:${EVENT.start}`, `DTEND:${EVENT.end}`, 'STATUS:CONFIRMED', 'TRANSP:OPAQUE',
    `SUMMARY:${icsText(EVENT.title)}`, `LOCATION:${icsText(EVENT.location)}`, `URL:${ticket ? ticket.url : invitationUrl()}`,
    `DESCRIPTION:${icsText(d.text)}`, `X-ALT-DESC;FMTTYPE=text/html:${icsText(`<html><body>${d.html}</body></html>`)}`,
    ...alarm('-P1D', 'Mañana: Gala Digital Power 2026'), ...alarm('-PT2H', 'Hoy 18:30: Gala Digital Power 2026'),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(lines.map(fold).join('\r\n') + '\r\n');
}
