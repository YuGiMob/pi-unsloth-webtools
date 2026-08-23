# pi-unsloth-webtools

A [pi](https://github.com/earendil-works/pi-coding-agent) extension providing `web_search` and
`web_fetch` tools, ported from the Unsloth Studio codebase
([`unslothai/unsloth`](https://github.com/unslothai/unsloth), `studio/backend/core/inference/`).

## Install

```sh
pi install npm:pi-unsloth-webtools
```

or add `npm:pi-unsloth-webtools` to the `packages` array in `~/.pi/agent/settings.json`.

To install from source instead:

```sh
pi install /path/to/pi-unsloth-webtools
```

## What it does

### web_search

Mirrors Unsloth Studio's `web_search` tool:

- Searches exactly like Studio's pinned `ddgs==9.14.4` `DDGS.text()`: the same seven engines
  (duckduckgo, brave, google, mojeek, yahoo, yandex, wikipedia; bing is disabled upstream),
  the same provider deduplication, href-dedupe aggregator with frequency ordering, and the
  same `SimpleFilterRanker` re-ranking. Formats results identically: `Title:` / `URL:` /
  `Snippet:` blocks separated by `---`, ending with the hint to pass `{"url": "<URL>"}` to
  read a full page.
- Accepts an optional `url` parameter; when given, fetches that page's text instead of searching.
- Rate-limit, timeout, and empty-result messages mirror Studio's `_search_failure_message`.

### web_fetch

Port of Studio's `_fetch_page_text` / `_fetch_url_raw` pipeline:

- URL scheme normalization (bare hosts like `google.com` become `https://google.com`).
- URL validation: http/https only, no credentials or encoded hostnames, hostname/port checks.
- DNS resolution with SSRF protection: every resolved address is validated against
  private/loopback/link-local/CGNAT/documentation/multicast/reserved ranges, then the validated IP
  is pinned for the connection (custom `lookup` + SNI `servername`), so DNS cannot rebind between
  validation and fetch.
- GitHub repo root pages are rewritten to the unauthenticated README API
  (`Accept: application/vnd.github.raw+json`), falling back to the HTML page on failure.
- Up to 5 redirect hops, each re-validated and re-resolved against the same rules.
- 512 KiB download cap (10 MiB for PDFs), overall deadline + per-hop socket timeouts, abort-aware
  (`signal` cancels mid-flight).
- PDF text extraction via the official MuPDF.js engine (the same C library pymupdf wraps):
  object streams, all filters, ToUnicode fonts, encryption detection, and a
  pymupdf4llm-style markdown layer (headings, bold/italic, code fences, links, tables)
  with Studio's corrupted/incomplete fallback to plain text.
- Content sniffing: MIME allow/deny, binary magic signatures, PDF magic detection, and charset
  decoding (declared charset, BOM sniffing for UTF-8/16/32, `<meta charset>` sniffing for
  CJK and Windows/ISO encodings, cp1252 rescue for mislabeled single-byte pages).
- HTML → Markdown conversion ported from Studio's dependency-free `_html_to_md.py`: headings,
  links, emphasis, lists, tables, blockquotes, code fences, entity decoding; hidden-element
  stripping (`hidden`, `aria-hidden`, inline styles); `<article>`/`<main>` main-content scoping
  with link-density header stripping; boilerplate-line removal.
- No page-size budget: fetched pages and PDFs are returned in full (Studio's window-aware
  cap is deliberately dropped; the optional `maxChars` parameter still truncates when given).
  The 512 KiB / 10 MiB download caps still bound the raw fetch.
- HTML entity decoding replicates CPython's `html.unescape` (full 2,231-entry HTML5 table,
  longest-prefix rule, Windows-1252 numeric mappings), matching Studio byte-for-byte.

## Known differences from Studio

- PDF styling: MuPDF.js exposes one font per line, so mixed-style lines style the
  whole line instead of per-span; superscript, subscript, underline, strikeout, and
  highlight markers are not emitted. Tables use a conservative text-grid detector:
  aligned text tables are detected, drawn-rule-only tables are not.
- Search engines: Node's `fetch` TLS fingerprint differs from ddgs's `primp`
  impersonation, so Google/Brave/Yahoo/Yandex may block or serve consent pages more
  aggressively (a blocked engine simply contributes no results). User agents are a
  fixed browser set plus ddgs's Android Google UA generator, not `fake_useragent`'s
  database.
- Empty sweeps: ddgs 9.14.4 raises the last engine exception; this port reports a
  timeout whenever any engine timed out, so the timeout message is not masked by later
  generic engine failures.
- Proxies: Studio routes through environment proxies; this port always connects
  directly with DNS pinning (deliberately out of scope).

## Development

```sh
npm install
npm run typecheck
npm test
npm run test:unit
npm run test:smoke
```

## Tests

`npm test` runs the full suite. `npm run test:unit` skips the live-network smoke tests,
and `npm run test:smoke` runs only those.

The suite ports Unsloth Studio's own tests for these tools:

- `test/html-to-md.test.ts`: hidden-element stripping and main-content scoping (from
  `test_web_fetch_extraction.py`)
- `test/header-strip.test.ts`: the header link-density suite plus article-vs-main selection
  and boilerplate cases (from `test_web_fetch_extraction.py`)
- `test/binary-guard.test.ts`: the MIME/magic/charset/PDF matrix (from
  `test_web_fetch_binary_guard.py`)
- `test/web-search-policy.test.ts`: policy filtering, overfetch, and failure messages
  (from `test_web_access_policy.py`)
- `test/fetch-flow.test.ts`: GitHub README rewrite, deadline/cancellation, HTML sniffing
  (from `test_web_fetch_extraction.py`; the fetch client is injected via seams)
- `test/engines.test.ts`: the ddgs engine port, normalizers, the XPath subset, the
  aggregator, the ranker, and the Wikipedia engine with a stubbed fetch
- `test/pdf-parity.test.ts`: MuPDF engine capabilities, PDF 1.5 object streams,
  ASCII85Decode, font `/Differences` encodings, pymupdf4llm-style headings/links/tables
- `test/entities.test.ts`: `decodeHtmlEntities` parity with CPython `html.unescape`,
  legacy refs, longest-prefix rule, Windows-1252 numeric mappings, invalid codepoints
- `test/smoke.test.ts`: live network checks against real hosts

The seams (`seams.resolve` / `seams.request` / `rawFetch`) replace the network stack
with fakes, mirroring how the Studio suite monkeypatches `_validate_and_resolve_host`
and `build_opener`.

## License

The ported logic derives from Unsloth Studio
([AGPL-3.0-only](https://github.com/unslothai/unsloth/blob/main/studio/LICENSE.AGPL-3.0)), so this
package is released under the same AGPL-3.0-only license.
