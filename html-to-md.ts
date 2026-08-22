import { NAMED_ENTITIES, INVALID_CHARREFS, INVALID_CODEPOINTS } from "./entities.ts";

const SKIP_TAGS = new Set([
  "script",
  "style",
  "head",
  "noscript",
  "svg",
  "math",
  "nav",
  "footer",
  "template",
  "dialog",
  "button",
  "select",
  "datalist",
]);

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const P_CLOSING_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

const IMPLICIT_CLOSERS: Record<string, Set<string>> = {
  p: P_CLOSING_TAGS,
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  tr: new Set(["tr"]),
  td: new Set(["td", "th", "tr"]),
  th: new Set(["td", "th", "tr"]),
  option: new Set(["option", "optgroup"]),
  optgroup: new Set(["optgroup"]),
};

const CLOSE_BARRIERS: Record<string, Set<string>> = {
  li: new Set(["ul", "ol", "menu"]),
  dt: new Set(["dl"]),
  dd: new Set(["dl"]),
  tr: new Set(["table"]),
  td: new Set(["table"]),
  th: new Set(["table"]),
  option: new Set(["select", "datalist"]),
  optgroup: new Set(["select", "datalist"]),
};

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "aside",
  "figure",
  "figcaption",
  "details",
  "summary",
  "dl",
  "dt",
  "dd",
]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const INLINE_EMPHASIS: Record<string, string> = { strong: "**", b: "**", em: "*", i: "*" };

const HEADER_LINK_DENSITY = 0.93;
const HEADER_MIN_CHARS = 150;
const HEADER_MAX_RENDERED_CHARS = 800;
const MAX_HEADER_NESTING = 8;

const MIN_MAIN_CONTENT_CHARS = 200;

export type AttrDict = Record<string, string | null>;

export function styleHidesElement(style: string): boolean {
  const lowered = style.toLowerCase();
  if (!lowered.includes("none") && !lowered.includes("hidden")) return false;
  for (const declaration of style.split(";")) {
    const sep = declaration.indexOf(":");
    if (sep === -1) continue;
    const prop = declaration.slice(0, sep).trim().toLowerCase();
    const value = declaration.slice(sep + 1).split("!", 1)[0].trim().toLowerCase();
    if (prop === "display" && value === "none") return true;
    if (prop === "visibility" && value === "hidden") return true;
  }
  return false;
}

export function isHiddenElement(attrs: AttrDict): boolean {
  if ("hidden" in attrs) return true;
  if ((attrs["aria-hidden"] ?? "").trim().toLowerCase() === "true") return true;
  return styleHidesElement(attrs["style"] ?? "");
}

export function isAriaHeading(attrs: AttrDict): boolean {
  return (attrs["role"] ?? "").toLowerCase().split(/\s+/).includes("heading");
}

class HeaderFrame {
  depth: number;
  parts: string[] = [];
  headingParts: string[] = [];
  stripped = false;
  renderedChars = 0;
  headingChars = 0;
  outerListDepth: number;
  outerLinkSeq: number;
  outerCellSeq: number;
  outerInPre: boolean;
  outerInCode: number;
  outerBqDepth: number;
  textChars = 0;
  linkChars = 0;

  constructor(
    depth: number,
    linkSeq: number,
    cellSeq: number,
    inPre: boolean,
    inCode: number,
    bqDepth: number,
    listDepth: number,
  ) {
    this.depth = depth;
    this.outerListDepth = listDepth;
    this.outerLinkSeq = linkSeq;
    this.outerCellSeq = cellSeq;
    this.outerInPre = inPre;
    this.outerInCode = inCode;
    this.outerBqDepth = bqDepth;
  }

  render(closedByOwnTag: boolean): string {
    this.stripped = false;
    if (!closedByOwnTag) return this.parts.join("");
    const headings = this.headingParts.join("");
    const droppable = this.renderedChars - this.headingChars;
    const bigEnough =
      this.textChars >= HEADER_MIN_CHARS || droppable >= HEADER_MAX_RENDERED_CHARS;
    if (bigEnough && this.linkChars >= HEADER_LINK_DENSITY * this.textChars) {
      this.stripped = true;
      return headings.trim() ? headings + "\n\n" : headings;
    }
    return this.parts.join("");
  }
}


const CHARREF_RE = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

export function decodeHtmlEntities(text: string): string {
  return text.replace(CHARREF_RE, (whole, s: string) => {
    if (s[0] === "#") {
      const hex = s[1] === "x" || s[1] === "X";
      const num = parseInt(s.slice(2).replace(/;+$/, ""), hex ? 16 : 10);
      const mapped = INVALID_CHARREFS[num];
      if (mapped !== undefined) return mapped;
      if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "\ufffd";
      if (INVALID_CODEPOINTS.has(num)) return "";
      return String.fromCodePoint(num);
    }
    const known = NAMED_ENTITIES[s];
    if (known !== undefined) return known;
    for (let x = s.length - 1; x > 1; x--) {
      const prefix = s.slice(0, x);
      if (prefix in NAMED_ENTITIES) return NAMED_ENTITIES[prefix] + s.slice(x);
    }
    return "&" + s;
  });
}


interface HtmlHandlers {
  handleStartTag(name: string, attrs: AttrDict): void;
  handleEndTag(name: string): void;
  handleStartEndTag(name: string, attrs: AttrDict): void;
  handleData(text: string): void;
  handleEntityRef(name: string): void;
  handleCharRef(name: string): void;
}

const START_TAG_NAME_RE = /^[a-zA-Z][^\s/>]*/;
const ATTR_NAME_RE = /^[^\s=/>]+/;

function parseAttrsUntilClose(input: string, pos: number): [AttrDict, number, boolean] {
  const attrs: AttrDict = {};
  while (pos < input.length) {
    while (pos < input.length && /\s/.test(input[pos])) pos++;
    if (pos >= input.length) return [attrs, -1, false];
    if (input[pos] === ">") return [attrs, pos + 1, false];
    if (input[pos] === "/") {
      if (pos + 1 < input.length && input[pos + 1] === ">") return [attrs, pos + 2, true];
      pos++;
      continue;
    }
    const nameMatch = ATTR_NAME_RE.exec(input.slice(pos));
    if (!nameMatch) return [attrs, -1, false];
    const name = nameMatch[0].toLowerCase();
    pos += nameMatch[0].length;
    while (pos < input.length && /\s/.test(input[pos])) pos++;
    let value: string | null = null;
    if (pos < input.length && input[pos] === "=") {
      pos++;
      while (pos < input.length && /\s/.test(input[pos])) pos++;
      if (pos < input.length && (input[pos] === '"' || input[pos] === "'")) {
        const quote = input[pos];
        pos++;
        const valueStart = pos;
        while (pos < input.length && input[pos] !== quote) pos++;
        value = decodeHtmlEntities(input.slice(valueStart, pos));
        pos++;
      } else {
        const valueStart = pos;
        while (pos < input.length && !/[\s>]/.test(input[pos])) pos++;
        value = decodeHtmlEntities(input.slice(valueStart, pos));
      }
    }
    attrs[name] = value;
  }
  return [attrs, -1, false];
}

function scanTag(
  html: string,
  i: number,
): { end: number; kind: "comment" | "decl" | "end" | "start" | "startend"; name?: string; attrs?: AttrDict } | null {
  const rest = html.slice(i + 1);
  if (rest.startsWith("!--")) {
    const close = html.indexOf("-->", i + 4);
    if (close === -1) return null;
    return { end: close + 3, kind: "decl" };
  }
  if (rest.startsWith("!") || rest.startsWith("?")) {
    let j = i + 2;
    while (j < html.length && html[j] !== ">") j++;
    if (j >= html.length) return null;
    return { end: j + 1, kind: "decl" };
  }
  if (rest.startsWith("/")) {
    let j = i + 2;
    while (j < html.length && /[\s>]/.test(html[j]) === false) j++;
    const name = html.slice(i + 2, j).toLowerCase();
    if (!name) return null;
    while (j < html.length && html[j] !== ">") j++;
    if (j >= html.length) return null;
    return { end: j + 1, kind: "end", name };
  }
  const nameMatch = START_TAG_NAME_RE.exec(rest);
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  const [attrs, next, selfClosing] = parseAttrsUntilClose(html, i + 1 + nameMatch[0].length);
  if (next === -1) return null;
  return { end: next, kind: selfClosing ? "startend" : "start", name, attrs };
}


export function feedHtml(input: string, handlers: HtmlHandlers): void {
  const emitText = (text: string) => {
    if (!text) return;
    let pos = 0;
    while (pos < text.length) {
      const amp = text.indexOf("&", pos);
      if (amp === -1) {
        handlers.handleData(text.slice(pos));
        return;
      }
      if (amp > pos) handlers.handleData(text.slice(pos, amp));
      const named = /^&([A-Za-z][A-Za-z0-9.-]*);/.exec(text.slice(amp));
      if (named) {
        handlers.handleEntityRef(named[1]);
        pos = amp + named[0].length;
        continue;
      }
      const numeric = /^&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));/.exec(text.slice(amp));
      if (numeric) {
        handlers.handleCharRef(numeric[1] ?? numeric[2]);
        pos = amp + numeric[0].length;
        continue;
      }
      const legacy = /^&([A-Za-z][A-Za-z0-9.-]*)(?=[^A-Za-z0-9]|$)/.exec(text.slice(amp));
      if (legacy) {
        handlers.handleEntityRef(legacy[1]);
        pos = amp + legacy[0].length;
        continue;
      }
      handlers.handleData("&");
      pos = amp + 1;
    }
  };

  let i = 0;
  let textStart = 0;
  while (i < input.length) {
    if (input[i] !== "<") {
      i++;
      continue;
    }
    const tag = scanTag(input, i);
    if (!tag) {
      i++;
      continue;
    }
    emitText(input.slice(textStart, i));
    if (tag.kind === "start") handlers.handleStartTag(tag.name!, tag.attrs!);
    else if (tag.kind === "startend") handlers.handleStartEndTag(tag.name!, tag.attrs!);
    else if (tag.kind === "end") handlers.handleEndTag(tag.name!);
    textStart = tag.end;
    i = tag.end;
  }
  emitText(input.slice(textStart));
}

class MarkdownRenderer {
  out: string[] = [];
  private skipDepth = 0;
  private scopeTags: Set<string> | null;
  private scopeDepth = 0;
  scopeSegments: string[] = [];
  private scopeSegStart: number | null = null;
  private openTags: string[] = [];
  private closableOpen = 0;
  private hiddenMarks: number[] = [];
  private stripHeader: boolean;
  private headerStack: HeaderFrame[] = [];
  private droppedChars = 0;
  private segDroppedStart = 0;
  scopeDropped: number[] = [];
  private segHeadingTexts: string[] = [];
  scopeHeadingProse: number[] = [];
  private headingMarks: number[] = [];
  private linkHref: string | null = null;
  private linkTextParts: string[] = [];
  private inLink = false;
  private linkSeq = 0;
  private linkHadHeading = false;
  private linkHeadingParts: string[] = [];
  private emitAsHeading = false;
  private replaying = false;
  private linkHeaderChars = 0;
  private listStack: string[] = [];
  private olCounter: number[] = [];
  private inTable = false;
  private currentRow: string[] = [];
  private cellParts: string[] = [];
  private inCell = false;
  private cellSeq = 0;
  private headerRowDone = false;
  private rowHasTh = false;
  private isFirstRow = false;
  private inPre = false;
  private preParts: string[] = [];
  private inlineCodeDepth = 0;
  private bqStack: string[][] = [];

  constructor(scopeTags: Set<string> | null = null, stripHeader = false) {
    this.scopeTags = scopeTags;
    this.stripHeader = stripHeader;
  }

  private nestedBufferOpen(frame: HeaderFrame): boolean {
    if (this.inLink) return this.linkSeq !== frame.outerLinkSeq;
    if (this.inCell) return this.cellSeq !== frame.outerCellSeq;
    if (this.inPre) return !frame.outerInPre;
    return this.bqStack.length > frame.outerBqDepth;
  }

  private emit(text: string): void {
    const frame = this.headerStack.length ? this.headerStack[this.headerStack.length - 1] : null;
    const inNestedLink = frame
      ? this.inLink && this.linkSeq !== frame.outerLinkSeq
      : false;
    const asHeading =
      (this.headingMarks.length > 0 && !inNestedLink && !this.replaying) || this.emitAsHeading;
    if (frame && asHeading) {
      frame.headingParts.push(text);
      frame.headingChars += text.trim().length;
    }
    if (!this.replaying && ((this.headingMarks.length > 0 && !this.inLink) || this.emitAsHeading)) {
      this.segHeadingTexts.push(text);
    }
    const nestedOpen = frame ? this.nestedBufferOpen(frame) : false;
    if (frame && !nestedOpen) {
      frame.renderedChars += text.trim().length;
      frame.parts.push(text);
      return;
    }
    if (this.inLink) {
      this.linkTextParts.push(text);
      if (this.headingMarks.length > 0) this.linkHeadingParts.push(text);
    } else if (this.inCell) {
      this.cellParts.push(text);
    } else if (this.inPre) {
      this.preParts.push(text);
    } else if (this.bqStack.length) {
      this.bqStack[this.bqStack.length - 1].push(text);
    } else {
      this.out.push(text);
    }
  }

  private segHeadingProse(): number {
    return visibleChars(this.segHeadingTexts.join(""));
  }

  private drainPre(): void {
    const raw = this.preParts.join("");
    this.inPre = false;
    this.preParts = [];
    const fence = fenceFor(raw);
    this.emitReplay(`\n\n${fence}\n${raw}\n${fence}\n\n`);
  }

  private drainBlockquote(): void {
    const content = this.bqStack.pop() ?? [];
    const prefixed = prefixBlockquote(content.join(""));
    if (prefixed) this.emitReplay("\n\n" + prefixed + "\n\n");
  }

  private emitReplay(text: string): void {
    const was = this.replaying;
    this.replaying = true;
    try {
      this.emit(text);
    } finally {
      this.replaying = was;
    }
  }

  private finishCell(): void {
    if (!this.inCell) return;
    this.inCell = false;
    let cellText = this.cellParts.join("").trim().replace(/\n/g, " ");
    cellText = cellText.replace(/\|/g, "\\|");
    this.currentRow.push(cellText);
    this.cellParts = [];
  }

  private finishRow(): void {
    if (!this.currentRow.length) return;
    const line = "| " + this.currentRow.join(" | ") + " |";
    this.emitReplay(line + "\n");
    if (!this.headerRowDone && (this.rowHasTh || this.isFirstRow)) {
      const sep = "| " + this.currentRow.map(() => "---").join(" | ") + " |";
      this.emit(sep + "\n");
      this.headerRowDone = true;
    }
    this.isFirstRow = false;
    this.currentRow = [];
    this.rowHasTh = false;
  }

  private finishLink(): void {
    const text = this.linkTextParts.join("").replace(/\s+/g, " ").trim();
    const headingText = this.linkHeadingParts.join("").replace(/\s+/g, " ").trim();
    const href = this.linkHref ?? "";
    this.inLink = false;
    this.linkTextParts = [];
    this.linkHeadingParts = [];
    const partial = Boolean(headingText) && headingText !== text;
    this.emitAsHeading = this.linkHadHeading && !partial;
    this.linkHadHeading = false;
    this.linkHeaderChars = 0;
    if (href && text) {
      this.emit(`[${text}](${href})`);
    } else if (text) {
      this.emit(text);
    }
    this.emitAsHeading = false;
    if (partial && this.headerStack.length) {
      const frame = this.headerStack[this.headerStack.length - 1];
      frame.headingParts.push(headingText + "\n\n");
      frame.headingChars += headingText.length;
      this.segHeadingTexts.push(headingText);
    }
  }

  private truncateOpenTags(index: number): void {
    for (const name of this.openTags.slice(index)) {
      if (name in IMPLICIT_CLOSERS) this.closableOpen--;
    }
    this.openTags.length = index;
  }

  private closeImplicit(tag: string): void {
    if (!this.closableOpen) return;
    const barriers = CLOSE_BARRIERS[tag] ?? new Set<string>();
    while (true) {
      let closeAt: number | null = null;
      for (let i = this.openTags.length - 1; i >= 0; i--) {
        const name = this.openTags[i];
        const closers = IMPLICIT_CLOSERS[name];
        if (closers && closers.has(tag)) {
          closeAt = i;
          break;
        }
        if (barriers.has(name)) break;
      }
      if (closeAt === null) break;
      this.truncateOpenTags(closeAt);
      while (this.hiddenMarks.length && this.hiddenMarks[this.hiddenMarks.length - 1] >= closeAt) {
        this.hiddenMarks.pop();
      }
      while (this.headingMarks.length && this.headingMarks[this.headingMarks.length - 1] >= closeAt) {
        this.headingMarks.pop();
      }
      this.closeHeaderFrames(closeAt);
    }
  }

  private closeHeaderFrames(depth: number, ownTag = false): void {
    let closedByOwnTag = ownTag;
    while (this.headerStack.length && this.headerStack[this.headerStack.length - 1].depth >= depth) {
      this.finalizeNestedBuffers(this.headerStack[this.headerStack.length - 1]);
      const frame = this.headerStack.pop()!;
      if (this.headerStack.length) {
        const outer = this.headerStack[this.headerStack.length - 1];
        outer.textChars += frame.textChars;
        outer.linkChars += frame.linkChars;
        outer.headingParts.push(...frame.headingParts);
        outer.headingChars += frame.headingChars;
      }
      const out = frame.render(closedByOwnTag);
      if (frame.stripped) {
        this.droppedChars += Math.max(0, frame.renderedChars - frame.headingChars);
      }
      this.emit(out);
      closedByOwnTag = false;
    }
  }

  private finalizeNestedBuffers(frame: HeaderFrame): void {
    if (this.inLink && this.linkSeq !== frame.outerLinkSeq) {
      frame.linkChars += this.linkHeaderChars;
      this.finishLink();
    }
    while (this.inlineCodeDepth > frame.outerInCode) {
      this.inlineCodeDepth--;
      this.emit("`");
    }
    if (this.inPre && !frame.outerInPre) this.drainPre();
    if (this.inCell && this.cellSeq !== frame.outerCellSeq) {
      this.finishCell();
      this.finishRow();
    }
    while (this.bqStack.length > frame.outerBqDepth) this.drainBlockquote();
    while (this.listStack.length > frame.outerListDepth) {
      if (this.listStack.pop() === "ol" && this.olCounter.length) this.olCounter.pop();
    }
  }

  private flushHeaderFrames(): void {
    while (this.headerStack.length) {
      this.finalizeNestedBuffers(this.headerStack[this.headerStack.length - 1]);
      this.emit(this.headerStack.pop()!.parts.join(""));
    }
  }

  private countHeaderText(text: string): void {
    if (!this.headerStack.length || this.headingMarks.length) return;
    const frame = this.headerStack[this.headerStack.length - 1];
    const chars = text.trim().length;
    frame.textChars += chars;
    if (!(this.inLink && this.linkHref)) return;
    if (this.linkSeq === frame.outerLinkSeq) frame.linkChars += chars;
    else this.linkHeaderChars += chars;
  }

  private enterTag(tag: string, attrs: AttrDict): boolean {
    if (!VOID_TAGS.has(tag)) {
      this.openTags.push(tag);
      if (tag in IMPLICIT_CLOSERS) this.closableOpen++;
      if (isHiddenElement(attrs)) this.hiddenMarks.push(this.openTags.length - 1);
      if (HEADING_TAGS.has(tag) || tag === "hgroup" || isAriaHeading(attrs)) {
        this.headingMarks.push(this.openTags.length - 1);
        if (this.inLink) this.linkHadHeading = true;
      }
      if (
        this.stripHeader &&
        tag === "header" &&
        !this.hiddenMarks.length &&
        this.headerStack.length < MAX_HEADER_NESTING
      ) {
        this.headerStack.push(
          new HeaderFrame(
            this.openTags.length - 1,
            this.inLink ? this.linkSeq : -1,
            this.inCell ? this.cellSeq : -1,
            this.inPre,
            this.inlineCodeDepth,
            this.bqStack.length,
            this.listStack.length,
          ),
        );
      }
    } else if (isHiddenElement(attrs)) {
      return false;
    }
    if (this.scopeTags && this.scopeTags.has(tag)) {
      this.flushHeaderFrames();
      if (this.scopeDepth === 0) {
        this.scopeSegStart = this.out.length;
        this.segDroppedStart = this.droppedChars;
        this.segHeadingTexts = [];
      }
      this.scopeDepth++;
    }
    if (this.hiddenMarks.length) return false;
    if (this.scopeTags && this.scopeDepth === 0) return false;
    return true;
  }

  private exitTag(tag: string): boolean {
    if (this.inLink && this.scopeTags && this.scopeTags.has(tag)) this.finishLink();
    const suppressed =
      this.hiddenMarks.length > 0 || (this.scopeTags !== null && this.scopeDepth === 0);
    if (this.inLink && tag === "a" && this.headingMarks.length) this.finishLink();
    if (!VOID_TAGS.has(tag)) {
      for (let i = this.openTags.length - 1; i >= 0; i--) {
        if (this.openTags[i] === tag) {
          this.truncateOpenTags(i);
          while (this.hiddenMarks.length && this.hiddenMarks[this.hiddenMarks.length - 1] >= i) {
            this.hiddenMarks.pop();
          }
          while (this.headingMarks.length && this.headingMarks[this.headingMarks.length - 1] >= i) {
            this.headingMarks.pop();
          }
          this.closeHeaderFrames(i, tag === "header");
          break;
        }
      }
    }
    if (this.scopeTags && this.scopeTags.has(tag) && this.scopeDepth > 0) {
      this.scopeDepth--;
      if (this.scopeDepth === 0 && this.scopeSegStart !== null) {
        this.scopeSegments.push(this.out.slice(this.scopeSegStart).join(""));
        this.scopeDropped.push(this.droppedChars - this.segDroppedStart);
        this.scopeHeadingProse.push(this.segHeadingProse());
        this.scopeSegStart = null;
      }
    }
    return !suppressed;
  }

  handleStartEndTag(_name: string, _attrs: AttrDict): void {}
  handleStartTag(tag: string, attrs: AttrDict): void {
    if (this.skipDepth) {
      if (SKIP_TAGS.has(tag)) this.skipDepth++;
      return;
    }
    this.closeImplicit(tag);
    if (SKIP_TAGS.has(tag)) {
      this.skipDepth++;
      return;
    }
    if (!this.enterTag(tag, attrs)) return;
    if (HEADING_TAGS.has(tag)) {
      const level = Number(tag[1]);
      this.emit("\n\n" + "#".repeat(level) + " ");
    } else if (tag === "a") {
      this.linkHref = attrs["href"];
      this.linkTextParts = [];
      this.linkHeadingParts = [];
      this.inLink = true;
      this.linkSeq++;
      this.linkHeaderChars = 0;
    } else if (tag in INLINE_EMPHASIS) {
      this.emit(INLINE_EMPHASIS[tag]);
    } else if (tag === "br") {
      this.emit("\n");
    } else if (BLOCK_TAGS.has(tag)) {
      this.emit("\n\n");
    } else if (tag === "hr") {
      this.emit("\n\n---\n\n");
    } else if (tag === "blockquote") {
      this.emit("\n\n");
      this.bqStack.push([]);
    } else if (tag === "ul") {
      this.listStack.push("ul");
      this.emit("\n");
    } else if (tag === "ol") {
      this.listStack.push("ol");
      const startAttr = attrs["start"];
      let start = 1;
      if (startAttr !== null && startAttr !== undefined && startAttr.trim()) {
        const parsed = Number(startAttr);
        if (Number.isInteger(parsed)) start = parsed;
      }
      this.olCounter.push(start - 1);
      this.emit("\n");
    } else if (tag === "li") {
      const indent = "  ".repeat(Math.max(0, this.listStack.length - 1));
      if (this.listStack.length && this.listStack[this.listStack.length - 1] === "ol") {
        if (this.olCounter.length) {
          this.olCounter[this.olCounter.length - 1]++;
          this.emit(`\n${indent}${this.olCounter[this.olCounter.length - 1]}. `);
        } else {
          this.emit(`\n${indent}1. `);
        }
      } else {
        this.emit(`\n${indent}* `);
      }
    } else if (tag === "pre") {
      this.preParts = [];
      this.inPre = true;
    } else if (tag === "code" && !this.inPre) {
      this.inlineCodeDepth++;
      this.emit("`");
    } else if (tag === "table") {
      this.inTable = true;
      this.headerRowDone = false;
      this.isFirstRow = true;
      this.emit("\n\n");
    } else if (tag === "tr") {
      this.finishCell();
      this.finishRow();
    } else if (tag === "th" || tag === "td") {
      this.finishCell();
      this.cellParts = [];
      this.inCell = true;
      this.cellSeq++;
      if (tag === "th") this.rowHasTh = true;
    }
  }

  handleEndTag(tag: string): void {
    if (SKIP_TAGS.has(tag)) {
      this.skipDepth = Math.max(0, this.skipDepth - 1);
      return;
    }
    if (this.skipDepth) return;
    if (!this.exitTag(tag)) return;
    if (HEADING_TAGS.has(tag)) {
      this.emit("\n\n");
    } else if (tag === "a") {
      if (this.headerStack.length) {
        this.headerStack[this.headerStack.length - 1].linkChars += this.linkHeaderChars;
      }
      this.finishLink();
    } else if (tag in INLINE_EMPHASIS) {
      this.emit(INLINE_EMPHASIS[tag]);
    } else if (BLOCK_TAGS.has(tag)) {
      this.emit("\n\n");
    } else if (tag === "blockquote") {
      if (this.bqStack.length) this.drainBlockquote();
    } else if (tag === "ul") {
      if (this.listStack.length && this.listStack[this.listStack.length - 1] === "ul") {
        this.listStack.pop();
      }
      this.emit("\n");
    } else if (tag === "ol") {
      if (this.listStack.length && this.listStack[this.listStack.length - 1] === "ol") {
        this.listStack.pop();
        if (this.olCounter.length) this.olCounter.pop();
      }
      this.emit("\n");
    } else if (tag === "pre" && this.inPre) {
      this.drainPre();
    } else if (tag === "code" && !this.inPre && this.inlineCodeDepth) {
      this.inlineCodeDepth--;
      this.emit("`");
    } else if (tag === "th" || tag === "td") {
      this.finishCell();
    } else if (tag === "tr") {
      this.finishCell();
      this.finishRow();
    } else if (tag === "table") {
      this.finishCell();
      this.finishRow();
      this.inTable = false;
      this.emit("\n");
    }
  }

  private textSuppressed(): boolean {
    if (this.skipDepth || this.hiddenMarks.length) return true;
    return this.scopeTags !== null && this.scopeDepth === 0;
  }

  handleData(data: string): void {
    if (this.textSuppressed()) return;
    if (this.inPre) {
      this.countHeaderText(data);
      this.preParts.push(data);
      return;
    }
    if (this.inlineCodeDepth) {
      this.countHeaderText(data);
      this.emit(data);
      return;
    }
    const text = data.replace(/\s+/g, " ");
    this.countHeaderText(text);
    if (this.inTable && !this.inCell && !text.trim()) return;
    this.emit(text);
  }

  handleEntityRef(name: string): void {
    if (this.textSuppressed()) return;
    const text = decodeHtmlEntities(`&${name};`);
    this.countHeaderText(text);
    this.emit(text);
  }

  handleCharRef(name: string): void {
    if (this.textSuppressed()) return;
    const text = decodeHtmlEntities(`&#${name};`);
    this.countHeaderText(text);
    this.emit(text);
  }

  flushPending(): void {
    this.flushHeaderFrames();
    if (this.inLink) this.finishLink();
    while (this.inlineCodeDepth) {
      this.inlineCodeDepth--;
      this.emit("`");
    }
    this.finishCell();
    this.finishRow();
    if (this.inPre) this.drainPre();
    while (this.bqStack.length) {
      const content = this.bqStack.pop()!.join("");
      const prefixed = prefixBlockquote(content);
      if (!prefixed) continue;
      if (this.bqStack.length) {
        this.bqStack[this.bqStack.length - 1].push("\n\n" + prefixed + "\n\n");
      } else {
        this.out.push("\n\n" + prefixed + "\n\n");
      }
    }
    if (this.scopeSegStart !== null) {
      this.scopeSegments.push(this.out.slice(this.scopeSegStart).join(""));
      this.scopeDropped.push(this.droppedChars - this.segDroppedStart);
      this.scopeHeadingProse.push(this.segHeadingProse());
      this.scopeSegStart = null;
      this.scopeDepth = 0;
    }
  }
}

function prefixBlockquote(content: string): string {
  content = content.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!content) return "";
  return content
    .split("\n")
    .map((line) => (line.trim() ? "> " + line : ">"))
    .join("\n");
}

function cleanup(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence = 0;
  let blankRun = 0;
  for (const line of lines) {
    const stripped = line.replace(/[ \t]+$/, "");
    const moved = fenceState(stripped, fence);
    if (moved !== fence) {
      fence = moved;
      blankRun = 0;
      out.push(stripped);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    if (!stripped) {
      blankRun++;
      if (blankRun <= 1) out.push("");
      continue;
    }
    blankRun = 0;
    out.push(stripped);
  }
  return out.join("\n").trim();
}

const BOILERPLATE_FRAGMENTS = [
  "skip to content",
  "skip to main content",
  "there was an error while loading",
  "please reload this page",
  "you can't perform that action at this time",
  "you signed in with another tab or window",
  "you signed out in another tab or window",
  "you switched accounts on another tab or window",
  "reload to refresh your session",
  "you must be signed in to change notification settings",
  "uh oh!",
  "{{ message }}",
  "this website uses cookies",
  "we use cookies",
  "accept all cookies",
  "manage cookie preferences",
];

const BOILERPLATE_MAX_LINE_CHARS = 300;

const BOILERPLATE_NORMALIZED = new Set(
  BOILERPLATE_FRAGMENTS.map((fragment) =>
    fragment.replace(/\s+/g, " ").trim().toLowerCase().replace(/[.!:]+$/, ""),
  ),
);

function lineIsBoilerplate(line: string): boolean {
  const normalized = line.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  const segments = normalized
    .split(/[.!]/)
    .map((segment) => segment.trim().replace(/[.!:]+$/, ""))
    .filter((segment) => segment.length > 0);
  return segments.length > 0 && segments.every((segment) => BOILERPLATE_NORMALIZED.has(segment));
}

function fenceState(line: string, fence: number): number {
  const stripped = line.trim();
  if (stripped.length < 3 || stripped.replace(/`/g, "").length !== 0) return fence;
  if (!fence) return stripped.length;
  return stripped.length >= fence ? 0 : fence;
}

function stripBoilerplateLines(text: string): string {
  const out: string[] = [];
  let fence = 0;
  for (const line of text.split("\n")) {
    const moved = fenceState(line, fence);
    if (moved !== fence) {
      fence = moved;
      out.push(line);
      continue;
    }
    if (!fence && line.length <= BOILERPLATE_MAX_LINE_CHARS && lineIsBoilerplate(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function newRenderer(
  sourceHtml: string,
  scopeTags: Set<string> | null,
  stripHeader: boolean,
): MarkdownRenderer {
  const renderer = new MarkdownRenderer(scopeTags, stripHeader);
  feedHtml(sourceHtml, renderer);
  renderer.flushPending();
  return renderer;
}

function render(sourceHtml: string, scopeTags: Set<string> | null, stripHeader = false): string {
  return cleanup(newRenderer(sourceHtml, scopeTags, stripHeader).out.join(""));
}

function selectMainScopeRender(sourceHtml: string, tag: string): [number, string] {
  const renderer = newRenderer(sourceHtml, new Set([tag]), true);
  const dropped = renderer.scopeDropped;
  const headingProse = renderer.scopeHeadingProse;
  let bestLen = 0;
  let bestRender = "";
  for (let i = 0; i < renderer.scopeSegments.length; i++) {
    const rendered = stripBoilerplateLines(cleanup(renderer.scopeSegments[i]));
    const prose = visibleChars(rendered) - headingProse[i];
    if (prose < MIN_MAIN_CONTENT_CHARS) continue;
    const size = rendered.length + Math.min(dropped[i], rendered.length);
    if (size > bestLen) {
      bestLen = size;
      bestRender = rendered;
    }
  }
  return [bestLen, bestRender];
}

export function visibleChars(text: string): number {
  let total = 0;
  for (const line of text.split("\n")) {
    if (line.trim()) total += visibleLineChars(line);
  }
  return total;
}

function visibleLineChars(line: string): number {
  let total = 0;
  let i = 0;
  const n = line.length;
  let openBracket = false;
  while (i < n) {
    if (line[i] === "\\") {
      total += 2;
      i += 2;
      continue;
    }
    if (line[i] === "[") openBracket = true;
    if (openBracket && line[i] === "]" && i + 1 < n && line[i + 1] === "(") {
      let j = i + 2;
      let depth = 1;
      while (j < n && depth) {
        const char = line[j];
        if (char === "\\") {
          j += 2;
          continue;
        }
        depth += (char === "(" ? 1 : 0) - (char === ")" ? 1 : 0);
        j++;
      }
      if (depth) {
        total += 1;
        i += 1;
        continue;
      }
      i = j;
      openBracket = false;
      continue;
    }
    total += 1;
    i += 1;
  }
  return total;
}

function fenceFor(raw: string): string {
  let longest = 0;
  let run = 0;
  for (const char of raw) {
    run = char === "`" ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

export function htmlToMarkdown(sourceHtml: string, mainContent = false): string {
  sourceHtml = sourceHtml.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (mainContent) {
    for (const scopeTag of ["article", "main"]) {
      const [length, rendered] = selectMainScopeRender(sourceHtml, scopeTag);
      if (length >= MIN_MAIN_CONTENT_CHARS) return rendered;
    }
    return stripBoilerplateLines(render(sourceHtml, null, true));
  }
  return render(sourceHtml, null);
}
