import { describe, expect, it } from "vitest";
import { htmlToMarkdown, isAriaHeading } from "../html-to-md.ts";

function interlanguageList(count: number): string {
  return Array.from(
    { length: count },
    (_, i) =>
      `<li class="interlanguage-link"><a href="https://x${i}.wikipedia.org/wiki/K">Lang${i}</a></li>`,
  ).join("");
}

describe("main-content scoping extras", () => {
  it("does not let a tiny article stub hijack the scope", () => {
    const html = "<body><article><p>Stub</p></article><main><p>" + "Real content paragraph. ".repeat(30) + "</p></main></body>";
    const out = htmlToMarkdown(html, true);
    expect(out).toContain("Real content paragraph.");
  });

  it("does not leak sibling articles after main is selected", () => {
    const real = "Main article body content for selection. ".repeat(20);
    const card = "Unrelated related-post card teaser blurb. ".repeat(3);
    const cards = Array.from({ length: 5 }, () => `<article><p>${card}</p></article>`).join("");
    const html = `<body><article><h1>Real</h1><p>${real}</p></article>${cards}</body>`;
    const out = htmlToMarkdown(html, true);
    expect(out).toContain("Main article body content");
    expect(out).not.toContain("Unrelated related-post");
  });

  it("leaves the default conversion unscoped and unstripped", () => {
    const html = "<body><p>Skip to content</p><div hidden>gone</div><main><p>hello</p></main></body>";
    const out = htmlToMarkdown(html);
    expect(out).toContain("Skip to content");
    expect(out).toContain("hello");
    expect(out).not.toContain("gone");
  });

  it("preserves boilerplate phrases inside real prose", () => {
    const body =
      "<article><h1>Authentication</h1>" +
      "<p>We use cookies to authenticate API requests and keep sessions safe.</p>" +
      `<p>${"Additional documentation content to select the article. ".repeat(8)}</p></article>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("We use cookies to authenticate API requests");
  });

  it("drops standalone and stacked furniture lines", () => {
    const body =
      "<article>" +
      "<p>Skip to content</p>" +
      "<p>You signed in with another tab or window. Reload to refresh your session.</p>" +
      `<p>Real README body. ${"Genuine documentation text. ".repeat(8)}</p>` +
      "</article>";
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Real README body.");
    expect(out).not.toContain("Skip to content");
    expect(out).not.toContain("Reload to refresh your session");
  });

  it("does not strip boilerplate inside code fences", () => {
    const html =
      `<body><article><p>${"Prose. ".repeat(40)}</p>` +
      "<pre>assert 'There was an error while loading' in page</pre>" +
      "</article></body>";
    const out = htmlToMarkdown(html, true);
    expect(out).toContain("There was an error while loading");
  });

  it("keeps aside callouts inside the article", () => {
    const body =
      "<article><h1>Guide</h1>" +
      `<p>${"Documentation body text to select the article scope. ".repeat(6)}</p>` +
      "<aside class='admonition warning'><strong>Warning:</strong> " +
      "This operation is destructive and cannot be undone.</aside>" +
      "<p>Trailing paragraph.</p></article>";
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("This operation is destructive and cannot be undone.");
    expect(out).toContain("Warning:");
    const outFull = htmlToMarkdown(`<body>${body}</body>`);
    expect(outFull).toContain("This operation is destructive and cannot be undone.");
  });
});

describe("implicit-close and nested hidden regions", () => {
  it("closes a hidden paragraph with an unclosed inline child at a block", () => {
    const html = "<body><p hidden><span>secret<div>visible div</div><p>visible paragraph</body>";
    const out = htmlToMarkdown(html);
    expect(out).not.toContain("secret");
    expect(out).toContain("visible div");
    expect(out).toContain("visible paragraph");
  });

  it("closes a hidden list item with an inline child at the next item", () => {
    const html = "<body><ul><li hidden><span>secret<li>visible item</ul><p>after</p></body>";
    const out = htmlToMarkdown(html);
    expect(out).not.toContain("secret");
    expect(out).toContain("visible item");
    expect(out).toContain("after");
  });

  it("does not leak children of a hidden list item across a nested ul", () => {
    const html =
      "<body><ul>" +
      "<li hidden>parent<ul><li>secret child</li></ul></li>" +
      "<li>visible sibling</li>" +
      "</ul></body>";
    const out = htmlToMarkdown(html);
    expect(out).not.toContain("parent");
    expect(out).not.toContain("secret child");
    expect(out).toContain("visible sibling");
  });

  it("stays suppressed with omitted closes in doubly nested lists", () => {
    const html =
      "<body><ul>" +
      "<li hidden>parent<ul><li>secret child<ul><li>deeper secret</ul></li></ul>" +
      "<li>visible sibling" +
      "</ul></body>";
    const out = htmlToMarkdown(html);
    expect(out).not.toContain("parent");
    expect(out).not.toContain("secret child");
    expect(out).not.toContain("deeper secret");
    expect(out).toContain("visible sibling");
  });

  it("does not leak hidden table cells across a nested table", () => {
    const html =
      "<body><table><tr>" +
      "<td hidden>outer<table><tr><td>secret cell</td></tr></table></td>" +
      "<td>visible cell</td>" +
      "</tr></table></body>";
    const out = htmlToMarkdown(html);
    expect(out).not.toContain("secret cell");
    expect(out).toContain("visible cell");
  });
});

describe("article-vs-main selection", () => {
  it("does not let tiny article cards displace a substantial main", () => {
    const cards = Array.from(
      { length: 12 },
      (_, i) => `<article><h2>Teaser ${i}</h2><p>Advertisement card blurb.</p></article>`,
    ).join("");
    const mainBody = "Authoritative main documentation content. ".repeat(30);
    const html = `<body>${cards}<main><h1>Real page</h1><p>${mainBody}</p></main></body>`;
    const out = htmlToMarkdown(html, true);
    expect(out).toContain("Authoritative main documentation content.");
    expect(out).not.toContain("Advertisement card blurb.");
  });

  it("prefers a single substantial article over main furniture", () => {
    const articleBody = "Real README documentation body text. ".repeat(20);
    const html =
      "<body><main>" +
      `<article><h1>Guide</h1><p>${articleBody}</p></article>` +
      "<div><h2>Languages</h2><p>JavaScript 89.3%</p></div>" +
      "</main></body>";
    const out = htmlToMarkdown(html, true);
    expect(out).toContain("Real README documentation body text.");
    expect(out).not.toContain("JavaScript 89.3%");
  });

  it("scores truncated open article scopes", () => {
    const chrome = "<nav>Skip to content</nav><div>Repository file tree and page chrome.</div>";
    const articleBody = "Real README documentation body text. ".repeat(20);
    const html = `<body>${chrome}<article><h1>Guide</h1><p>${articleBody}</p>`;
    const out = htmlToMarkdown(html, true);
    expect(out).toContain("Real README documentation body text.");
    expect(out).not.toContain("Repository file tree and page chrome.");
  });

  it("scores truncated open main scopes", () => {
    const chrome = "<nav>Skip to content</nav><div>Repository file tree and page chrome.</div>";
    const mainBody = "Authoritative main documentation content. ".repeat(30);
    const html = `<body>${chrome}<main><h1>Doc</h1><p>${mainBody}</p>`;
    const out = htmlToMarkdown(html, true);
    expect(out).toContain("Authoritative main documentation content.");
    expect(out).not.toContain("Repository file tree and page chrome.");
  });
});

describe("header link-density stripping", () => {
  it("does not let an in-main language list displace the article", () => {
    const body =
      `<main><header><h1>Cat</h1><div id='p-lang-btn'><ul>${interlanguageList(300)}</ul></div></header>` +
      `<div id='mw-content-text'><p>${"The cat (Felis catus) is a small mammal. ".repeat(30)}</p></div></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Felis catus");
    expect(out).not.toContain("Lang0");
    expect(out).not.toContain("x0.wikipedia.org");
    expect(out).toContain("# Cat");
    expect(out.indexOf("Felis catus")).toBeLessThan(200);
  });

  it("keeps the title when the article is shorter than its language list", () => {
    const body = `<main><header><h1>Stub</h1><ul>${interlanguageList(300)}</ul></header><p>${"Short article body. ".repeat(15)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Short article body.");
    expect(out).not.toContain("Lang0");
    expect(out).toContain("# Stub");
  });

  it("reduces a link-only article header to its heading", () => {
    const body = `<article><header><h1>Post title</h1><ul>${interlanguageList(300)}</ul></header><p>${"Real article content. ".repeat(40)}</p></article>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("# Post title");
    expect(out).toContain("Real article content.");
    expect(out).not.toContain("Lang0");
  });

  it("keeps article header bylines and dates", () => {
    const body =
      "<article><header><h1>Why Rust</h1><p>By Jane Doe</p>" +
      "<time>2026-07-12</time><p>A summary of what this essay argues.</p></header>" +
      `<p>${"Real article content. ".repeat(40)}</p></article>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("# Why Rust");
    expect(out).toContain("By Jane Doe");
    expect(out).toContain("2026-07-12");
    expect(out).toContain("A summary of what this essay argues.");
  });

  it("leaves small link headers alone", () => {
    const body =
      "<article><header><h1>Post title</h1>" +
      "<a href='/subscribe'>Subscribe now</a></header>" +
      `<p>${"Real article content. ".repeat(40)}</p></article>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Subscribe now");
    expect(out).toContain("Real article content.");
  });

  it("does not let an unclosed header swallow the body", () => {
    const body = `<main><header><h1>Title</h1><p>${"Article body text. ".repeat(40)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Article body text.");
    expect(out).toContain("Title");
  });

  it("keeps the body of an unclosed heading-rich header", () => {
    const sections = Array.from(
      { length: 12 },
      (_, i) => `<h2>Section ${i}</h2><p>${"Body prose here. ".repeat(10)}</p>`,
    ).join("");
    const body = `<main><header><h1>T</h1>${sections}</main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Body prose here.");
    expect(out).toContain("Section 0");
  });

  it("applies header stripping without article or main", () => {
    const body = `<header><h1>Site name</h1><ul>${interlanguageList(300)}</ul></header><p>${"Page prose without a main landmark. ".repeat(20)}</p>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Page prose without a main landmark.");
    expect(out).toContain("# Site name");
    expect(out).not.toContain("Lang0");
  });

  it("keeps headers in unscoped conversions", () => {
    const body = "<header><h1>Site</h1><a href='/x'>Nav link</a></header><p>Text.</p>";
    const out = htmlToMarkdown(`<body>${body}</body>`);
    expect(out).toContain("Nav link");
    expect(out).toContain("Text.");
  });

  it("keeps the body of a truncated scope with an open header", () => {
    const sections = Array.from(
      { length: 12 },
      (_, i) => `<h2>Section ${i} of the article</h2><p>${'Body prose here. '.repeat(10)}</p>`,
    ).join("");
    const out = htmlToMarkdown(`<body><main><header><h1>T</h1>${sections}`, true);
    expect(out).toContain("Body prose here.");
    expect(out).toContain("Section 0 of the article");
  });

  it("does not let a sibling card beat an article with a swallowed body", () => {
    const real = `<article><header><h1>Real</h1><p>${"Real article body. ".repeat(40)}</p></article>`;
    const card = `<article><p>${"Related card teaser. ".repeat(12)}</p></article>`;
    const out = htmlToMarkdown(`<body>${real}${card}</body>`, true);
    expect(out).toContain("Real article body.");
    expect(out).not.toContain("Related card teaser.");
  });

  it("keeps a text-heavy header even when longer than the body", () => {
    const body = `<main><header><h1>Title</h1><p>${"Introductory hero text. ".repeat(30)}</p></header><p>${"The real body prose. ".repeat(20)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("The real body prose.");
    expect(out).toContain("Introductory hero text.");
    expect(out).toContain("# Title");
  });

  it("keeps the body when an unclosed link in an unclosed header adopts it", () => {
    const body = `<main><header><h1>Title</h1><a href='/'>Home<p>${"Article body text. ".repeat(40)}</p>`;
    const out = htmlToMarkdown(`<body>${body}`, true);
    expect(out).toContain("Article body text.");
    expect(out).toContain("# Title");
  });

  it("does not hand the scope to a sibling card via an unclosed link", () => {
    const real = `<article><header><h1>Real</h1><a href='/'>Home<p>${"REAL ".repeat(60)}</p></article>`;
    const card = `<article><p>${"CARD ".repeat(30)}</p></article>`;
    const out = htmlToMarkdown(`<body>${real}${card}</body>`, true);
    expect(out).toContain("REAL");
    expect(out).not.toContain("CARD");
  });

  it("does not lose entity-encoded bodies to an unclosed header", () => {
    const out = htmlToMarkdown(`<body><main><header><h1>T</h1><p>${"&alpha;".repeat(400)}</p>`, true);
    expect(out.split("α").length - 1).toBe(400);
  });

  it("keeps a header closed by an ancestor whole", () => {
    const body = `<div><header><h1>Site</h1><ul>${interlanguageList(300)}</ul></div><p>${"The real body prose. ".repeat(20)}</p>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("The real body prose.");
    expect(out).toContain("# Site");
    expect(out).toContain("Lang0");
  });

  it("does not strip a short adopted article for an unclosed header", () => {
    const body = `<main><header><h1>T</h1><ul>${interlanguageList(300)}</ul><p>${"Short real article. ".repeat(4)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Short real article.");
  });

  it("keeps a heading inside a nested buffer and strips the links", () => {
    const body =
      `<main><header><blockquote><h1>Page Title</h1></blockquote><ul>${interlanguageList(400)}</ul></header>` +
      `<p>${"Article body. ".repeat(30)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Page Title");
    expect(out).not.toContain("Lang0");
    expect(out.indexOf("Article body.")).toBeLessThan(16000);
  });

  it("counts long hrefs toward the header size floor", () => {
    const nav = Array.from(
      { length: 30 },
      (_, i) => `<a href="https://e.com/p?${"q".repeat(1000)}=${i}">L${i}</a>`,
    ).join("");
    const body = `<main><header>${nav}</header><p>${"Article body. ".repeat(30)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).not.toContain("L0");
    expect(out.indexOf("Article body.")).toBeLessThan(16000);
  });

  it("does not let a linked heading condemn the byline beside it", () => {
    const body =
      `<article><header><h1><a href='/p'>${"A Very Long Linked Headline About Assorted Things In The World Today ".repeat(5)}</a></h1>` +
      `<p>By Jane Doe, July 2026</p></header><p>${"Article body. ".repeat(30)}</p></article>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("By Jane Doe");
    expect(out).toContain("Very Long Linked");
  });

  it("treats an anchor without href as prose, not link furniture", () => {
    const body =
      `<article><header><h1>T</h1><a name='intro'>${"Introductory prose that renders as plain text. ".repeat(8)}</a>` +
      `<p>Byline</p></header><p>${"Article body. ".repeat(30)}</p></article>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Introductory prose");
    expect(out).toContain("Byline");
  });

  it("does not emit a linked heading twice", () => {
    const body =
      `<main><header><h1><a href='/post'>Title</a></h1><ul>${interlanguageList(300)}</ul></header>` +
      `<p>${"Article body. ".repeat(30)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("# [Title](/post)");
    expect(out.split("Title").length - 1).toBe(1);
  });

  it("lets an article beat a bigger card after its header goes", () => {
    const real = `<article><header><h1>Real</h1><ul>${interlanguageList(300)}</ul></header><p>${"Short real body. ".repeat(14)}</p></article>`;
    const card = `<article><p>${"Related card teaser text here. ".repeat(12)}</p></article>`;
    const out = htmlToMarkdown(`<body>${real}${card}</body>`, true);
    expect(out).toContain("Short real body.");
    expect(out).not.toContain("Related card teaser");
  });

  it("does not let a furniture-only card suppress the main it sits in", () => {
    const card =
      `<article><header>${Array.from({ length: 120 }, (_, i) => `<a href="/l${i}">Language ${i}</a>`).join("")}</header>` +
      "<p>Short teaser about the related thing, read more.</p></article>";
    const body = `<p>${"The real article body the reader wants. ".repeat(40)}</p>`;
    const out = htmlToMarkdown(`<body><main>${body}${card}</main></body>`, true);
    expect(out).toContain("The real article body the reader wants.");
    expect(out).not.toContain("Language 7");
  });

  it("does not let a long heading href condemn the rest of the header", () => {
    const body =
      `<article><header><h1><a href='/p?${"q".repeat(900)}'>Title</a></h1>` +
      `<a href='/author/jane'>Jane</a></header><p>${"Article body. ".repeat(30)}</p></article>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Title");
    expect(out).toContain("Jane");
  });

  it("terminates a preserved heading", () => {
    const body = `<main><header><h1>Title</h1><ul>${interlanguageList(300)}</ul></header>Article body text here.</main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).not.toContain("# TitleArticle");
    expect(out.startsWith("# Title")).toBe(true);
    expect(out).toContain("Article body text here.");
  });

  it("does not let a furniture-only scope win or blank the page", () => {
    const body = `<main><header><ul>${interlanguageList(300)}</ul></header></main><p>${"Real page body prose. ".repeat(30)}</p>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Real page body prose.");
  });

  it("renders a header inside an enclosing link once", () => {
    const body = `<main><a href='/x'><header><h1>T</h1></header></a><p>${"Article body. ".repeat(30)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out.split("[# T](/x)").length - 1).toBe(1);
  });

  it("keeps a table nested in a header inside a cell identical to unscoped", () => {
    const html = "<table><tr><td><header><table><tr><td>x</td></tr></table></header></td></tr></table>";
    expect(htmlToMarkdown(`<body>${html}</body>`, true)).toBe(htmlToMarkdown(`<body>${html}</body>`));
  });

  it("keeps source order for a truncated header and blockquote", () => {
    const out = htmlToMarkdown("<body><main><header><h1>Title</h1><blockquote>Quote", true);
    expect(out.indexOf("Title")).toBeLessThan(out.indexOf("Quote"));
  });

  it("does not let a stub outrank a real article on removed navigation", () => {
    const stub = `<article><header><h1>${"A Long Title That Exceeds Fifty Characters Easily Here"}</h1><ul>${interlanguageList(300)}</ul></header></article>`;
    const real = `<article><p>${"Genuine full article body text. ".repeat(20)}</p></article>`;
    const out = htmlToMarkdown(`<body>${stub}${real}</body>`, true);
    expect(out).toContain("Genuine full article body");
  });

  it("counts an unclosed link in a closed header as furniture", () => {
    const body = `<main><header><h1>T</h1><a href='/nav'>${"Navigation label text. ".repeat(20)}</header><p>${"Article body. ".repeat(30)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).not.toContain("Navigation label text.");
    expect(out).toContain("Article body.");
  });

  it("counts enclosing anchor text toward header density", () => {
    const body = `<main><a href='/nav'><header>${Array.from({ length: 40 }, (_, i) => `<span>Nav label ${i}</span>`).join("")}</header></a><p>${"Article body. ".repeat(30)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).not.toContain("Nav label 0");
    expect(out).toContain("Article body.");
  });

  it("flushes a truncated header into its enclosing buffer", () => {
    expect(htmlToMarkdown("<body><main><a href='/x'>before<header><h1>Title", true).startsWith("[before")).toBe(true);
    expect(htmlToMarkdown("<body><main><table><tr><td><header><h1>Title", true).startsWith("|")).toBe(true);
  });

  it("does not let empty blocks inflate the header size", () => {
    const body =
      `<article><header><h1>${"A Fairly Long Heading Title Here".repeat(2)}</h1>${"<div></div>".repeat(500)}<a href='/x'>L</a></header></article>` +
      `<article><p>${"Genuine full article body text. ".repeat(20)}</p></article>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Genuine full article body");
  });

  it("does not count a blockquoted heading as retained prose", () => {
    const stub =
      `<article><blockquote><header><h1>${"A Long Title That Exceeds Fifty Characters Easily Here"}</h1><ul>${interlanguageList(300)}</ul></header></blockquote></article>`;
    const real = `<article><p>${"Genuine full article body text. ".repeat(20)}</p></article>`;
    const out = htmlToMarkdown(`<body>${stub}${real}</body>`, true);
    expect(out).toContain("Genuine full article body");
  });

  it("does not indent the body after a list left open in a header", () => {
    const body = `<main><header><h1>T</h1><ul>${interlanguageList(300)}</header><ul><li>Body item one</li></ul></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    const item = out.split("\n").find((line) => line.includes("Body item one"))!;
    expect(item.startsWith("*")).toBe(true);
  });

  it("keeps linked heading text counted once for the size floor", () => {
    const body =
      `<article><header><h1><a href='/p'>${"Headline word ".repeat(60)}</a></h1>` +
      `<a href='/author'>Jane</a></header><p>${"Article body. ".repeat(30)}</p></article>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Jane");
  });

  it("counts fenced code as retained content", () => {
    const code = `<pre>${Array.from({ length: 16 }, (_, i) => `# comment line ${i}`).join("\n")}</pre>`;
    const article = `<article><header><h1>T</h1><ul>${interlanguageList(300)}</ul></header>${code}</article>`;
    const sibling = `<article><p>${"Sibling teaser text here. ".repeat(12)}</p></article>`;
    const out = htmlToMarkdown(`<body>${article}${sibling}</body>`, true);
    expect(out).toContain("comment line 1");
    expect(out).not.toContain("Sibling teaser");
  });

  it("does not let dropped furniture dominate sibling ranking", () => {
    const teaser =
      `<article><header>${Array.from({ length: 1000 }, (_, i) => `<a href="/l${i}">Lang${i}</a>`).join("")}</header>` +
      `<p>${"Teaser words here. ".repeat(20)}</p></article>`;
    const real = `<article><p>${"The genuine article body text goes here. ".repeat(55)}</p></article>`;
    const out = htmlToMarkdown(`<body>${teaser}${real}</body>`, true);
    expect(out).toContain("The genuine article body text goes here.");
    expect(out).not.toContain("Teaser words here.");
  });

  it("treats literal bracket-paren as prose, not a destination", () => {
    const article = `<article><p>${"Real article prose that the reader wants to see. ".repeat(3)}](${"y".repeat(100)}) Tail prose to finish the paragraph off here.</p></article>`;
    const sibling = `<article><p>${"Unrelated sibling teaser words. ".repeat(8)}</p></article>`;
    const out = htmlToMarkdown(`<body>${article}${sibling}</body>`, true);
    expect(out).toContain("Real article prose that the reader wants to see.");
    expect(out).not.toContain("Unrelated sibling teaser");
  });

  it("reaches the eligibility tally for hand-preserved headings", () => {
    const card =
      `<article><header><a href="/h"><div role="heading">${"Card Title Words ".repeat(14)}</div>${"nav text ".repeat(40)}</a><ul>${interlanguageList(300)}</ul></header></article>`;
    const real = `<p>${"The real page body text here. ".repeat(30)}</p>`;
    const out = htmlToMarkdown(`<body><main>${real}${card}</main></body>`, true);
    expect(out).toContain("The real page body text here.");
  });

  it("drains a pre inside a table cell before the row", () => {
    const body = `<main><header><h1>T</h1><table><tr><td><pre>CODEMARKER</header><p>${"Article body. ".repeat(30)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).not.toContain("CODEMARKER|");
    expect(out).toContain("Article body.");
  });

  it("respects the widened fence in post-processing", () => {
    const code = `<pre>${"```"}\nskip to content\n\nreal code line   \nmore code</pre>`;
    const body = `<article>${code}<p>${"Body text here. ".repeat(20)}</p></article>`;
    const out = htmlToMarkdown(`<body><main>${body}</main></body>`, true);
    expect(out).toContain("skip to content");
    expect(out).toContain("skip to content\n\nreal code line");
    expect(out).toContain("real code line   ");
  });

  it("keeps scoring the rest of a line after an unbalanced destination", () => {
    const article = `<article><p><a href="/docs/(draft">Doc</a> ${"Substantial article prose continues here. ".repeat(6)}</p></article>`;
    const sibling = `<article><p>${"Sibling teaser text. ".repeat(12)}</p></article>`;
    const out = htmlToMarkdown(`<body>${article}${sibling}</body>`, true);
    expect(out).toContain("Substantial article prose continues here.");
    expect(out).not.toContain("Sibling teaser");
  });

  it("does not let structural headings satisfy the eligibility gate", () => {
    const card = `<article><header><div role="heading">${"Card Title Words ".repeat(14)}</div><ul>${interlanguageList(300)}</ul></header></article>`;
    const real = `<article><p>${"The real article body text here. ".repeat(20)}</p></article>`;
    const out = htmlToMarkdown(`<body>${real}${card}</body>`, true);
    expect(out).toContain("The real article body text here.");
    expect(out).not.toContain("Card Title Words");
  });

  it("preserves only the heading when an anchor wraps a heading and nav", () => {
    const bulk = Array.from({ length: 1200 }, (_, i) => `NavWord${String(i).padStart(4, "0")}`).join(" ");
    const body =
      `<main><header><a href="/home"><h1>Title</h1>${bulk}</a><ul>${interlanguageList(300)}</ul></header>` +
      `<p>${"Article body. ".repeat(30)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Title");
    expect(out).not.toContain("NavWord0000");
    expect(out.indexOf("Article body.")).toBeLessThan(16000);
  });

  it("balances parentheses in link destination scans", () => {
    const query = "utm_source=x&".repeat(25);
    const card =
      `<article><header>${Array.from({ length: 120 }, (_, i) => `<a href="/l${i}">Lang${i}</a>`).join("")}</header>` +
      `<p><a href="/card(foo)?${query}">Read</a></p></article>`;
    const real = `<article><p>${"The genuine article body text here. ".repeat(20)}</p></article>`;
    const out = htmlToMarkdown(`<body>${real}${card}</body>`, true);
    expect(out).toContain("The genuine article body text here.");
    expect(out).not.toContain("/card(foo)?");
  });

  it("does not end the code region on a literal fence inside pre", () => {
    const code = `<pre>${"```"}\n${Array.from({ length: 20 }, (_, i) => `# code line ${i}`).join("\n")}</pre>`;
    const article = `<article><header><h1>T</h1><ul>${interlanguageList(300)}</ul></header>${code}</article>`;
    const sibling = `<article><p>${"Sibling teaser text here. ".repeat(12)}</p></article>`;
    const out = htmlToMarkdown(`<body>${article}${sibling}</body>`, true);
    expect(out).toContain("code line 1");
    expect(out).not.toContain("Sibling teaser");
  });

  it("emits a heading through a nested buffer once", () => {
    const body =
      `<main><header><div role="heading"><blockquote>UniqueTitle</blockquote></div><ul>${interlanguageList(300)}</ul></header>` +
      `<p>${"Article body. ".repeat(30)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out.split("UniqueTitle").length - 1).toBe(1);
  });

  it("treats a late code end tag after a recovered header as a no-op", () => {
    const body = `<main><header><h1>T</h1><code>navcode<ul>${interlanguageList(300)}</ul></header><p>${"Article body. ".repeat(30)}</p></code></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out.split("`").length % 2).toBe(1);
    expect(out).toContain("Article body.");
  });

  it("sizes header text after whitespace collapses", () => {
    const byline = `<a href="/a">Jane${" ".repeat(300)}Doe</a><time>July 2026</time>`;
    const body = `<main><header><h1>T</h1>${byline}</header><p>${"Article body. ".repeat(30)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Jane Doe");
    expect(out).toContain("July 2026");
  });

  it("does not count link destinations as retained prose", () => {
    const query = "utm_source=x&".repeat(25);
    const card =
      `<article><header>${Array.from({ length: 120 }, (_, i) => `<a href="/l${i}">Lang${i}</a>`).join("")}</header>` +
      `<p><a href="/card?${query}">Read</a></p></article>`;
    const real = `<article><p>${"The genuine article body text here. ".repeat(20)}</p></article>`;
    const out = htmlToMarkdown(`<body>${real}${card}</body>`, true);
    expect(out).toContain("The genuine article body text here.");
    expect(out).not.toContain("/card?");
  });

  it("does not replay a recovered pre block on a late end tag", () => {
    const body = `<main><header><h1>T</h1><ul>${interlanguageList(300)}</ul><pre>${"NAVJUNK_MARKER\n".repeat(3)}</header><p>${"Article body. ".repeat(30)}</p></pre></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).not.toContain("NAVJUNK_MARKER");
    expect(out.indexOf("Article body.")).toBeLessThan(16000);
  });

  it("accepts a fallback role token list for aria headings", () => {
    expect(isAriaHeading({ role: "heading" })).toBe(true);
    expect(isAriaHeading({ role: "future-role heading" })).toBe(true);
    expect(isAriaHeading({ role: "HEADING" })).toBe(true);
    expect(isAriaHeading({ role: "banner" })).toBe(false);
    expect(isAriaHeading({})).toBe(false);
    const body =
      `<main><header><div role="future-role heading">Page Title</div><ul>${interlanguageList(300)}</ul></header>` +
      `<p>${"Article body. ".repeat(30)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out).toContain("Page Title");
    expect(out).not.toContain("Lang0");
  });

  it("keeps a heading through a stripped header however it is expressed", () => {
    const cases: [string, string][] = [
      ["<h1>Page Title</h1>", "Page Title"],
      ["<table><tr><td><h1>Page Title</h1></td></tr></table>", "Page Title"],
      ["<div role='heading' aria-level='1'>Page Title</div>", "Page Title"],
      ["<a role='heading' href='/title'>Page Title</a>", "Page Title"],
      ["<a href='/post'><h1>Page Title</h1></a>", "Page Title"],
      ["<hgroup><h1>Title</h1><p>Subtitle here</p></hgroup>", "Subtitle here"],
    ];
    for (const [headingMarkup, marker] of cases) {
      const body = `<main><header>${headingMarkup}<ul>${interlanguageList(300)}</ul></header><p>${"Article body. ".repeat(30)}</p></main>`;
      const out = htmlToMarkdown(`<body>${body}</body>`, true);
      expect(out).toContain(marker);
      expect(out).not.toContain("Lang0");
      expect(out).toContain("Article body.");
    }
  });

  it("strips link lists through nested buffers", () => {
    const variants = [
      `<main><blockquote><header><h1>T</h1><ul>${interlanguageList(300)}</ul></header></blockquote><p>{body}</p></main>`,
      `<main><header><h1>T</h1><blockquote><ul>${interlanguageList(300)}</ul></header><p>{body}</p></main>`,
      `<main><header><h1>T</h1><table><tr><td><ul>${interlanguageList(300)}</ul></header><p>{body}</p></main>`,
    ];
    for (const template of variants) {
      const html = template.replace("{body}", "Article body. ".repeat(30));
      const out = htmlToMarkdown(`<body>${html}</body>`, true);
      expect(out).not.toContain("Lang0");
      expect(out.indexOf("Article body.")).toBeLessThan(16000);
    }
  });

  it("lets hash-prefixed prose win its scope", () => {
    const lines = Array.from({ length: 14 }, (_, i) => `<p>#include &lt;header_${String(i).padStart(2, "0")}.h&gt;</p>`).join("");
    const article = `<article><header><h1>T</h1><ul>${interlanguageList(300)}</ul></header>${lines}</article>`;
    const sibling = `<article><p>${"Sibling teaser text here. ".repeat(12)}</p></article>`;
    const out = htmlToMarkdown(`<body>${article}${sibling}</body>`, true);
    expect(out).toContain("#include");
    expect(out).not.toContain("Sibling teaser");
  });

  it("sizes a header independently of the buffer it renders through", () => {
    const links = Array.from(
      { length: 14 },
      (_, i) => `<a href="/very/long/section/path/number/${String(i).padStart(3, "0")}/index">L${String(i).padStart(3, "0")}</a>`,
    ).join("");
    const wrapped = {
      bare: links,
      blockquote: `<blockquote>${links}</blockquote>`,
      cell: `<table><tr><td>${links}</td></tr></table>`,
    };
    const kept = new Set<boolean>();
    for (const inner of Object.values(wrapped)) {
      const body = `<main><header><h1>T</h1>${inner}</header><p>${"Article body. ".repeat(30)}</p></main>`;
      kept.add(htmlToMarkdown(`<body>${body}</body>`, true).includes("L000"));
    }
    expect(kept.size).toBe(1);
  });

  it("closes every inline code span it opened", () => {
    const body = `<main><article><p><code><code>x</code></code></p><p>${"Body text here. ".repeat(20)}</p></article></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out.split("`").length % 2).toBe(1);
    expect(out).toContain("``x``");
  });

  it("pairs delimiters when a header sits inside open inline code", () => {
    const body = `<main><code>head<header><h1>T</h1></header>tail</code><p>${"Article body. ".repeat(30)}</p></main>`;
    const out = htmlToMarkdown(`<body>${body}</body>`, true);
    expect(out.split("`").length % 2).toBe(1);
    expect(out).not.toContain("`head`");
    expect(out).toContain("Article body.");
  });

  it("handles deeply nested headers without quadratic cost", () => {
    const chunk = `<p>${"filler text here. ".repeat(100)}</p>`;
    const build = (depth: number) =>
      `<body><main>${"<header>" + chunk}</header>`.repeat(0) +
      "<body><main>" +
      `<header>${chunk}`.repeat(depth) +
      "</header>".repeat(depth) +
      "<p>body</p></main></body>";
    const timings: number[] = [];
    for (const depth of [20, 80]) {
      const start = performance.now();
      htmlToMarkdown(build(depth), true);
      timings.push(performance.now() - start);
    }
    expect(timings[1]).toBeLessThan(timings[0] * 12 + 100);
  });

  it("stays linear on deeply nested tags", () => {
    const build = (count: number) =>
      "<body><main>" +
      "<header><h1>T</h1>".repeat(count) +
      "</header>".repeat(count) +
      "<p>body</p></main></body>";
    const timings: number[] = [];
    for (const count of [1000, 4000]) {
      const start = performance.now();
      htmlToMarkdown(build(count), true);
      timings.push(performance.now() - start);
    }
    expect(timings[1]).toBeLessThan(timings[0] * 12 + 100);
  });
});
