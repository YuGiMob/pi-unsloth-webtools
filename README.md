# pi-unsloth-webtools

A [pi](https://github.com/earendil-works/pi-coding-agent) extension providing `web_search` and
`web_fetch` tools, ported from the Unsloth Studio codebase
([`unslothai/unsloth`](https://github.com/unslothai/unsloth), `studio/backend/core/inference/`).

## What it does

### web_search

Mirrors Unsloth Studio's `web_search` tool:

- Searches DuckDuckGo the same way Studio's `ddgs` client does (POST to the HTML endpoint), and
  formats results identically: `Title:` / `URL:` / `Snippet:` blocks separated by `---`, ending
  with the hint to pass `{"url": "<URL>"}` to read a full page.
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
- Content sniffing: MIME allow/deny, binary magic signatures, PDF magic + text extraction
  (built-in zlib-based extractor, not pymupdf-grade), charset decoding (declared charset, BOM
  sniffing for UTF-8/16/32, cp1252 rescue for mislabeled single-byte pages).
- HTML → Markdown conversion ported from Studio's dependency-free `_html_to_md.py`: headings,
  links, emphasis, lists, tables, blockquotes, code fences, entity decoding; hidden-element
  stripping (`hidden`, `aria-hidden`, inline styles); `<article>`/`<main>` main-content scoping
  with link-density header stripping; boilerplate-line removal.
- Truncation with Studio's `... (truncated, N chars total)` marker (default cap 16,000 chars,
  `maxChars` parameter overrides).

## Install

```sh
pi install /path/to/pi-unsloth-webtools
```

or add `npm:pi-unsloth-webtools` (once published) to the `packages` array in
`~/.pi/agent/settings.json`.

## Development

```sh
npm install
npm run typecheck
npm test
```

## License

The ported logic derives from Unsloth Studio
([AGPL-3.0-only](https://github.com/unslothai/unsloth/blob/main/studio/LICENSE.AGPL-3.0)), so this
package is released under the same **AGPL-3.0-only** license.
