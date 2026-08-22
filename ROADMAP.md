# Roadmap

Tracking the remaining gaps between this port and Unsloth Studio's web tools, and the
planned work to close them.

## Implemented

### PDF text extraction (MuPDF engine)

`pdf.ts` uses the official **MuPDF.js** (`mupdf` npm package) — the same C engine that
PyMuPDF wraps — replacing the earlier minimal built-in extractor:

- Full xref handling: tables, cross-reference streams, and PDF 1.5+ object streams
- All standard stream filters (FlateDecode, ASCII85Decode, LZW, RunLength, DCT, JPX, ...)
- Font encodings and ToUnicode mapping (non-Latin text extracts correctly)
- Encryption detection via `needsPassword()` (reported as unreadable, matching pymupdf's
  no-password behavior)
- The markdown layer replicates pymupdf4llm's algorithm: `IdentifyHeaders` font-size
  heading detection, `get_raw_lines` line reconstruction (tolerance 3, 10% span-join
  delta), `write_text` styling (bold/italic/mono, code fences, bullets, link
  resolution with `%0x`-escaped URIs), and Studio's corrupted/incomplete fallback to
  plain MuPDF text with the exact thresholds from `backend/core/rag/parsers.py`
- Table detection and pipe-markdown rendering matching pymupdf's `Table.to_markdown`
  shape (`|header|`, `|---|`, detail rows, `Col{i}` fill for empty headers)

Known deltas vs pymupdf4llm:

- Span-level styling: MuPDF.js's structured-text JSON exposes one font per line, so
  mixed-style lines (one bold word inside a body line) style the whole line instead of
  per-span. Line-level styling matches for homogeneous lines.
- Superscript/subscript/underline/strikeout/highlight markers are not emitted (the
  JSON does not expose char-level flags).
- Table detection is a conservative text-grid detector (column-start clustering with
  a 5 pt tolerance, contiguous multi-row bands) instead of PyMuPDF's
  `find_tables()` vector-graphics analysis. Aligned text tables are detected; tables
  defined only by drawn rules without aligned text are not.

The minimal extractor remains as an automatic fallback when the `mupdf` package cannot
be loaded (for example a stripped install).

## Not planned (explicit decisions)

### Proxy support

Studio routes requests through urllib's environment proxies and honors
`UNSLOTH_STUDIO_DISABLE_DNS_PINNING` for enterprise proxies. This port always connects
directly with DNS pinning. Deliberately out of scope.

### Window-aware page budgets

Studio's `_page_char_budget()` sizes fetched pages to the serving model's context
window. This port deliberately uses a flat, much larger cap (`MAX_PAGE_CHARS = 100_000`)
that does not depend on context length, so a small window gets a bigger page than Studio
would return.

## Known behavioral differences

### Search engine set

The port implements ddgs 9.14.4's `DDGS.text()` exactly: the same seven engines
(duckduckgo, brave, google, mojeek, yahoo, yandex, wikipedia — bing is `disabled` in
ddgs upstream), the same provider-deduplication, href-dedupe aggregator with
frequency ordering, and the same `SimpleFilterRanker` re-ranking. Remaining deltas:

- **TLS fingerprinting**: ddgs uses `primp` with browser TLS impersonation. Node's
  `fetch` has a different fingerprint, so Google/Brave/Yahoo/Yandex may block or serve
  consent pages more aggressively. When an engine is blocked it simply contributes no
  results, exactly as when ddgs is blocked.
- **User agents**: ddgs uses `fake_useragent`'s database; the port uses a fixed set of
  browser UAs plus ddgs's own Android Google UA generator.

### Entity decoding

`decodeHtmlEntities` replicates CPython's `html.unescape` exactly (full HTML5 table,
longest-prefix rule, Windows-1252 numeric mappings, invalid-codepoint handling), so the
HTML-to-Markdown converter and search-result normalization match Studio's output.
