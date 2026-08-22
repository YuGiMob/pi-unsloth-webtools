# Roadmap

Tracking the remaining gaps between this port and Unsloth Studio's web tools, and the
planned work to close them.

## Planned

### Full pymupdf-grade PDF text extraction

Currently: a minimal built-in extractor (zlib inflate + PDF text operators). It handles
plain and FlateDecode-compressed text streams with `Tj`/`TJ` operators, which covers
simple text PDFs. It does not handle:

- xref table traversal and PDF 1.5+ object streams (content may live in compressed
  object streams)
- Filters other than FlateDecode (LZW, ASCIIHex, ASCII85, RunLength, DCT, CCITT)
- ToUnicode CMaps and font encodings (non-Latin text extracts as latin1 bytes and can
  mojibake)
- Encryption (detected via `/Encrypt` and reported as unreadable, matching pymupdf's
  no-password behavior)

Studio uses `pymupdf`; the plan is to replace the built-in extractor with a proper PDF
library (or a full parser) while keeping the page-capping and `text limited to` /
`page processing capped at` markers. **Target: next major version.**

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
