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
/** named cell styles of the shared workbook stylesheet (D-169: one look for every Excel export) */
export type StyleName = "text" | "bold" | "title" | "sub" | "muted" | "head" | "money" | "moneyB" | "khr" | "khrB" | "date" | "qty" | "qtyB" | "int" | "intB" | "center" | "warn" | "section" | "hl" | "hlMoney" | "hlQty" | "hlDate"; // D-189: hl* = a yellow (flagged) row
export type XCell = Cell | { v: Cell; s?: StyleName; f?: string };
export type SheetSpec = { name: string; rows: XCell[][]; widths?: number[]; freeze?: number; autoFilter?: { row: number; cols: number }; merges?: string[]; landscape?: boolean };
const STYLES: StyleName[] = ["text", "bold", "title", "sub", "muted", "head", "money", "moneyB", "khr", "khrB", "date", "qty", "qtyB", "int", "intB", "center", "warn", "section", "hl", "hlMoney", "hlQty", "hlDate"];
const STYLE_XF: Record<StyleName, string> = {
  text: '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="top" wrapText="1"/></xf>',
  bold: '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="top" wrapText="1"/></xf>',
  title: '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
  sub: '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
  muted: '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
  head: '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>',
  money: '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
  moneyB: '<xf numFmtId="164" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>',
  khr: '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
  khrB: '<xf numFmtId="165" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>',
  date: '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center"/></xf>',
  qty: '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
  qtyB: '<xf numFmtId="167" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>',
  int: '<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>',
  intB: '<xf numFmtId="168" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>',
  center: '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf>',
  warn: '<xf numFmtId="0" fontId="5" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1"/>',
  section: '<xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>',
  hl: '<xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"><alignment vertical="top" wrapText="1"/></xf>',
  hlMoney: '<xf numFmtId="164" fontId="0" fillId="5" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/>',
  hlQty: '<xf numFmtId="167" fontId="0" fillId="5" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/>',
  hlDate: '<xf numFmtId="166" fontId="0" fillId="5" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf>',
};
const STYLE_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<numFmts count="5"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00;(&quot;$&quot;#,##0.00)"/><numFmt numFmtId="165" formatCode="&quot;៛&quot;#,##0;(&quot;៛&quot;#,##0)"/>`
  + `<numFmt numFmtId="166" formatCode="dd/mm/yyyy"/><numFmt numFmtId="167" formatCode="#,##0.###;(#,##0.###)"/><numFmt numFmtId="168" formatCode="#,##0;(#,##0)"/></numFmts>`
  + `<fonts count="6"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="16"/><name val="Calibri"/></font>`
  + `<font><b/><sz val="12"/><name val="Calibri"/></font><font><i/><sz val="9"/><color rgb="FF666666"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFB00020"/><name val="Calibri"/></font></fonts>`
  + `<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7EAF0"/><bgColor indexed="64"/></patternFill></fill>`
  + `<fill><patternFill patternType="solid"><fgColor rgb="FFFFF4D6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFDECEC"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>`
  + `<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border>`
  + `<border><left/><right/><top style="thin"/><bottom style="double"/><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${STYLES.length}">${STYLES.map((s) => STYLE_XF[s]).join("")}</cellXfs>`
  + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
/** an ISO day → Excel's serial day number (the date styles show it as dd/mm/yyyy) */
export const excelDay = (iso: string): number | null => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? Math.round((Date.parse(`${iso}T00:00:00Z`) - EXCEL_EPOCH) / 86_400_000) : null);
export const sheetName = (s: string) => (s.replace(/[\\/*?:[\]]/g, " ").trim() || "Sheet").slice(0, 31);

/** a workbook of one or more sheets with the shared styles; strings inline (Khmer round-trips), numbers as numbers, dates as serials */
export function writeWorkbook(sheets: SheetSpec[]): Buffer {
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const names = new Set<string>();
  const specs = sheets.map((s) => { let n = sheetName(s.name), k = 2; while (names.has(n.toLowerCase())) n = `${sheetName(s.name).slice(0, 28)} ${k++}`; names.add(n.toLowerCase()); return { ...s, name: n }; });
  const xml = (s: SheetSpec, idx: number) => {
    const cell = (x: XCell, r: number, c: number): string => {
      const o = x !== null && typeof x === "object" ? x : { v: x };
      const style = o.s ? STYLES.indexOf(o.s) : 0, sAttr = style > 0 ? ` s="${style}"` : "", ref = `${colName(c)}${r + 1}`;
      let v = o.v;
      if (o.s === "date" && typeof v === "string") { const d = excelDay(v); if (d !== null) v = d; }
      if (v === null || v === undefined || v === "") return o.f ? `<c r="${ref}"${sAttr}><f>${escXml(o.f)}</f></c>` : sAttr ? `<c r="${ref}"${sAttr}/>` : "";
      if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${sAttr}>${o.f ? `<f>${escXml(o.f)}</f>` : ""}<v>${v}</v></c>`;
      const text = String(v);
      return `<c r="${ref}" t="inlineStr"${sAttr}><is><t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ""}>${escXml(text)}</t></is></c>`;
    };
    const cols = s.widths?.length ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    const freeze = s.freeze ? `<pane ySplit="${s.freeze}" topLeftCell="A${s.freeze + 1}" activePane="bottomLeft" state="frozen"/>` : "";
    const filter = s.autoFilter ? `<autoFilter ref="A${s.autoFilter.row}:${colName(s.autoFilter.cols - 1)}${s.autoFilter.row}"/>` : "";
    const merges = s.merges?.length ? `<mergeCells count="${s.merges.length}">${s.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
    const body = s.rows.map((row, r) => { const cs = row.map((v, c) => cell(v, r, c)).join(""); return cs ? `<row r="${r + 1}">${cs}</row>` : ""; }).join("");
    return { name: `xl/worksheets/sheet${idx + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
      + `<sheetViews><sheetView workbookViewId="0"${idx === 0 ? ' tabSelected="1"' : ""}>${freeze}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${body}</sheetData>${filter}${merges}`
      + `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="${s.landscape ? "landscape" : "portrait"}" fitToWidth="1" fitToHeight="0"/></worksheet>` };
  };
  const sheetFiles = specs.map(xml);
  const definedNames = specs.map((s, i) => (s.autoFilter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${escXml(s.name).replace(/'/g, "''")}'!$A$${s.autoFilter.row}:$${colName(s.autoFilter.cols - 1)}$${s.autoFilter.row}</definedName>` : "")).join("");
  const files = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
      + specs.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") + `</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${rel}"><sheets>`
      + specs.map((s, i) => `<sheet name="${escXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + `</sheets>${definedNames ? `<definedNames>${definedNames}</definedNames>` : ""}</workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + specs.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") + `<Relationship Id="rId${specs.length + 1}" Type="${rel}/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: STYLE_SHEET },
    ...sheetFiles,
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, "utf8") })));
}
/** one sheet, a bold frozen header row — the catalog / customers templates (D-106, D-156) */
export function writeXlsx(name: string, rows: Cell[][], widths: number[] = []): Buffer {
  return writeWorkbook([{ name, widths, freeze: 1, rows: rows.map((row, r) => (r === 0 ? row.map((v) => ({ v, s: "bold" as const })) : row)) }]);
}

// ---------- reader ----------
const textOf = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescXml(m[1]!)).join("");
/** every sheet of a workbook: name + rows as strings (numbers as their text, empty cells ""); throws "BAD_FILE" */
export function readWorkbook(buf: Buffer, maxRows = 60_000): { name: string; rows: string[][] }[] {
  const files = unzip(buf);
  const wb = files.get("xl/workbook.xml")?.toString("utf8");
  if (!wb) throw new Error("BAD_FILE");
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const shared = [...(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  const sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({ name: unescXml(/\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? ""), rid: /\br:id="([^"]+)"/.exec(m[1]!)?.[1] }));
  if (!sheets.length) throw new Error("BAD_FILE");
  return sheets.map((sh, i) => {
    const target = sh.rid ? new RegExp(`<Relationship\\b[^>]*\\bId="${sh.rid}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${sh.rid}"`).exec(rels)?.[1] : undefined;
    const path = target ? (target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`) : `xl/worksheets/sheet${i + 1}.xml`;
    const sheet = (files.get(path) ?? files.get(`xl/worksheets/sheet${i + 1}.xml`))?.toString("utf8");
    if (!sheet) throw new Error("BAD_FILE");
    const rows: string[][] = [];
    for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      const attrs = rm[1] ?? rm[3] ?? "", body = rm[2] ?? "";
      const r = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? rows.length + 1) - 1;
      if (r >= maxRows) break;
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
        row[c] = t === "s" ? shared[Number(v)] ?? "" : t === "inlineStr" ? textOf(inner) : t === "b" ? (v === "1" ? "TRUE" : "FALSE") : v !== undefined ? unescXml(v) : "";
      }
      rows[r] = Array.from({ length: row.length }, (_x, i2) => row[i2] ?? "");
    }
    return { name: sh.name, rows: Array.from({ length: rows.length }, (_x, i2) => rows[i2] ?? []) };
  });
}
/** every row of the first sheet as strings (empty cells are ""); throws "BAD_FILE" */
export function readXlsx(buf: Buffer): string[][] {
  return readWorkbook(buf, 5001)[0]!.rows;
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
