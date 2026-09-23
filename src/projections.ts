// The forward-looking half. Energi Data Service holds what has happened and,
// at most, tomorrow; the Danish Energy Agency's "Analyseforudsætninger til
// Energinet" holds what Denmark is planning for, year by year to 2050. The
// workbook is converted by scripts/projections.ts and shipped as a snapshot,
// because it changes once a year and has no API.
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

export interface ProjectionSnapshot {
  source: { name: string; published?: string; url: string; page: string; fetched: string };
  tables: ProjectionTable[];
}

let snapshot: ProjectionSnapshot | undefined;

export function projections(): ProjectionSnapshot {
  snapshot ??= JSON.parse(readFileSync(join(import.meta.dirname, "..", "data", "projections.json"), "utf8")) as ProjectionSnapshot;
  return snapshot;
}

export function topics(): string[] {
  return [...new Set(projections().tables.map((t) => t.topic))];
}

/** Lowercase and strip accents, so "varmepumpe" finds "Varmepumper" and "ostdanmark" finds "Østdanmark". */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/å/g, "a")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function haystack(t: ProjectionTable): string {
  return fold([t.topic, ...t.context, t.title, ...(t.description ?? []), ...t.rows.map((r) => r.label)].join(" "));
}

/**
 * Everyday words, Danish and English, for what the dataset names formally.
 * Each maps to words that do appear in it; any one of them is a match.
 */
const ALIASES: Record<string, string[]> = {
  elbil: ["personbiler", "vejtransport"],
  elbiler: ["personbiler", "vejtransport"],
  ev: ["personbiler", "vejtransport"],
  evs: ["personbiler", "vejtransport"],
  havvind: ["havmoller"],
  landvind: ["landmoller"],
  vind: ["vindmoller", "havmoller", "landmoller"],
  wind: ["vindmoller", "havmoller", "landmoller"],
  offshore: ["havmoller"],
  onshore: ["landmoller"],
  solar: ["solceller"],
  sol: ["solceller"],
  heat: ["varmepumper"],
  pumps: ["varmepumper"],
  battery: ["batterier"],
  batteries: ["batterier"],
  storage: ["ellagring"],
  datacenter: ["datacentre"],
  datacentres: ["datacentre"],
  hydrogen: ["brintproduktion", "ptx"],
  brint: ["brintproduktion"],
  gas: ["gas", "naturgas"],
  demand: ["elforbrug"],
  consumption: ["elforbrug"],
  forbrug: ["elforbrug", "forbrug"],
  co2: ["co2"],
  capacity: ["kapacitet", "kapaciteter", "elkapacitet", "ydeevne"],
  kapacitet: ["kapacitet", "kapaciteter", "elkapacitet", "ydeevne"],
  production: ["produktion", "elproduktion"],
  price: ["pris", "priser", "kvotepris", "brandselspriser"],
  prices: ["pris", "priser", "kvotepris", "brandselspriser"],
};

/**
 * Tables where every word of the query appears somewhere in the table's topic,
 * headings, title or row labels. Words match as prefixes of a word in the
 * text, so "varmepumpe" finds "varmepumper" but "el" does not match "model".
 */
export function searchProjections(query?: string, topic?: string): ProjectionTable[] {
  const words = fold(query ?? "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);
  const padded = (text: string) => ` ${text.replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  const hits = (text: string, w: string) => [w, ...(ALIASES[w] ?? [])].some((alt) => text.includes(` ${alt}`));
  const scored = projections().tables.flatMap((t) => {
    if (topic && fold(t.topic) !== fold(topic)) return [];
    if (!words.length) return [{ t, score: 0 }];
    if (!words.every((w) => hits(padded(haystack(t)), w))) return [];
    // A word in the headings or title says what the table is about; a word
    // only in a row label ("… radial havvind" under Brintproduktion) is incidental.
    const heading = padded(fold([t.topic, ...t.context, t.title].join(" ")));
    // Tables with a unit hold quantities; the unitless ones are allocation keys.
    return [{ t, score: words.filter((w) => hits(heading, w)).length + (t.unit ? 0.5 : 0) }];
  });
  return scored.sort((a, b) => b.score - a.score).map((x) => x.t);
}

/** The years to show when none are asked for: the first year, then every fifth, then the last. */
export function defaultYears(years: number[]): number[] {
  if (years.length <= 7) return years;
  const first = years[0]!;
  const last = years.at(-1)!;
  return years.filter((y) => y === first || y === last || y % 5 === 0);
}

/** One table cut to the requested years, with its source spelled out so an answer can cite it. */
export function shapeTable(t: ProjectionTable, years?: number[]) {
  const wanted = (years?.length ? years : defaultYears(t.years)).filter((y) => t.years.includes(y));
  const index = wanted.map((y) => t.years.indexOf(y));
  const { source } = projections();
  return {
    id: t.id,
    table: [...t.context, t.title].join(" > "),
    ...(t.unit ? { unit: t.unit } : {}),
    ...(t.description ? { description: t.description.join(" ") } : {}),
    years: wanted,
    rows: t.rows.map((r) => ({
      label: r.label,
      ...(r.attributes ? r.attributes : {}),
      values: Object.fromEntries(index.map((k, n) => [wanted[n]!, r.values[k] ?? null])),
    })),
    ...(t.notes ? { notes: t.notes } : {}),
    source: `${source.name}, sheet "${t.topic}", table "${t.title}"${source.published ? `, published ${source.published}` : ""}`,
  };
}
