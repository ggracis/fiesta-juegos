import { crc32, inflateRawSync } from 'node:zlib';

// Zero-dependency .xlsx support: just enough to read a guest list and to write the example file.
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_UNZIPPED = 20 * 1024 * 1024; // zip-bomb guard per entry

function unzip(buf: Buffer): Map<string, () => Buffer> {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not_a_zip');
  const files = new Map<string, () => Buffer>();
  let p = buf.readUInt32LE(e + 16);
  for (let n = buf.readUInt16LE(e + 10); n > 0; n--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad_zip');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), off = buf.readUInt32LE(p + 42);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, () => {
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED });
      throw new Error('bad_zip');
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unesc = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (_m, g: string) =>
  g[0] === '#' ? String.fromCodePoint(g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : +g.slice(1)) : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as any)[g.toLowerCase()]);
const attr = (tag: string, name: string) => unesc(tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '');
const texts = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1])).join('');
const colIndex = (ref: string) => [...ref.match(/^[A-Z]+/i)![0].toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
// Excel stores DNIs as numbers (2.0123456E7): whole numbers become plain digits.
const num = (v: string) => { const n = Number(v); return v.trim() !== '' && Number.isFinite(n) && Number.isInteger(n) && Math.abs(n) < 1e21 ? n.toFixed(0) : v; };

// First worksheet as rows of strings by column (A=0...), empty cells kept positional.
export function readXlsx(buf: Buffer): string[][] {
  const files = unzip(buf);
  const read = (name: string) => files.get(name)?.().toString('utf8');
  const shared = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  let path = 'xl/worksheets/sheet1.xml';
  const rid = attr(read('xl/workbook.xml')?.match(/<sheet\b[^>]*>/)?.[0] ?? '', 'r:id');
  const rel = rid && [...(read('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => attr(t, 'Id') === rid);
  if (rel) { const t = attr(rel, 'Target'); path = t.startsWith('/') ? t.slice(1) : 'xl/' + t; }
  const sheet = read(path) ?? read('xl/worksheets/sheet1.xml');
  if (sheet === undefined) throw new Error('no_sheet');
  const rows = new Map<number, string[]>();
  for (const m of sheet.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = attr(m[1], 'r'), t = attr(m[1], 't'), body = m[2] ?? '';
    if (!/^[A-Z]+\d+$/i.test(ref)) continue;
    const v = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
    const val = t === 'inlineStr' ? texts(body) : v === undefined ? '' : t === 's' ? shared[+v] ?? '' : t === 'str' ? unesc(v) : t === '' || t === 'n' ? num(unesc(v)) : unesc(v);
    const r = +ref.match(/\d+/)![0], row = rows.get(r) ?? [];
    row[colIndex(ref)] = val.trim();
    rows.set(r, row);
  }
  return [...rows].sort((a, b) => a[0] - b[0]).map(([, row]) => Array.from(row, (c) => c ?? ''));
}

// Stored (method 0) zip: all the example file needs.
function zip(files: [string, string][]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const [name, text] of files) {
    const n = Buffer.from(name), d = Buffer.from(text), crc = crc32(d);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(33, 12); // date 1980-01-01
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(d.length, 18); l.writeUInt32LE(d.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    local.push(l, n, d); central.push(c, n);
    off += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, end]);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/';
const REL = NS + 'officeDocument/2006/relationships';
// Every cell is inlineStr, so Excel keeps the DNI as text.
export function exampleXlsx(rows: string[][]): Buffer {
  const sheet = XML + `<worksheet xmlns="${NS}spreadsheetml/2006/main"><cols><col min="1" max="1" width="32" customWidth="1"/><col min="2" max="2" width="16" customWidth="1"/><col min="3" max="3" width="32" customWidth="1"/></cols><sheetData>`
    + rows.map((r, i) => `<row r="${i + 1}">` + r.map((c, j) => `<c r="${'ABC'[j]}${i + 1}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`).join('') + '</row>').join('') + '</sheetData></worksheet>';
  return zip([
    ['[Content_Types].xml', XML + `<Types xmlns="${NS}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ['_rels/.rels', XML + `<Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', XML + `<workbook xmlns="${NS}spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="Invitados" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', XML + `<Relationships xmlns="${NS}package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}
