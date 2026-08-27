import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";

export const MAX_WEB_PDF_PAGES = 50;

export class PdfParseError extends Error {
  constructor() {
    super("pdf parse failed");
  }
}

const require = createRequire(import.meta.url);

type MupdfModule = {
  Document: {
    openDocument(data: Buffer, type: string): MupdfDocument;
  };
};

interface MupdfDocument {
  needsPassword(): boolean;
  countPages(): number;
  loadPage(index: number): MupdfPage;
  destroy(): void;
}

interface MupdfPage {
  toStructuredText(options?: string): MupdfStructuredText;
  getBounds(): [number, number, number, number];
  getLinks(): { getBounds(): [number, number, number, number]; getURI(): string }[];
  destroy(): void;
}

interface MupdfStructuredText {
  asText(): string;
  asJSON(): string;
  destroy(): void;
}

let mupdfModule: MupdfModule | null | undefined;

async function loadMupdf(): Promise<MupdfModule | null> {
  if (mupdfModule !== undefined) return mupdfModule;
  try {
    mupdfModule = (await import(require.resolve("mupdf"))) as unknown as MupdfModule;
  } catch {
    try {
      mupdfModule = (await import("mupdf")) as unknown as MupdfModule;
    } catch {
      mupdfModule = null;
    }
  }
  return mupdfModule;
}

interface JsonLine {
  bbox?: { x?: number; y?: number; w?: number; h?: number };
  font?: { family?: string; weight?: string; style?: string; size?: number };
  text?: string;
}

interface JsonBlock {
  type?: string;
  lines?: JsonLine[];
}

interface SpanData {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
  text: string;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  block: number;
}

interface MergedLine {
  lrect: { x0: number; y0: number; x1: number; y1: number };
  spans: SpanData[];
}

interface LinkInfo {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  uri: string;
}

interface TableBand {
  markdown: string;
  firstLineIndex: number;
}

interface HeaderInfo {
  bodyLimit: number;
  headerId: Map<number, string>;
}

const BULLETS = new Set([
  0x2a, 0x2d, 0x3e, 0x6f, 0xb6, 0xb7, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014,
  0x2015, 0x2020, 0x2021, 0x2022, 0x2212, 0x2219, 0xf0a7, 0xf0b7, 0xfffd,
  ...Array.from({ length: 0x2600 - 0x25a0 }, (_, i) => i + 0x25a0),
]);

const WHITE_CHARS = new Set([
  ...Array.from({ length: 33 }, (_, i) => i),
  0xa0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x202f, 0x205f, 0x3000,
]);

function isWhite(text: string): boolean {
  return [...text].every((c) => WHITE_CHARS.has(c.codePointAt(0)!));
}

function startswithBullet(text: string): boolean {
  if (!text) return false;
  const code = text.codePointAt(0)!;
  if (!BULLETS.has(code)) return false;
  if (text.length === 1) return true;
  return text[1] === " ";
}

const SHAPED_PRESENTATION_FORMS = /[\uFB1D-\uFDFF\uFE70-\uFEFC]/g;
const PDF_FALLBACK_MIN_BAD_GLYPHS = 5;
const PDF_FALLBACK_BAD_GLYPH_RATIO = 0.0005;
const PDF_INCOMPLETE_RATIO = 0.75;
const PDF_INCOMPLETE_MIN_LETTERS = 200;

function markdownCorrupted(text: string): boolean {
  if (!text) return false;
  const threshold = Math.max(PDF_FALLBACK_MIN_BAD_GLYPHS, PDF_FALLBACK_BAD_GLYPH_RATIO * text.length);
  const shaped = (text.match(SHAPED_PRESENTATION_FORMS) ?? []).length;
  return shaped > threshold || (text.match(/\ufffd/g) ?? []).length > threshold;
}

function countLetters(text: string): number {
  return [...text].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
}

function markdownIncomplete(markdown: string, plainLetters: number): boolean {
  if (plainLetters < PDF_INCOMPLETE_MIN_LETTERS) return false;
  const markdownLetters = countLetters(markdown);
  return markdownLetters < PDF_INCOMPLETE_RATIO * plainLetters;
}

function identifyHeaders(pageLines: MergedLine[][]): HeaderInfo {
  const fontSizes = new Map<number, number>();
  for (const lines of pageLines) {
    for (const line of lines) {
      for (const span of line.spans) {
        if (isWhite(span.text)) continue;
        const size = Math.round(span.size);
        fontSizes.set(size, (fontSizes.get(size) ?? 0) + span.text.trim().length);
      }
    }
  }
  const sorted = [...fontSizes.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const bodyLimit = sorted.length ? Math.max(12, sorted[sorted.length - 1][0]) : 12;
  const sizes = sorted
    .map(([size]) => size)
    .filter((size) => size > bodyLimit)
    .sort((a, b) => b - a)
    .slice(0, 6);
  const headerId = new Map<number, string>();
  sizes.forEach((size, i) => headerId.set(size, "#".repeat(i + 1) + " "));
  const finalBody = headerId.size ? Math.min(...headerId.keys()) - 1 : bodyLimit;
  return { bodyLimit: finalBody, headerId };
}

function getHeaderId(span: SpanData, info: HeaderInfo): string {
  const size = Math.round(span.size);
  if (size <= info.bodyLimit) return "";
  return info.headerId.get(size) ?? "";
}

function maxHeaderId(spans: SpanData[], info: HeaderInfo): string {
  const levels = [
    ...new Set(spans.map((s) => getHeaderId(s, info).length).filter((len) => len > 0)),
  ].sort((a, b) => a - b);
  if (!levels.length) return "";
  return "#".repeat(levels[0] - 1) + " ";
}

function sanitizeLine(spans: SpanData[]): SpanData[] {
  const line = [...spans].sort((a, b) => a.x0 - b.x0);
  for (let i = line.length - 1; i > 0; i--) {
    const s0 = line[i - 1];
    const s1 = line[i];
    const delta = s1.size * 0.1;
    const sameStyle = s0.bold === s1.bold && s0.italic === s1.italic && s0.mono === s1.mono;
    if (s0.x1 + delta < s1.x0 || !sameStyle) continue;
    if (s0.text !== s1.text) s0.text += s1.text;
    s0.x0 = Math.min(s0.x0, s1.x0);
    s0.y0 = Math.min(s0.y0, s1.y0);
    s0.x1 = Math.max(s0.x1, s1.x1);
    s0.y1 = Math.max(s0.y1, s1.y1);
    line.splice(i, 1);
  }
  return line;
}

function getRawLines(json: JsonBlock[]): MergedLine[] {
  const spans: SpanData[] = [];
  for (let bno = 0; bno < json.length; bno++) {
    const block = json[bno];
    if (block.type !== "text") continue;
    for (const line of block.lines ?? []) {
      const bbox = line.bbox ?? {};
      const font = line.font ?? {};
      const text = line.text ?? "";
      if (isWhite(text)) continue;
      const span: SpanData = {
        x0: bbox.x ?? 0,
        y0: bbox.y ?? 0,
        x1: (bbox.x ?? 0) + (bbox.w ?? 0),
        y1: (bbox.y ?? 0) + (bbox.h ?? 0),
        size: font.size ?? 0,
        text,
        bold: font.weight === "bold",
        italic: font.style === "italic",
        mono: font.family === "monospace",
        block: bno,
      };
      if (span.x1 <= span.x0 || span.y1 <= span.y0) continue;
      spans.push(span);
    }
  }
  if (!spans.length) return [];
  spans.sort((a, b) => a.y1 - b.y1);
  const nlines: MergedLine[] = [];
  let line: SpanData[] = [spans[0]];
  let lrect = {
    x0: spans[0].x0,
    y0: spans[0].y0,
    x1: spans[0].x1,
    y1: spans[0].y1,
  };
  for (const s of spans.slice(1)) {
    const last = line[line.length - 1];
    if (Math.abs(s.y1 - last.y1) <= 3 || Math.abs(s.y0 - last.y0) <= 3) {
      line.push(s);
      lrect = {
        x0: Math.min(lrect.x0, s.x0),
        y0: Math.min(lrect.y0, s.y0),
        x1: Math.max(lrect.x1, s.x1),
        y1: Math.max(lrect.y1, s.y1),
      };
      continue;
    }
    nlines.push({ lrect, spans: sanitizeLine(line) });
    line = [s];
    lrect = { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 };
  }
  nlines.push({ lrect, spans: sanitizeLine(line) });
  return nlines;
}

const RUNNING_EDGE_FRACTION = 0.12;
const RUNNING_MIN_PAGES = 2;
const RUNNING_MIN_FRACTION = 0.5;
const RUNNING_POSITION_TOLERANCE = 5;
const PAGE_NUMBER_RE = /^\d{1,4}$/;

function lineText(line: MergedLine): string {
  return line.spans.map((s) => s.text).join(" ").trim();
}

function lineAtEdge(line: MergedLine, pageHeight: number): boolean {
  return (
    line.lrect.y0 < pageHeight * RUNNING_EDGE_FRACTION ||
    line.lrect.y1 > pageHeight * (1 - RUNNING_EDGE_FRACTION)
  );
}

function linePositionKey(y0: number): number {
  return Math.round(y0 / RUNNING_POSITION_TOLERANCE);
}

function countRunningLines(
  pages: PageData[],
  heights: number[],
): { textCounts: Map<string, number>; numericPositionCounts: Map<number, number> } {
  const textCounts = new Map<string, number>();
  const numericPositionCounts = new Map<number, number>();
  for (let i = 0; i < pages.length; i++) {
    const height = heights[i];
    const seenTexts = new Set<string>();
    const seenPositions = new Set<number>();
    for (const line of pages[i].lines) {
      if (!lineAtEdge(line, height)) continue;
      const text = lineText(line);
      if (!text) continue;
      const position = linePositionKey(line.lrect.y0);
      const key = `${text}@${position}`;
      if (!seenTexts.has(key)) {
        seenTexts.add(key);
        textCounts.set(key, (textCounts.get(key) ?? 0) + 1);
      }
      if (!seenPositions.has(position)) {
        seenPositions.add(position);
        if (PAGE_NUMBER_RE.test(text)) {
          numericPositionCounts.set(position, (numericPositionCounts.get(position) ?? 0) + 1);
        }
      }
    }
  }
  return { textCounts, numericPositionCounts };
}

function stripRunningLines(pages: PageData[], heights: number[]): number[] {
  const { textCounts, numericPositionCounts } = countRunningLines(pages, heights);
  const threshold = Math.max(RUNNING_MIN_PAGES, Math.ceil(pages.length * RUNNING_MIN_FRACTION));
  const removedLetters: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    const height = heights[i];
    let removed = 0;
    pages[i].lines = pages[i].lines.filter((line) => {
      if (!lineAtEdge(line, height)) return true;
      const text = lineText(line);
      if (!text) return true;
      const position = linePositionKey(line.lrect.y0);
      const repeated = (textCounts.get(`${text}@${position}`) ?? 0) >= threshold;
      const pageNumber =
        PAGE_NUMBER_RE.test(text) && (numericPositionCounts.get(position) ?? 0) >= threshold;
      if (repeated || pageNumber) {
        removed += countLetters(text);
        return false;
      }
      return true;
    });
    removedLetters.push(removed);
  }
  return removedLetters;
}

function findLink(links: LinkInfo[], span: SpanData): string | null {
  const midX = (span.x0 + span.x1) / 2;
  const midY = (span.y0 + span.y1) / 2;
  for (const link of links) {
    if (midX < link.x0 || midX > link.x1 || midY < link.y0 || midY > link.y1) continue;
    let uri = link.uri;
    for (const c of "()\n") {
      uri = uri.replaceAll(c, "%0x" + c.charCodeAt(0).toString(16));
    }
    return `[${span.text.trim()}](${uri})`;
  }
  return null;
}

function cellText(spans: SpanData[]): string {
  return spans
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0)
    .join(" ");
}

function detectTableBands(lines: MergedLine[]): TableBand[] {
  const bands: TableBand[] = [];
  let band: MergedLine[] = [];
  const flush = () => {
    if (band.length >= 2) {
      const x0s = band.flatMap((l) => l.spans.map((s) => s.x0)).sort((a, b) => a - b);
      const columns: number[] = [];
      for (const x of x0s) {
        const existing = columns.find((c) => Math.abs(c - x) <= 5);
        if (existing === undefined) columns.push(x);
      }
      if (columns.length >= 2) {
        columns.sort((a, b) => a - b);
        const rows: string[][] = [];
        for (const line of band) {
          const cells = columns.map(() => [] as SpanData[]);
          for (const span of line.spans) {
            let best = 0;
            let bestDist = Infinity;
            columns.forEach((col, i) => {
              const dist = Math.abs(span.x0 - col);
              if (dist < bestDist) {
                bestDist = dist;
                best = i;
              }
            });
            cells[best].push(span);
          }
          rows.push(cells.map(cellText));
        }
        const occupied = rows.map((r) => r.filter((c) => c.length > 0).length);
        if (!occupied.some((n) => n < 2)) {
          const header = rows[0].map((name, i) =>
            name ? name.replaceAll("\n", "<br>") : `Col${i + 1}`,
          );
          let output = "|" + header.join("|") + "|\n";
          output += "|" + columns.map(() => "---").join("|") + "|\n";
          for (const row of rows.slice(1)) {
            output += "|" + row.join("|") + "|\n";
          }
          bands.push({ markdown: output + "\n", firstLineIndex: Math.min(...band.map((l) => lines.indexOf(l))) });
        }
      }
    }
    band = [];
  };
  for (const line of lines) {
    const starts = new Set(line.spans.map((s) => Math.round(s.x0 / 5) * 5));
    if (starts.size >= 2 && line.spans.length >= 2) {
      band.push(line);
    } else {
      flush();
    }
  }
  flush();
  return bands;
}

function writeText(
  lines: MergedLine[],
  info: HeaderInfo,
  links: LinkInfo[],
  tableBands: TableBand[],
): string {
  let out = "";
  let prevLrect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let prevBno = -1;
  let code = false;
  let prevHdr: string | null = null;
  let emittedBands = 0;
  for (let li = 0; li < lines.length; li++) {
    while (emittedBands < tableBands.length && tableBands[emittedBands].firstLineIndex <= li) {
      out += "\n" + tableBands[emittedBands].markdown;
      emittedBands++;
    }
    const { lrect, spans } = lines[li];
    const height = lrect.y1 - lrect.y0;
    if (prevLrect && lrect.y1 - prevLrect.y1 > height * 1.5) out += "\n";
    let text = spans.map((s) => s.text).join(" ").trim();
    const allItalic = spans.every((s) => s.italic);
    const allBold = spans.every((s) => s.bold);
    const allMono = spans.every((s) => s.mono);
    const hdrString = maxHeaderId(spans, info);
    if (hdrString) {
      if (allMono) text = "`" + text + "`";
      if (allItalic) text = "_" + text + "_";
      if (allBold) text = "**" + text + "**";
      if (hdrString !== prevHdr) {
        out += hdrString + text + "\n";
      } else {
        while (out.endsWith("\n")) out = out.slice(0, -1);
        out += " " + text + "\n";
      }
      prevHdr = hdrString;
      prevLrect = lrect;
      continue;
    }
    prevHdr = hdrString;
    if (allMono) {
      if (!code) {
        out += "```\n";
        code = true;
      }
      const delta = Math.floor(lrect.x0 / (spans[0].size * 0.5));
      out += " ".repeat(Math.max(0, delta)) + text + "\n";
      prevLrect = lrect;
      continue;
    }
    if (code && !allMono) {
      out += "```\n";
      code = false;
    }
    const bno = spans[0].block;
    if (bno !== prevBno) {
      out += "\n";
      prevBno = bno;
    }
    if (
      prevLrect &&
      (lrect.y1 - prevLrect.y1 > height * 1.5 ||
        spans[0].text.startsWith("[") ||
        startswithBullet(spans[0].text))
    ) {
      out += "\n";
    }
    prevLrect = lrect;
    if (code) {
      out += "```\n";
      code = false;
    }
    for (const span of spans) {
      let prefix = "";
      let suffix = "";
      if (span.bold) {
        prefix += "**";
        suffix += "**";
      }
      if (span.italic) {
        prefix += "_";
        suffix += "_";
      }
      if (span.mono) {
        prefix += "`";
        suffix += "`";
      }
      let part = findLink(links, span) ?? span.text.trim();
      part = prefix + part + suffix + " ";
      if (startswithBullet(part)) {
        part = "- " + part.slice(1);
        part = part.replace(/ {2}/g, " ");
        const cwidth =
          span.x1 - span.x0 > 0 ? (span.x1 - span.x0) / span.text.length : span.size * 0.5;
        part = " ".repeat(Math.round(span.x0 / cwidth)) + part;
      }
      out += part;
    }
    out += "\n";
  }
  out += "\n";
  if (code) out += "```\n";
  out += "\n\n";
  return out;
}

function renderPageMarkdown(lines: MergedLine[], info: HeaderInfo, links: LinkInfo[]): string {
  const bands = detectTableBands(lines);
  return writeText(lines, info, links, bands);
}

interface PageData {
  lines: MergedLine[];
  plain: string;
  links: LinkInfo[];
}

export async function extractPdfPages(
  data: Buffer,
): Promise<{ pages: { text: string; pageNumber: number }[]; totalPages: number }> {
  const mupdf = await loadMupdf();
  if (!mupdf) throw new PdfParseError();
  let doc: MupdfDocument | null = null;
  try {
    doc = mupdf.Document.openDocument(data, "application/pdf");
  } catch {
    throw new PdfParseError();
  }
  try {
    if (doc.needsPassword()) throw new PdfParseError();
    const total = doc.countPages();
    const count = Math.min(total, MAX_WEB_PDF_PAGES);
    const pages: PageData[] = [];
    const heights: number[] = [];
    for (let i = 0; i < count; i++) {
      const page = doc.loadPage(i);
      const bounds = page.getBounds();
      heights.push(bounds[3] - bounds[1]);
      let st: MupdfStructuredText | null = null;
      try {
        st = page.toStructuredText("");
        const plain = st.asText() ?? "";
        let json: { blocks?: JsonBlock[] } = { blocks: [] };
        try {
          json = JSON.parse(st.asJSON());
        } catch {
          json = { blocks: [] };
        }
        const lines = getRawLines(json.blocks ?? []);
        const links = page.getLinks().map((link) => {
          const [x0, y0, x1, y1] = link.getBounds();
          return { x0, y0, x1, y1, uri: link.getURI() };
        });
        pages.push({ lines, plain, links });
      } finally {
        if (st) st.destroy();
        page.destroy();
      }
    }
    const removedLetters = stripRunningLines(pages, heights);
    const info = identifyHeaders(pages.map((p) => p.lines));
    const extracted = pages.map((p, i) => {
      const markdown = renderPageMarkdown(p.lines, info, p.links);
      const plainLetters = Math.max(0, countLetters(p.plain) - removedLetters[i]);
      const text = markdownCorrupted(markdown) || markdownIncomplete(markdown, plainLetters) ? p.plain : markdown;
      return { text, pageNumber: i + 1 };
    });
    return { pages: extracted, totalPages: total };
  } finally {
    doc.destroy();
  }
}

function assemblePages(
  pages: { text: string; pageNumber: number }[],
  pageLimitOverride?: boolean,
): string {
  const parts: string[] = [];
  const pageLimitReached = pageLimitOverride ?? pages.length > MAX_WEB_PDF_PAGES;
  for (const page of pages) {
    const pageText = page.text.trim();
    if (!pageText) continue;
    parts.push((parts.length ? "\n\n" : "") + `## Page ${page.pageNumber}\n\n${pageText}`);
  }
  let text = parts.join("").trimEnd();
  if (!text) {
    if (pageLimitReached) {
      return `(PDF contains no extractable text in the first ${MAX_WEB_PDF_PAGES} pages)`;
    }
    return "";
  }
  if (pageLimitReached) {
    text += `\n\n... (PDF extraction is capped at ${MAX_WEB_PDF_PAGES} pages)`;
  }
  return text;
}

export async function extractPdfText(data: Buffer): Promise<string> {
  const mupdf = await loadMupdf();
  if (!mupdf) return extractPdfTextFallback(data);
  const { pages, totalPages } = await extractPdfPages(data);
  return assemblePages(pages, totalPages > MAX_WEB_PDF_PAGES);
}

function extractTextOps(bytes: Buffer): string {
  const text = bytes.toString("latin1");
  const out: string[] = [];
  let inText = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "%") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "(") {
      let depth = 1;
      let j = i + 1;
      let raw = "";
      while (j < n && depth) {
        const ch = text[j];
        if (ch === "\\") {
          raw += ch + (text[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (depth) raw += ch;
        j++;
      }
      if (inText) out.push(decodePdfString(raw));
      i = j;
      continue;
    }
    if (c === "[") {
      const parts: string[] = [];
      let depth = 1;
      let j = i + 1;
      while (j < n && depth) {
        const ch = text[j];
        if (ch === "(") {
          let k = j + 1;
          let inner = "";
          let innerDepth = 1;
          while (k < n && innerDepth) {
            const ic = text[k];
            if (ic === "\\") {
              inner += ic + (text[k + 1] ?? "");
              k += 2;
              continue;
            }
            if (ic === "(") innerDepth++;
            if (ic === ")") innerDepth--;
            if (innerDepth) inner += ic;
            k++;
          }
          parts.push(decodePdfString(inner));
          j = k;
          continue;
        }
        if (ch === "]") depth--;
        if (ch === "[") depth++;
        j++;
      }
      if (inText) out.push(parts.join(""));
      i = j;
      continue;
    }
    if (c === "<") {
      const close = text.indexOf(">", i + 1);
      if (close !== -1) {
        const hex = text.slice(i + 1, close).replace(/\s+/g, "");
        if (/^[0-9a-fA-F]*$/.test(hex) && hex.length % 2 === 0) {
          if (inText) out.push(Buffer.from(hex, "hex").toString("latin1"));
          i = close + 1;
          continue;
        }
      }
    }
    if (c === "'" || c === '"') {
      if (inText) out.push("\n");
      i++;
      continue;
    }
    const token = text.slice(i, i + 2);
    if (token === "BT") {
      inText = true;
      i += 2;
      continue;
    }
    if (token === "ET") {
      inText = false;
      i += 2;
      continue;
    }
    if (token === "Td" || token === "TD" || token === "Tm" || token === "T*") {
      if (inText) out.push("\n");
      i += 2;
      continue;
    }
    i++;
  }
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodePdfString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      const n = raw[i + 1];
      if (n === "n") {
        out += "\n";
        i++;
      } else if (n === "r") {
        out += "\r";
        i++;
      } else if (n === "t") {
        out += "\t";
        i++;
      } else if (n === "b") {
        out += "\b";
        i++;
      } else if (n === "f") {
        out += "\f";
        i++;
      } else if (n === "(" || n === ")" || n === "\\") {
        out += n;
        i++;
      } else if (n >= "0" && n <= "7") {
        let octal = n;
        i++;
        let count = 1;
        while (count < 3 && i + 1 < raw.length && raw[i + 1] >= "0" && raw[i + 1] <= "7") {
          octal += raw[i + 1];
          i++;
          count++;
        }
        out += String.fromCharCode(parseInt(octal, 8));
      } else if (n === "\n" || n === "\r") {
        i++;
        if (raw[i + 1] === "\n") i++;
      } else if (n !== undefined) {
        out += n;
        i++;
      }
    } else {
      out += c;
    }
  }
  return out;
}

async function extractPdfTextFallback(data: Buffer): Promise<string> {
  const text = data.toString("latin1");
  if (/\/Encrypt\b/.test(text)) throw new PdfParseError();
  const streams: Buffer[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(text)) !== null) {
    const start = match.index;
    const dictStart = Math.max(0, text.lastIndexOf("<<", start));
    const dictText = text.slice(dictStart, start);
    const isFlate = /\/Filter\s*\/FlateDecode|\/FlateDecode/.test(dictText);
    const raw = Buffer.from(match[1], "latin1");
    let bytes = raw;
    if (isFlate) {
      try {
        bytes = inflateSync(raw);
      } catch {
        continue;
      }
    }
    streams.push(bytes);
  }
  if (!streams.length) throw new PdfParseError();
  const totalPages = streams.length;
  const pages = streams.slice(0, MAX_WEB_PDF_PAGES).map((stream, i) => ({
    text: extractTextOps(stream),
    pageNumber: i + 1,
  }));
  return assemblePages(pages, totalPages > MAX_WEB_PDF_PAGES);
}
