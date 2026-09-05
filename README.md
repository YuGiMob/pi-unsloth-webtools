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
  the same provider deduplication, href-dedupe aggregator with frequency ordering (hrefs are
  canonicalized first — `utm_*`/tracking parameters and fragments are dropped and the URL is
  re-serialized, collapsing host-case, default-port, and trailing-slash variants — so the
  same page found via different tracking links collapses), and the same `SimpleFilterRanker`
  re-ranking. Formats results identically: `Title:` / `URL:` /
  `Snippet:` blocks separated by `---`, ending with the hint to pass `{"url": "<URL>"}` to
  read a full page.
- Accepts an optional `url` parameter; when given, fetches that page's text instead of
  searching (optionally truncated with `maxChars`).
- Rate-limit, timeout, and empty-result messages mirror Studio's `_search_failure_message`.
- Transient engine failures (network errors or null responses) are retried once with a short
  backoff inside the same timeout budget (a retry that cannot fit in the remaining budget is
  skipped); timeouts and cancellations are never retried.
- Sweeps stop as soon as enough results are gathered: engines still in flight are aborted
  instead of being allowed to run to their timeout.

### web_fetch

Port of Studio's `_fetch_page_text` / `_fetch_url_raw` pipeline:

- URL scheme normalization (bare hosts like `google.com` become `https://google.com`).
- URL validation: http/https only, no credentials or encoded hostnames, hostname/port checks (any
  port 1–65535 is permitted; SSRF protection is enforced at the resolved-IP layer, not by port
  allowlists).
  Canonical public IPv4 literals are accepted like IPv6 literals; private literals are blocked
  at the resolved-IP layer unless `webFetch.allowPrivateAddresses` is enabled (the default;
  non-canonical numeric encodings like `0x7f.0.0.1` / `013.0.0.1` / `2130706433` are rejected
  by URL validation before DNS either way).
- Local access by default: private/loopback/link-local targets (localhost dev servers, LAN hosts)
  and local files (`file://` URLs, absolute, `~/`, and `./` paths) are fetched directly — local
  PDFs run the same MuPDF extraction, local HTML gets the same Markdown conversion and metadata
  prefix, and the same byte caps and truncation notices apply. Opt out with
  `webFetch.allowPrivateAddresses: false` to restore the resolved-IP SSRF guard, or
  `webFetch.allowLocalFiles: false` to refuse local paths; both are settings, not tool parameters.
- DNS resolution with SSRF protection: every resolved address is validated against
  private/loopback/link-local/CGNAT/documentation/multicast/reserved ranges (unless
  `webFetch.allowPrivateAddresses` is enabled, the default), then the validated IP
  is pinned for the connection (custom `lookup` + SNI `servername`), so DNS cannot rebind between
  validation and fetch; resolution shares the caller's abort signal and the overall deadline,
  so a stuck resolver cannot outlive the fetch.
  When a host publishes both IPv4 and IPv6 addresses, IPv4 is preferred (broken IPv6 routes
  cannot stall a fetch), and a connection failure falls back to the next validated address for
  the same host before giving up.
- Transient DNS failures (EAI_AGAIN, resolver timeouts, connection refusals) are retried once
  with a short backoff inside the same deadline, so a brief resolver hiccup does not fail a
  fetch; the deadline abort cuts a retry short when no budget remains.
- GitHub repo root pages are rewritten to the unauthenticated README API
  (`Accept: application/vnd.github.raw+json`), falling back to the raw README URL
  (`raw.githubusercontent.com`, no API rate limit) and then to the HTML page on failure.
  returning error-page content.
- Up to 5 total requests (initial fetch + up to 4 HTTP redirects or `<meta http-equiv="refresh">` refreshes), each re-validated and re-resolved against the same rules.
- 512 KiB download cap (10 MiB for PDFs), overall deadline + per-hop socket timeouts, abort-aware
  (`signal` cancels mid-flight). Fetches cut off by a download cap are marked with a trailing
  truncation notice, so a partial page is not mistaken for a complete one.
- Responses sent with a `Content-Encoding` of gzip, deflate, or brotli (servers that ignore the
  `Accept-Encoding: identity` request) are decompressed while streaming, so the download caps
  bound the decoded page text (a gzip'd PDF still gets the 10 MiB PDF budget via magic sniffing on
  the decoded head) and a stream cut by the cap or a mid-stream decode failure returns the readable
  decoded prefix with the truncation notice instead of a binary-content error. A 64 MiB
  decoded-output cap bounds a compressed bomb.
- Long fetches and searches report a short progress note to the session before they start, so
  slow tool calls are not silent.
- PDF text extraction via the official MuPDF.js engine (the same C library pymupdf wraps):
  object streams, all filters, ToUnicode fonts, encryption detection, and a
  pymupdf4llm-style markdown layer (headings, bold/italic, code fences, links, tables),
  running header/footer and page-number stripping,
  with Studio's corrupted/incomplete fallback to plain text.
- Content sniffing: MIME allow/deny, binary magic signatures, PDF magic detection, and charset
  decoding (BOM sniffing for UTF-8/16/32 first, then the declared charset, `<meta charset>` sniffing for
  CJK and Windows/ISO encodings, cp1252 rescue for mislabeled single-byte pages).
- HTML → Markdown conversion ported from Studio's dependency-free `_html_to_md.py`: headings,
  links, emphasis, lists, tables, blockquotes, code fences, entity decoding; hidden-element
  stripping (`hidden`, `aria-hidden`, inline styles); `<article>`/`<main>` main-content scoping
  with link-density header stripping; boilerplate-line removal.
- No page-size budget: fetched pages and PDFs are returned in full (Studio's window-aware
  cap is deliberately dropped; the optional `maxChars` parameter still truncates when given,
  on `web_fetch` and on `web_search`'s url mode).
  The 512 KiB / 10 MiB download caps still bound the raw fetch.
- HTML entity decoding replicates CPython's `html.unescape` (full 2,231-entry HTML5 table,
  longest-prefix rule, Windows-1252 numeric mappings), matching Studio byte-for-byte.
- Fetched HTML pages are prefixed with the decoded document `<title>`, so the model can
  see which page it is reading. `Author:` (`meta name=author` / `article:author` / `dc.creator`),
  `Date:` (`article:published_time` / `dc.date` / `date`) and `Site:` (`og:site_name` /
  `application-name`) lines are added when declared, so the model can judge recency and
  provenance.

## Known differences from Studio

- PDF styling: MuPDF.js exposes one font per line, so mixed-style lines style the
  whole line instead of per-span; superscript, subscript, underline, strikeout, and
  highlight markers are not emitted. Tables use a conservative text-grid detector:
  aligned text tables are detected, drawn-rule-only tables are not.
- Running headers and footers: lines repeated at the same page-edge position on at
  least half the pages (two pages minimum) are dropped from the markdown layer, as is
  any numeric-only line at a fixed edge position where page numbers appear on at least
  half the pages (so a one-off number sharing that position is dropped too, while fused
  labels like `Page 3 of 12` survive). Studio and pymupdf4llm return them verbatim.
- Search engines: Node's `fetch` TLS fingerprint differs from ddgs's `primp`
  impersonation, so Google/Brave/Yahoo/Yandex may block or serve consent pages more
  aggressively (a blocked engine simply contributes no results). User agents are a
  fixed browser set plus ddgs's Android Google UA generator, not `fake_useragent`'s
  database.
- Empty sweeps: ddgs 9.14.4 raises the last engine exception; this port reports a
  timeout whenever any engine timed out, so the timeout message is not masked by later
  generic engine failures. The timeout budget bounds the entire sweep: per-engine
  timeouts shrink as the budget is consumed, so the reported timeout matches the
  worst-case wall time.
- Proxies: Studio routes through environment proxies; this port always connects
  directly with DNS pinning (deliberately out of scope).
- Dedup and titles: the aggregator keys on canonicalized hrefs (`utm_*`/tracking parameters
  and fragments stripped, then the URL re-serialized); fetched HTML pages are prefixed with
  the document `<title>`. Studio keys on raw hrefs and returns the converted body alone.
- Upstream drift: current ddgs ships ten backends (adding bing, startpage, grokipedia),
  requires a `vqd` token for DuckDuckGo, and exposes an `extract()` mode. This port
  deliberately pins the Studio snapshot — seven engines, bing disabled upstream, no vqd,
  no pagination — so engine behavior matches Studio rather than ddgs head.

## When to use alternatives

This package is intentionally a faithful, zero-dependency port of Studio's pipeline. Use it
when you need deterministic, offline-friendly behavior with strong SSRF guarantees and test
parity with `unsloth/studio`. For other tradeoffs, prefer:

| Need | Use |
|---|---|
| Browser-like TLS/HTTP fingerprinting to unblock bot-defended pages | `pi-smart-fetch` (`wreq-js` `chrome_145`) |
| Headless Chrome for JS-rendered SPAs/YouTube/Reddit threads | `georgebashi/pi-web-fetch` (puppeteer + trafilatura) |
| Hosted search with semantic ranking and no scraping | `Brave Search API` / `Tavily` / `Exa` via `pi-ollama-web-search` |
| Prompt-focused page distillation to save context | `pi-web-fetch` `prompt` -> sub-agent or Claude Code `WebFetch(url,prompt)` |
| Batch fetching many URLs concurrently | `pi-smart-fetch` `batch_web_fetch` or call `web_fetch` in parallel |

Mixing is supported: `pi install npm:pi-unsloth-webtools npm:pi-smart-fetch` lets the model
choose the best tool per URL. No need to fork this package to add those features.

## Configuration

Optional settings in `~/.pi/agent/settings.json` or `.pi/settings.json` (project overrides global):

```json
{
  "unslothWebTools": {
    "maxResults": 5,
    "maxChars": 50000,
    "timeoutMs": 60000
  },
  "webFetch": {
    "maxChars": 50000,
    "timeoutMs": 15000
  }
}
```

| Key | Default | Description |
|---|---|---|
| `unslothWebTools.maxResults` | `5` | Default `maxResults` for `web_search` (clamped 1-20) |
| `unslothWebTools.maxChars` / `webFetch.maxChars` / `smartFetchDefaultMaxChars` | tool param | Default `maxChars` for `web_fetch` and `web_search` url mode |
| `unslothWebTools.timeoutMs` / `webFetch.timeoutMs` / `smartFetchDefaultTimeoutMs` | `60000` fetch, `300000` search | Default `timeoutMs` when the tool param is absent (>=1000). Fetch and `web_search` url mode fall back to 60000; `web_search` query mode falls back to 300000 |
| `webSearch.maxResults` / `smartWebSearch.resultsPerQuery` | same as above | Legacy aliases for `maxResults` |
| `websitePolicy` | none | Not read from settings. Tools run unrestricted by default; `websitePolicy` is a programmatic option the host passes to `webSearch` / `fetchPageText` |
| `unslothWebTools.allowPrivateAddresses` / `webFetch.allowPrivateAddresses` | `true` | Opt out to restore the resolved-IP SSRF guard: private/loopback/link-local hosts (localhost, LAN IPs) are refused again. Non-canonical numeric IP encodings stay blocked either way |
| `unslothWebTools.allowLocalFiles` / `webFetch.allowLocalFiles` | `true` | Opt out to refuse local files in `web_fetch` and `web_search` url mode (`file://` URLs, absolute, `~/`, or `./` paths); when enabled, PDFs are extracted and HTML converted |

Tool params always win over file defaults. Search dedup also strips default ports, so `https://example.com:443/a` and `https://example.com/a` collapse.

Environment overrides: `PI_UNSLOTH_CACHE_DIR` changes the fetch cache directory, `PI_UNSLOTH_WEBTOOLS_STATS` opts into append-only sweep stats JSONL, `PI_CODING_AGENT_DIR` / `PI_AGENT_DIR` change the global settings directory. Cache entries live 1 hour and stale copies are served only after a network failure.

## Troubleshooting

Match on the exact prefix. Do not retry blocked hosts with spelling tricks.

| Symptom | Exact string | Action |
|---|---|---|
| Empty query | `No query provided.` | Pass `query` or `url`. |
| Cancelled | `Search cancelled.` / `Failed to fetch URL: cancelled.` | Retry only if the abort was not intentional. |
| Search timeout | `Search failed: the search engines (...) did not respond within N seconds.` | Retry, narrow the query, or raise `timeoutMs`. |
| No results | `No results found.` | Rephrase the query. |
| Policy filtered everything | `No results found within the website access limits.` | Widen `websitePolicy`, do not work around it. |
| Blocked URL | `Blocked: ...` | Respect it. Includes non-http schemes, credentials, invalid hosts, non-canonical numeric IP encodings, and policy denials. |
| Private address blocked | `Blocked: refusing to fetch the non-public address ...` | The SSRF guard is active (`allowPrivateAddresses: false`); remove it or set `true` to reach localhost/LAN, and write the scheme explicitly (`http://localhost:3000`). |
| Local file blocked | `Blocked: the URL has an invalid hostname or port.` for paths | Local files are disabled: remove `allowLocalFiles: false` to read `file://`, absolute, `~/`, or `./` paths. |
| File read failed | `Failed to read file: ...` | Check the path exists and is a regular file. |
| HTTP failure | `Failed to fetch URL: HTTP ...` | Fix the URL. A 404 automatically tries a Wayback snapshot. |
| Non-text / binary | `(non-text content:` / `(binary content,` | Not readable as text by design. |
| PDF without text | `(PDF contains no extractable text)` / `(PDF content could not be read as text...)` | Scanned or encrypted PDF. |
| Download cap hit | `... (page truncated at the download limit)` | Raw fetch hit 512 KiB (10 MiB for PDFs). |
| maxChars cut | `... (truncated, N chars total)` | Raise `maxChars` for the full text. |
| Empty page | `(page returned no readable text)` | Page had no extractable text; JS-rendered pages need a browser tool. |
| GitHub rewrite | `README of ... (fetched via the GitHub README API):` | Expected repo-root rewrite, not the HTML chrome. |
| Cache fallback | `Served from cache` / `STALE cache from YYYY-MM-DD` | Network failed; output is the cached copy with its date. |
| Wayback fallback | `Fetched from Wayback Machine snapshot (YYYY-MM-DD) for ...` | Original 404'd; output is the archived copy with its date. |

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
- `test/smoke.test.ts`: live network checks against real hosts, including a per-engine
  result-health sweep (at least two engines must return well-formed results; engines
  that block or reset connections from datacenter IPs count as unhealthy, not failures)

The seams (`seams.resolve` / `seams.request` / `rawFetch`) replace the network stack
with fakes, mirroring how the Studio suite monkeypatches `_validate_and_resolve_host`
and `build_opener`.

## License

The ported logic derives from Unsloth Studio
([AGPL-3.0-only](https://github.com/unslothai/unsloth/blob/main/studio/LICENSE.AGPL-3.0)), so this
package is released under the same AGPL-3.0-only license.
