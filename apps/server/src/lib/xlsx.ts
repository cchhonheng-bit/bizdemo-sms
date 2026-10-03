// A small Excel (.xlsx) writer + reader for the catalog import (D-106) — no dependency: an .xlsx file is a ZIP of XML parts.
// Writer: one sheet, inline strings, a bold frozen header row. Reader: the first sheet of any normal workbook (shared strings,
// inline strings, numbers, booleans), with size limits against zip bombs. CSV (UTF-8, comma / semicolon / tab) is read too.
import { deflateRawSync, inflateRawSync } from "node:zlib";

// ---------- zip ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), body = deflateRawSync(f.data), crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); // 1980-01-01 00:00
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body); centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** the files of a zip; throws "BAD_FILE" for anything that is not a sane zip (too many entries, too large when unpacked) */
export function unzip(buf: Buffer, maxTotal = 20_000_000): Map<string, Buffer> {
  const bad = () => new Error("BAD_FILE");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad();
  const count = buf.readUInt16LE(eocd + 10), cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > 500 || cdOffset >= buf.length) throw bad();
  const out = new Map<string, Buffer>();
  let p = cdOffset, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad();
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + elen + clen;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad();
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw bad();
    total += usize;
    if (total > maxTotal) throw bad();
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    try { data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, maxTotal) }) : Buffer.alloc(0); }
    catch { throw bad(); }
    out.set(name.replace(/^\/+/, ""), data);
  }
  return out;
}

// ---------- xml ----------
const XML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escXml = (s: string) => s.replace(/[&<>"]/g, (c) => XML_ESC[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
export function unescXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&"; if (k === "lt") return "<"; if (k === "gt") return ">"; if (k === "quot") return '"'; if (k === "apos") return "'";
    const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
  });
}
const colName = (i: number) => { let s = "", n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const colIndex = (ref: string) => { const letters = /^[A-Z]+/i.exec(ref)?.[0]?.toUpperCase() ?? "A"; let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

// ---------- writer ----------
export type Cell = string | number | null | undefined;
export function writeXlsx(sheetName: string, rows: Cell[][], widths: number[] = []): Buffer {
  const cell = (v: Cell, r: number, c: number) => {
    if (v === null || v === undefined || v === "") return "";
    const ref = `${colName(c)}${r + 1}`, s = r === 0 ? ' s="1"' : "";
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    const text = String(v);
    return `<c r="${ref}" t="inlineStr"${s}><is><t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ""}>${escXml(text)}</t></is></c>`;
  };
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}`
    + `<sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, r, c)).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${rel}"><sheets><sheet name="${escXml(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, "utf8") })));
}

// ---------- reader ----------
const textOf = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescXml(m[1]!)).join("");
/** every row of the first sheet as strings (empty cells are ""); throws "BAD_FILE" */
export function readXlsx(buf: Buffer): string[][] {
  const files = unzip(buf);
  const wb = files.get("xl/workbook.xml")?.toString("utf8");
  if (!wb) throw new Error("BAD_FILE");
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const target = rid ? new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${rid}"`).exec(rels)?.[1] : undefined;
  const path = target ? (target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`) : "xl/worksheets/sheet1.xml";
  const sheet = (files.get(path) ?? files.get("xl/worksheets/sheet1.xml"))?.toString("utf8");
  if (!sheet) throw new Error("BAD_FILE");
  const shared = [...(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attrs = rm[1] ?? rm[3] ?? "", body = rm[2] ?? "";
    const r = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? rows.length + 1) - 1;
    if (r > 5000) break;
    const row: string[] = [];
    let next = 0;
    for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1] ?? "", inner = cm[2] ?? "";
      const ref = /\br="([A-Z]+)\d*"/i.exec(a)?.[1];
      const c = ref ? colIndex(ref) : next;
      next = c + 1;
      if (c > 50) continue;
      const t = /\bt="([^"]+)"/.exec(a)?.[1] ?? "n";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const value = t === "s" ? shared[Number(v)] ?? "" : t === "inlineStr" ? textOf(inner) : t === "b" ? (v === "1" ? "TRUE" : "FALSE") : v !== undefined ? unescXml(v) : "";
      row[c] = value;
    }
    rows[r] = Array.from({ length: row.length }, (_x, i) => row[i] ?? "");
  }
  return Array.from({ length: rows.length }, (_x, i) => rows[i] ?? []);
}

/** a CSV file (UTF-8, optional BOM; the separator is guessed from the first line) */
export function readCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const first = s.split(/\r?\n/, 1)[0] ?? "";
  const sep = [",", ";", "\t"].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; if (rows.length > 5000) break; }
    else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/** an uploaded spreadsheet: .xlsx (zip) or CSV text */
export function readSheet(buf: Buffer): string[][] {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return readXlsx(buf);
  const text = buf.toString("utf8");
  if (text.includes("\u0000")) throw new Error("BAD_FILE");
  return readCsv(text);
}
