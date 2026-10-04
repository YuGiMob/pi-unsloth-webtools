# pi-unsloth-webtools

A [pi](https://github.com/earendil-works/pi-coding-agent) extension providing `web_search` and
`web_fetch` tools. It began as a port of the Unsloth Studio codebase
([`unslothai/unsloth`](https://github.com/unslothai/unsloth), `studio/backend/core/inference/`);
the engine, extraction, and PDF layers are still derived from it, but the package is no longer
behavior-identical to Studio — it enables local file and private-address fetching by default
and adds a fetch cache, Wayback fallbacks, page metadata, a browser-fingerprint retry, local
local Lightpanda rendering, and other behavior Studio does not have.
[Known differences from Studio](#known-differences-from-studio). The `unsloth` in the name marks
provenance, not affiliation.

## Install

```sh
pi install npm:pi-unsloth-webtools
```

or add `npm:pi-unsloth-webtools` to the `packages` array in `~/.pi/agent/settings.json`.

To install from source instead:

```sh
pi install /path/to/pi-unsloth-webtools
```

Installing pulls one runtime dependency, `wreq-js`, whose prebuilt native binding gives `web_fetch`
its browser-shaped TLS fingerprint. Bindings exist for Linux (x64/arm64), macOS and Windows; because
the binding is what `--omit=optional` skips, that install gets the shim without the engine and
`web_fetch` quietly uses the plain Node transport instead. `mupdf` (PDF text extraction) stays an
optional dependency, and the package works without it.

## What it does

Both tools display their target in the TUI tool row: `web_search "query"` and `web_fetch <url>`.

### web_search

Mirrors Unsloth Studio's `web_search` tool:

- Searches exactly like Studio's pinned `ddgs==9.14.4` `DDGS.text()`: the same seven engines
  (duckduckgo, brave, google, mojeek, yahoo, yandex, wikipedia; bing is disabled upstream),
  the same provider deduplication, href-dedupe aggregator with frequency ordering (hrefs are
  canonicalized first — `utm_*`/tracking parameters and fragments are dropped and the URL is
  re-serialized, collapsing host-case, default-port, and trailing-slash variants — so the
  same page found via different tracking links collapses), and the same `SimpleFilterRanker`
  re-ranking. Formats results identically: `Title:` / `URL:` /
  `Snippet:` blocks separated by `---`, ending with the hint to call `web_fetch` to
  read a full page.
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
- Proxy environment variables are honored when they name a SOCKS5 proxy: `HTTPS_PROXY` /
  `HTTP_PROXY` / `ALL_PROXY` (with `NO_PROXY` exclusions) tunnel the pinned connection, so a
  Tor-mode agent routes `web_fetch` through its exit. `socks5h` is
  treated like `socks5`: the host is resolved locally for the guard and the pinned IP is what the
  proxy connects to. Other proxy schemes are ignored (direct connection).
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
  on `web_fetch`).
  The 512 KiB / 10 MiB download caps still bound the raw fetch.
- HTML entity decoding replicates CPython's `html.unescape` (full 2,231-entry HTML5 table,
  longest-prefix rule, Windows-1252 numeric mappings), matching Studio byte-for-byte.
- Fetched HTML pages are prefixed with the decoded document `<title>`, so the model can
  see which page it is reading. `Author:` (`meta name=author` / `article:author` / `dc.creator`),
  `Date:` (`article:published_time` / `dc.date` / `date`) and `Site:` (`og:site_name` /
  `application-name`) lines are added when declared, so the model can judge recency and
  provenance.
- A direct fetch refused with HTTP 403 is retried through a browser-fingerprint transport
  (`wreq-js`, Chrome TLS/HTTP2 shape) that keeps the pinned DNS and the website policy checks.
  This is the default transport and clears many bot walls without a browser and without a third
  party; opt out with `webFetch.transport: "direct-first"` or `"off"`.
- A page that is still refused, or that looks JavaScript-rendered, is rendered locally with
  Lightpanda when the binary is installed. There is no third-party rendering service: nothing is
  sent anywhere except to the target itself. Bot-challenge pages are rejected, so an interstitial
  never replaces a real render. When nothing renders, the original error or a
  `*(JavaScript-rendered page; content may be incomplete)*` note is returned.

### Rendering and anti-bot tiers

`web_fetch` escalates through two tiers, cheapest first:

1. **Browser-fingerprint transport** (`wreq-js`, Chrome TLS/HTTP2 shape) is the default, and it is
   a required dependency: it is a small native Rust module with prebuilt bindings for Linux
   (x64/arm64, glibc and musl), macOS (x64/arm64) and Windows (x64/arm64). Requests are pinned to
   the resolved, validated IP, browser-emulation headers are left intact so the fingerprint stays
   coherent, and redirects are handed back to the main hop loop, so every hop is re-validated
   against the website policy. The plain Node transport takes over when no prebuilt binding exists
   for the platform, when a SOCKS5 proxy is configured (traffic must keep using the tunnelling
   path), or when the request fails at the connection level; a 403 from either transport triggers
   one retry through the other. `webFetch.transport` selects `tls-first` (default), `direct-first`,
   or `off`.
2. **Local rendering** with a locally installed
   [Lightpanda](https://github.com/lightpanda-io/browser) binary when a page is still refused or
   looks JavaScript-rendered.

There is no third tier. If a page needs a browser that the local renderer cannot provide, the
original error (or the incomplete-content note) is returned rather than shipping the URL to a
third-party rendering service.

#### Local rendering (Lightpanda)

- Runs `lightpanda fetch --dump html --wait-until networkidle --block-private-networks` and puts
  the dump through the same Markdown pipeline as any other fetch, so titles, metadata,
  main-content scoping and boilerplate removal match the direct path.
- `--block-private-networks` is always passed in addition to the pre-flight resolve check, so a
  redirect or subresource inside the browser cannot reach a private address.
- A render is only accepted when it contains real prose, or beats the fetched text by 1.5x. A
  non-zero exit, a timeout, or a bot-challenge page counts as a failed tier, so the next tier
  still gets its chance.
- Lightpanda identifies itself honestly and refuses to impersonate a browser user agent, so hard
  anti-bot walls are returned as failures (the direct error, or the incomplete-content note).
- Binary resolution: `webRender.lightpandaPath`, then `PI_LIGHTPANDA_BIN`, then
  `lightpanda` on `PATH`. Prebuilt binaries exist for Linux (glibc; musl needs a source
  build) and macOS, plus Docker images; Windows needs WSL2.
- Version matters: 1.0.0 renders JavaScript-heavy pages that the 0.2.x line cannot — measured on
  the same machine, IMDb went from a 76-byte empty document to 21k characters, dribbble from 32
  characters to 18k, and a Medium article from a challenge page to real text. Linux builds from
  0.3 on require glibc 2.38, so older distributions are stuck on 0.2.x without the next bullet.
- Windows has no native Lightpanda build: install it inside WSL2 and point `webRender.lightpandaCommand`
  at `["wsl.exe", "-e", "<path inside WSL>"]`, which the renderer then drives like any other binary.
  The same setting works for a container (`["docker", "run", "--rm", "lightpanda/browser:nightly"]`)
  or any wrapper. `scripts/install-lightpanda.sh` prints that recipe when run outside WSL.
- `bash scripts/install-lightpanda.sh` installs the newest stable release. When the system glibc
  predates what the binary needs, it downloads Debian's `libc6` for the current stable suite,
  extracts it into the install directory, and writes a launcher shim — so 1.0.0 runs on a
  glibc 2.36 host without touching the system libraries. It also writes
  `webRender.lightpandaPath` into the global settings, so the extension picks the binary up with
  no further setup; `--no-configure` skips that and `--print-path` prints the launcher path for CI.
- Disable the tier with `webRender.lightpandaEnabled: false`; `web_fetch` then stops after the
  network attempts and reports the original error.

## Known differences from Studio

- Local access: Studio validates every resolved address against non-public ranges and fetches
  public web content only. This port permits private/loopback/link-local targets and local files
  (`file://` URLs and absolute, `~/`, `./` paths) by default; opt out with
  `webFetch.allowPrivateAddresses: false` and `webFetch.allowLocalFiles: false` to restore
  Studio's behavior.
- Browser-fingerprint retry: a 403 is retried through `wreq-js` (Chrome TLS/HTTP2 shape) before any
  rendering, keeping the pinned IP, the website policy, and the local-file refusal rules. Studio has
  no such path.
- Local rendering: Lightpanda renders the page in a local browser and the dump runs through the same
  extraction pipeline; nothing leaves the machine, and `--block-private-networks` is always passed.
  Studio has no local rendering path.
- No third-party rendering: Studio has no rendering path at all; this port renders refused or
  JavaScript-heavy pages locally with Lightpanda and never sends the URL to a rendering service.
  Local files and non-public addresses stay refused for the browser tier.
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
- Proxies: Studio routes through environment proxies; this port resolves and pins the target IP and
  tunnels that connection through `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` when the proxy is a
  SOCKS5 proxy (`NO_PROXY` exclusions respected; DNS stays local for the guard). Other proxy
  schemes fall back to a direct connection. The search path uses the process-wide `fetch`, so an
  agent-level proxy dispatcher applies there too — see
  [Companion: rotating exit IPs](#companion-rotating-exit-ips).
- Dedup and titles: the aggregator keys on canonicalized hrefs (`utm_*`/tracking parameters
  and fragments stripped, then the URL re-serialized); fetched HTML pages are prefixed with
  the document `<title>`. Studio keys on raw hrefs and returns the converted body alone.
- Upstream drift: current ddgs ships ten backends (adding bing, startpage, grokipedia),
  requires a `vqd` token for DuckDuckGo, and exposes an `extract()` mode. This port
  deliberately pins the Studio snapshot — seven engines, bing disabled upstream, no vqd,
  no pagination — so engine behavior matches Studio rather than ddgs head.

## When to use alternatives

This package keeps Studio's deterministic extraction and search pipeline — and its test parity with
`unsloth/studio` — then layers browser-fingerprint fetching, local rendering, local access, and other
Studio-independent behavior on top. Its only runtime dependency is `wreq-js` (the default transport);
`mupdf` stays optional. The SSRF guard is real and thoroughly tested, but it is opt-in:
`allowPrivateAddresses` defaults to `true`, and local files are readable unless `allowLocalFiles`
is `false`. For other tradeoffs, prefer:

| Need | Use |
|---|---|
| Browser-like TLS/HTTP fingerprinting to unblock bot-defended pages | Built in: `webFetch.transport` defaults to `tls-first`, which speaks Chrome's TLS/HTTP2 shape through `wreq-js`; `pi-smart-fetch` (`wreq-js` `chrome_145`) if you want a separate tool |
| Headless Chrome for JS-rendered SPAs/YouTube/Reddit threads | Built-in local Lightpanda rendering; `georgebashi/pi-web-fetch` (puppeteer + trafilatura) or a Patchright-based tier when it falls short |
| Hosted search with semantic ranking and no scraping | `Brave Search API` / `Tavily` / `Exa` via `pi-ollama-web-search` |
| Prompt-focused page distillation to save context | `pi-web-fetch` `prompt` -> sub-agent or Claude Code `WebFetch(url,prompt)` |
| Batch fetching many URLs concurrently | `pi-smart-fetch` `batch_web_fetch` or call `web_fetch` in parallel |

Mixing is supported: `pi install npm:pi-unsloth-webtools npm:pi-smart-fetch` lets the model
choose the best tool per URL. No need to fork this package to add those features.

## Companion: rotating exit IPs

[`pi-tor-proxy`](https://github.com/YuGiMob/pi-tor-proxy) routes pi's in-process `fetch` traffic
through Tor (it downloads and manages its own Tor binary) and gives each pi instance its own
circuit and exit IP. The search sweep uses the process-wide `fetch`, so it leaves through the
current Tor exit, and many search engines rate-limit or challenge per outgoing IP —
`/tor-cycle` swaps the exit those limits are counted against, while `/tor-country` and
`/tor-exclude` constrain which exits are used.

```sh
pi install npm:pi-unsloth-webtools npm:pi-tor-proxy
```

`web_fetch` also routes: it resolves and pins the target IP, then tunnels
the connection through the SOCKS5 proxy named by `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (with
`NO_PROXY` exclusions, so localhost and local files stay direct). DNS is still resolved locally for
the SSRF guard, and the proxy connects to that pinned IP.
Caveats: Tor mode supports Linux and macOS only, adds latency, and many search engines and
Cloudflare-fronted services challenge or block Tor exits, so cycling helps with per-IP limits but
is not a guarantee.

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
| `unslothWebTools.maxChars` / `webFetch.maxChars` / `smartFetchDefaultMaxChars` | tool param | Default `maxChars` for `web_fetch` |
| `unslothWebTools.timeoutMs` / `webFetch.timeoutMs` / `smartFetchDefaultTimeoutMs` | `60000` fetch, `300000` search | Default `timeoutMs` when the tool param is absent (>=1000). Fetch falls back to 60000; `web_search` query mode falls back to 300000 |
| `webSearch.maxResults` / `smartWebSearch.resultsPerQuery` | same as above | Legacy aliases for `maxResults` |
| `websitePolicy` | none | Not read from settings. Tools run unrestricted by default; `websitePolicy` is a programmatic option the host passes to `webSearch` / `fetchPageText` |
| `unslothWebTools.allowPrivateAddresses` / `webFetch.allowPrivateAddresses` | `true` | Opt out to restore the resolved-IP SSRF guard: private/loopback/link-local hosts (localhost, LAN IPs) are refused again. Non-canonical numeric IP encodings stay blocked either way |
| `unslothWebTools.allowLocalFiles` / `webFetch.allowLocalFiles` | `true` | Opt out to refuse local files in `web_fetch` (`file://` URLs, absolute, `~/`, or `./` paths); when enabled, PDFs are extracted and HTML converted |
| `webFetch.transport` / `unslothWebTools.transport` | `tls-first` | Fetch transport order: `tls-first` (default), `direct-first`, or `off` to disable the browser-fingerprint transport entirely |
| `webRender.lightpandaEnabled` / `unslothWebTools.lightpandaEnabled` | `true` | Opt out to disable local Lightpanda rendering |
| `webRender.lightpandaPath` / `unslothWebTools.lightpandaPath` | `lightpanda` on `PATH` (`PI_LIGHTPANDA_BIN` fallback) | Path to the Lightpanda binary used for local rendering |
| `webRender.lightpandaCommand` / `unslothWebTools.lightpandaCommand` | none | Command prefix that launches the renderer, for WSL (`["wsl.exe","-e","<path>"]`) or containers; overrides `lightpandaPath`. The fetch flags are appended to it |

Environment overrides: `PI_UNSLOTH_CACHE_DIR` changes the fetch cache directory, `PI_UNSLOTH_WEBTOOLS_STATS` opts into append-only sweep stats JSONL, `PI_CODING_AGENT_DIR` / `PI_AGENT_DIR` change the global settings directory, and `PI_LIGHTPANDA_BIN` points at the local renderer binary. Cache entries live 1 hour and stale copies are served only after a network failure. SOCKS5 proxies named by `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` are honored on every fetch (`NO_PROXY` exclusions apply).

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
| HTTP failure | `Failed to fetch URL: HTTP ...` | Fix the URL. A 404 automatically tries a Wayback snapshot; a 403 retries through the browser-fingerprint transport first. |
| Proxy failure | `Failed to fetch URL: SOCKS5 proxy ...` | The SOCKS5 proxy refused or failed (for example Tor is stopping). Check the proxy, or unset the proxy variables for a direct fetch. |
| Non-text / binary | `(non-text content:` / `(binary content,` | Not readable as text by design. |
| PDF without text | `(PDF contains no extractable text)` / `(PDF content could not be read as text...)` | Scanned or encrypted PDF. |
| Download cap hit | `... (page truncated at the download limit)` | Raw fetch hit 512 KiB (10 MiB for PDFs). |
| maxChars cut | `... (truncated, N chars total)` | Raise `maxChars` for the full text. |
| Empty page | `(page returned no readable text)` | Page had no extractable text; `web_fetch` then tries local Lightpanda if it is installed. |
| JavaScript-rendered page | `*(JavaScript-rendered page; content may be incomplete)*` | Rendering was disabled or produced no more text; the page likely needs a browser. |
| GitHub rewrite | `README of ... (fetched via the GitHub README API):` | Expected repo-root rewrite, not the HTML chrome. |
| Cache fallback | `Served from cache` / `STALE cache from YYYY-MM-DD` | Network failed; output is the cached copy with its date. |
| Wayback fallback | `Fetched from Wayback Machine snapshot (YYYY-MM-DD) for ...` | Original 404'd; output is the archived copy with its date. |

| No browser-fingerprint binding | fetch behaves as if `webFetch.transport` were `direct-first` | `wreq-js` ships prebuilt bindings for Linux, macOS and Windows only; on other platforms the tier is skipped automatically |
| No renderer available | `*(JavaScript-rendered page; content may be incomplete)*` with no local note | Install Lightpanda, or set `webRender.lightpandaPath` / `PI_LIGHTPANDA_BIN`, to render JavaScript-heavy pages locally |
| Local renderer failed | `Failed to render URL: Lightpanda exited with code N.` | The failed tier falls through to the next one; check the binary by hand with `lightpanda fetch --dump markdown <url>` |
| Local renderer blocked a target | `Blocked: the local renderer cannot fetch local files.` | The local browser refuses local paths by design; fetch them with `web_fetch` directly instead |
## Development

```sh
npm install
npm run typecheck
npm test
npm run test:unit
npm run test:smoke
bash scripts/install-lightpanda.sh
npm run camoufox:warmup
```

`npm run camoufox:warmup` measures what a warm Camoufox costs and buys: launch time, idle CPU and
RSS, per-fetch latency with the browser already running, and whether a persistent profile
(`user_data_dir`, pinned fingerprint) lets a Cloudflare clearance survive a restart. Flags:
`--virtual` for a virtual display, `--pin=0` to let Camoufox rotate fingerprints, `--seconds=N`,
`--idle=N`.

## Tests

`npm test` runs the full suite. `npm run test:unit` skips the live-network smoke tests,
`npm run test:smoke` runs only those, and `npm run test:lightpanda` drives a real Lightpanda binary
against live pages — it is skipped unless `PI_LIGHTPANDA_E2E=1` is set (`PI_LIGHTPANDA_E2E_BIN` points
at the binary), and CI runs it in a dedicated job after `scripts/install-lightpanda.sh`.

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

- `test/tls-fetch.test.ts`: the browser-fingerprint transport with a stubbed native module, including
  transport reuse, body caps, redirect passthrough, and abort/timeout mapping
- `test/lightpanda.test.ts`: the local renderer's command line, guards, failure modes, and a real
  child-process run against a scripted binary
- `test/impersonation.test.ts`: the HTTP 403 retry inside the fetch pipeline, including redirect
  re-validation, the disabled path, and the stubbed-network contract
The seams (`seams.resolve` / `seams.request` / `seams.impersonate` / `rawFetch`) replace the network
stack with fakes, mirroring how the Studio suite monkeypatches `_validate_and_resolve_host` and
`build_opener`. Supplying a `request` seam also disables the browser-fingerprint retry, so a stubbed
transport never escapes to the real network.

## License

The ported logic derives from Unsloth Studio
([AGPL-3.0-only](https://github.com/unslothai/unsloth/blob/main/studio/LICENSE.AGPL-3.0)), so this
package is released under the same AGPL-3.0-only license.
