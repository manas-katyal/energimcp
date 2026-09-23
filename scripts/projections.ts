// Refreshes data/projections.json from the Danish Energy Agency's
// "Analyseforudsætninger til Energinet" (AF) dataset: the official projection
// of Danish energy demand, capacity and prices to 2050. Energi Data Service
// only looks backwards and a day ahead; this is the forward-looking half.
//
// The workbook is laid out for people, not machines: each sheet holds many
// small tables whose header row is a title followed by years, with the
// headings above a table giving its context ("Datacentre" above
// "Elkapacitet (MW, primo år)"). The heading level is only visible in the
// font (13pt bold, 11pt bold, 11pt bold italic), so that is what this reads.
//
//   npm run projections                 # download the current dataset
//   npm run projections -- ./af.xlsx    # or read a local copy
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";

const SOURCE_URL = "https://ens.dk/media/7633/download";
const SOURCE_PAGE = "https://ens.dk/analyser-og-statistik/analyseforudsaetninger-til-energinet";

// Sheets that are charts, a plant register, or re-cuts of other sheets.
const SKIP_SHEETS = new Set(["Introduktion", "Figurer", "Kraftværksoversigt", "VE-kapaciteter - Ultimo", "PtX-kapacitet - Ultimo"]);
// Chart re-cuts of data already in the sheet, and last year's edition kept
// for comparison: both would give a second, conflicting answer.
const SKIP_HEADINGS = /^(data til figurer|supplerende data til figurer)$|\(AF24\)/i;
const NOTE = /^(kilde|note|bemærk|\*)/i;

type Cell = string | number | null;
type Row = Cell[] & { style?: { size: number; bold: boolean; italic: boolean } };

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string") return typeof v === "string" ? v.trim() || null : v;
  if (typeof v === "object" && "result" in v) return cellValue(v.result as ExcelJS.CellValue);
  if (typeof v === "object" && "richText" in v) return v.richText.map((t) => t.text).join("").trim() || null;
  return String(v);
}

const isYear = (v: Cell) => typeof v === "number" && Number.isInteger(v) && v >= 2000 && v <= 2100;
const filled = (r: Row) => r.slice(1).filter((v) => v !== null);
/** A row with one text cell in column B and nothing else: a heading or a note. */
const loneText = (r: Row) => typeof r[1] === "string" && filled(r).length === 1;
/** 1 for a section (13pt bold), 2 for a subsection (11pt bold), 3 for bold italic; 0 for prose. */
function headingLevel(r: Row): number {
  const st = r.style;
  if (!st?.bold) return 0;
  if (st.size >= 13) return 1;
  return st.italic ? 3 : 2;
}
const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** The unit is the last parenthesis in the title ("… (MW, primo år)"), or failing that in a heading above it. Price areas are not units. */
function unitOf(title: string, context: string[]): { unit?: string } {
  for (const text of [title, ...context.toReversed()]) {
    const found = [...text.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!).filter((u) => !/^DK\d?$|^AF\d+$/.test(u.trim()));
    if (found.length) return { unit: found.at(-1)! };
  }
  return /kr\.|\/|wh\b/i.test(title) ? { unit: title } : {};
}

export interface ProjectionTable {
  id: string;
  topic: string;
  context: string[];
  description?: string[];
  title: string;
  unit?: string;
  years: number[];
  rows: { label: string; attributes?: Record<string, string | number>; values: (number | null)[] }[];
  notes?: string[];
}

function tablesIn(topic: string, sheet: Row[]): ProjectionTable[] {
  const out: ProjectionTable[] = [];
  let headings: { level: number; text: string }[] = [];
  let description: string[] = [];
  let afterTable = false;
  let skipping = false;

  for (let i = 0; i < sheet.length; i++) {
    const r = sheet[i]!;
    if (!filled(r).length) continue;

    if (loneText(r)) {
      const text = String(r[1]).trim();
      if ((r.style?.size ?? 0) >= 15) continue; // the sheet's own title
      const level = headingLevel(r);
      if (!level || NOTE.test(text)) {
        // Prose right under a table explains that table; prose under a
        // heading explains the tables that follow it.
        if (afterTable && out.length) {
          if (!skipping) (out.at(-1)!.notes ??= []).push(text);
        } else description.push(text);
        continue;
      }
      while (headings.length && headings.at(-1)!.level >= level) headings.pop();
      headings.push({ level, text });
      description = [];
      afterTable = false;
      skipping = headings.some((h) => SKIP_HEADINGS.test(h.text));
      continue;
    }

    const yearCols = r.map((v, j) => (isYear(v) ? j : -1)).filter((j) => j >= 0);
    if (yearCols.length < 3 || typeof r[1] !== "string") continue;

    const first = yearCols[0]!;
    const title = String(r[1]);
    const attrNames = r.slice(2, first).map((v) => (v === null ? null : String(v)));
    const years = yearCols.map((j) => r[j] as number);
    const rows: ProjectionTable["rows"] = [];
    let j = i + 1;
    for (; j < sheet.length; j++) {
      const row = sheet[j]!;
      if (!filled(row).length || typeof row[1] !== "string" || loneText(row)) break;
      const attributes: Record<string, string | number> = {};
      attrNames.forEach((name, k) => {
        const v = row[2 + k];
        if (name && v !== null && v !== undefined) attributes[name] = v;
      });
      rows.push({
        label: String(row[1]).trim(),
        ...(Object.keys(attributes).length ? { attributes } : {}),
        values: yearCols.map((c) => (typeof row[c] === "number" ? round(row[c] as number) : null)),
      });
    }
    i = j - 1;
    afterTable = true;
    if (skipping || !rows.length) continue;
    const context = headings.map((h) => h.text);
    // Some sheets repeat one title per price area and put the area in a
    // column ("Landmøller (MW, primo år)" × DK1, DK2, DK): name it.
    const areas = new Set(rows.map((r) => r.attributes?.["Område"]));
    const area = areas.size === 1 ? [...areas][0] : undefined;
    const fullTitle = area && !title.includes(String(area)) ? `${title}, ${area}` : title;
    out.push({ id: "", topic, context, ...(description.length ? { description: [...description] } : {}), title: fullTitle, ...unitOf(title, context), years, rows });
  }
  return out;
}

const input = process.argv[2];
const wb = new ExcelJS.Workbook();
if (input) {
  await wb.xlsx.readFile(input);
} else {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${SOURCE_URL}`);
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
}

// "Datasæt offentliggjort 01.07.2026" sits near the top of the introduction.
let published: string | undefined;
wb.getWorksheet("Introduktion")?.eachRow((row) => {
  row.eachCell((cell) => {
    const m = /offentliggjort\s+(\d{2})\.(\d{2})\.(\d{4})/i.exec(String(cellValue(cell.value) ?? ""));
    if (m && !published) published = `${m[3]}-${m[2]}-${m[1]}`;
  });
});

const tables: ProjectionTable[] = [];
wb.eachSheet((ws) => {
  if (SKIP_SHEETS.has(ws.name)) return;
  const sheet: Row[] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const cells: Row = [];
    for (let c = 1; c <= Math.min(ws.columnCount, 60); c++) cells.push(cellValue(row.getCell(c).value));
    const font = row.getCell(2).font ?? {};
    cells.style = { size: font.size ?? 11, bold: !!font.bold, italic: !!font.italic };
    sheet[n - 1] = cells;
  });
  for (let k = 0; k < sheet.length; k++) sheet[k] ??= [];
  tables.push(...tablesIn(ws.name, sheet));
});
tables.forEach((t, k) => (t.id = `af-${String(k + 1).padStart(3, "0")}`));

const snapshot = {
  source: {
    name: "Energistyrelsen, Analyseforudsætninger til Energinet (AF25), grundforløb",
    published,
    url: SOURCE_URL,
    page: SOURCE_PAGE,
    fetched: new Date().toISOString().slice(0, 10),
  },
  tables,
};
const path = join(import.meta.dirname, "..", "data", "projections.json");
writeFileSync(path, JSON.stringify(snapshot) + "\n");
console.log(`Wrote ${tables.length} tables across ${new Set(tables.map((t) => t.topic)).size} topics to ${path} (published ${published ?? "unknown"})`);
