// Single source for the "add to calendar" links (Google + .ics) on the invitation and the ticket. Pure except the two URL helpers.
// The program below and the "Programa" list in src/index.html must be updated together; the final program is still pending from the client.
export const EVENT = {
  title: 'Gala Digital Power 2026 · Huawei',
  start: '20261130T213000Z', // 18:30 Buenos Aires (UTC-3)
  end: '20261201T030000Z', // 00:00
  location: 'Puerto Salguero, Av. Costanera Rafael Obligado 1221, CABA',
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

// extra: lines placed right after the intro (the ticket adds PIN, ticket URL and the QR reminder).
export const eventDetails = (extra = []) =>
  [EVENT.intro, ...extra, 'Programa:', ...PROGRAM.map(([t, l]) => `${t} ${l}`), `Dress code: ${EVENT.dress}`, `Invitación: ${invitationUrl()}`].join('\n');

export const googleCalUrl = (extra) =>
  'https://calendar.google.com/calendar/render?action=TEMPLATE'
  + `&text=${encodeURIComponent(EVENT.title)}&dates=${EVENT.start}/${EVENT.end}`
  + `&details=${encodeURIComponent(eventDetails(extra))}&location=${encodeURIComponent(EVENT.location)}`;

const icsText = (s) => s.replace(/[\;,]/g, '\$&').replace(/\n/g, '\n');
export const icsUrl = (extra) => 'data:text/calendar;charset=utf-8,' + encodeURIComponent([
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gala Digital Power 2026//ES', 'BEGIN:VEVENT',
  `UID:gala-digital-power-2026@${location.hostname}`, `DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}`,
  `DTSTART:${EVENT.start}`, `DTEND:${EVENT.end}`,
  `SUMMARY:${icsText(EVENT.title)}`, `LOCATION:${icsText(EVENT.location)}`, `DESCRIPTION:${icsText(eventDetails(extra))}`,
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n') + '\r\n');
