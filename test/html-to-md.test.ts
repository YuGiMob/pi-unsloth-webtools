import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../html-to-md.ts";
import { isAriaHeading } from "../html-to-md.ts";

const GITHUB_HIDDEN_ERROR_BLOCK = `
<div data-show-on-forbidden-error hidden>
  <div class="Box">
    <div class="blankslate-container">
      <h3 class="blankslate-heading">Uh oh!</h3>
      <p class="blankslate-description">
        <p class="color-fg-muted my-2 mb-2 ws-normal">There was an error while loading.
        <a class="Link--inTextBlock" href="" aria-label="Please reload this page">Please reload this page</a>.</p>
      </p>
    </div>
  </div>
</div>
`;

const GITHUB_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><title>unslothai/unsloth</title></head>
<body>
<a class="px-2 py-4" href="#start-of-content">Skip to content</a>
<header class="Header-old">
  <div class="AppHeader-globalBar">
    <a href="/login">Sign in</a>
    <a href="/signup">Sign up</a>
  </div>
</header>
<div class="js-notification-shelf"></div>
<div hidden>
  You signed in with another tab or window. Reload to refresh your session.
  You signed out in another tab or window. Reload to refresh your session.
  You switched accounts on another tab or window. Reload to refresh your session.
  Dismiss alert
</div>
<template>{{ message }}</template>
${GITHUB_HIDDEN_ERROR_BLOCK}
<main id="js-repo-pjax-container">
  ${GITHUB_HIDDEN_ERROR_BLOCK}
  <div id="repository-container-header">
    <a href="/unslothai">unslothai</a> / <a href="/unslothai/unsloth">unsloth</a>
    <a href="/login?return_to=%2Funslothai%2Funsloth">Notifications</a>
    You must be signed in to change notification settings
  </div>
  <div class="repository-content">
    <table aria-labelledby="folders-and-files">
      <tr><th>Name</th><th>Last commit message</th></tr>
      <tr><td><a href="/unslothai/unsloth/tree/main/unsloth">unsloth</a></td><td></td></tr>
    </table>
    <article class="markdown-body entry-content container-lg" itemprop="text">
      <h1>Unsloth Studio</h1>
      <p>Unsloth Studio lets you run and train models locally. Fine-tune and
      run LLMs on Windows, Linux and macOS with a single install command,
      then export to GGUF, Ollama, vLLM or Hugging Face when you are done.</p>
      <h2>Install</h2>
      <pre>curl -fsSL https://unsloth.ai/install.sh | sh</pre>
      <p>See the <a href="https://unsloth.ai/docs">documentation</a> for
      quickstarts, notebooks, and fine-tuning guides for every major model
      family including Llama, Gemma, Qwen and DeepSeek.</p>
    </article>
  </div>
  <div class="Layout-sidebar">
    <h2>Languages</h2>
    <ul>
      <li><a href="/unslothai/unsloth/search?l=javascript">JavaScript 89.3%</a></li>
      <li><a href="/unslothai/unsloth/search?l=python">Python 9.7%</a></li>
    </ul>
  </div>
</main>
<footer>
  <a href="https://docs.github.com">Docs</a>
  <a href="https://github.com/contact">Contact</a>
</footer>
<div aria-live="polite" aria-hidden="true">You can't perform that action at this time.</div>
</body>
</html>
`;

describe("html_to_markdown hidden elements", () => {
  it("drops hidden attribute subtrees", () => {
    const html = "<body><p>visible</p><div hidden><p>secret error text</p></div><p>after</p></body>";
    const out = htmlToMarkdown(html);
    expect(out).toContain("visible");
    expect(out).toContain("after");
    expect(out).not.toContain("secret error text");
  });

  it("drops aria-hidden=true subtrees", () => {
    const html = '<body><p>keep</p><span aria-hidden="true">decoration</span></body>';
    const out = htmlToMarkdown(html);
    expect(out).toContain("keep");
    expect(out).not.toContain("decoration");
  });

  it("keeps aria-hidden=false subtrees", () => {
    const html = '<body><span aria-hidden="false">still here</span></body>';
    expect(htmlToMarkdown(html)).toContain("still here");
  });

  it("drops display:none inline-style subtrees", () => {
    const html =
      "<body><p>visible</p>" +
      '<div style="display:none">secret loading block</div>' +
      "<p>after</p></body>";
    const out = htmlToMarkdown(html);
    expect(out).toContain("visible");
    expect(out).toContain("after");
    expect(out).not.toContain("secret loading block");
  });

  it("drops visibility:hidden inline-style subtrees", () => {
    const html = '<body><p>keep</p><span style="visibility:hidden">ghost</span></body>';
    const out = htmlToMarkdown(html);
    expect(out).toContain("keep");
    expect(out).not.toContain("ghost");
  });

  it("drops display:none !important subtrees", () => {
    const html = '<body><p>keep</p><div style="display:none !important">gone</div></body>';
    const out = htmlToMarkdown(html);
    expect(out).toContain("keep");
    expect(out).not.toContain("gone");
  });

  it("drops display:none among other declarations", () => {
    const html =
      '<body><p>keep</p><div style="color: red; display : none ; margin:0">gone</div></body>';
    const out = htmlToMarkdown(html);
    expect(out).toContain("keep");
    expect(out).not.toContain("gone");
  });

  it("keeps visible display and none-substring values", () => {
    const html =
      "<body>" +
      '<div style="display:block">block kept</div>' +
      '<div style="visibility:visible">visible kept</div>' +
      '<a style="background:url(none.png)">link kept</a>' +
      "</body>";
    const out = htmlToMarkdown(html);
    expect(out).toContain("block kept");
    expect(out).toContain("visible kept");
    expect(out).toContain("link kept");
  });

  it("recovers hidden regions from omitted close tags", () => {
    const html = "<body><div><p hidden>gone</div><p>kept</p></body>";
    const out = htmlToMarkdown(html);
    expect(out).not.toContain("gone");
    expect(out).toContain("kept");
  });

  it("handles nested hidden regions", () => {
    const html = "<body><div hidden><div hidden>inner</div>outer</div><p>ok</p></body>";
    const out = htmlToMarkdown(html);
    expect(out).not.toContain("inner");
    expect(out).not.toContain("outer");
    expect(out).toContain("ok");
  });

  it("treats hidden=false as hidden", () => {
    const html = '<body><p>keep</p><div hidden="false">not rendered</div></body>';
    const out = htmlToMarkdown(html);
    expect(out).toContain("keep");
    expect(out).not.toContain("not rendered");
  });

  it("implicitly closes hidden paragraphs on sibling p", () => {
    const html =
      "<body><div><p hidden>secret<p>visible one</p><p>visible two</p></div><p>after</p></body>";
    const out = htmlToMarkdown(html);
    expect(out).not.toContain("secret");
    expect(out).toContain("visible one");
    expect(out).toContain("visible two");
    expect(out).toContain("after");
  });

  it("implicitly closes hidden list items before following items", () => {
    const html = "<body><ul><li hidden>secret<li>shown A</li><li>shown B</li></ul></body>";
    const out = htmlToMarkdown(html);
    expect(out).not.toContain("secret");
    expect(out).toContain("shown A");
    expect(out).toContain("shown B");
  });

  it("closes hidden paragraphs on hr", () => {
    const html = "<body><p hidden>secret<hr>kept text</body>";
    const out = htmlToMarkdown(html);
    expect(out).not.toContain("secret");
    expect(out).toContain("kept text");
  });

  it("closes hidden paragraphs on skipped tags", () => {
    for (const skipped of ["nav", "footer"]) {
      const html = `<body><p hidden>secret<${skipped}>chrome</${skipped}>VISIBLE</body>`;
      const out = htmlToMarkdown(html);
      expect(out).not.toContain("secret");
      expect(out).not.toContain("chrome");
      expect(out).toContain("VISIBLE");
    }
  });

  it("suppresses hidden void elements", () => {
    const html = '<body><p>before</p><hr aria-hidden="true"><p>after</p></body>';
    const out = htmlToMarkdown(html);
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).not.toContain("---");
  });

  it("suppresses hidden br", () => {
    const html = "<body><p>one<br hidden>two</p></body>";
    const out = htmlToMarkdown(html);
    expect(out).toContain("one");
    expect(out).toContain("two");
    expect(out).not.toContain("one\ntwo");
  });

  it("renders visible hr", () => {
    const html = "<body><p>a</p><hr><p>b</p></body>";
    expect(htmlToMarkdown(html)).toContain("---");
  });

  it("detects role=heading", () => {
    expect(isAriaHeading({ role: "heading" })).toBe(true);
    expect(isAriaHeading({ role: "future-role heading" })).toBe(true);
    expect(isAriaHeading({})).toBe(false);
  });
});

describe("html_to_markdown main-content scoping", () => {
  it("keeps only the README from a GitHub repo page", () => {
    const out = htmlToMarkdown(GITHUB_PAGE, true);
    expect(out).toContain("Unsloth Studio");
    expect(out).toContain("install.sh");
    expect(out).toContain("documentation");
    expect(out).not.toContain("Uh oh!");
    expect(out).not.toContain("There was an error while loading");
    expect(out).not.toContain("Please reload this page");
    expect(out).not.toContain("You can't perform that action at this time");
    expect(out).not.toContain("Skip to content");
    expect(out).not.toContain("Sign in");
    expect(out).not.toContain("Reload to refresh your session");
    expect(out).not.toContain("JavaScript 89.3%");
    expect(out).not.toContain("Languages");
    expect(out).not.toContain("Last commit message");
  });

  it("uses main scope when there is no article", () => {
    const html = `
    <body>
      <header><a href="/login">Sign in</a></header>
      <main><h1>Doc title</h1><p>${"Body text. ".repeat(40)}</p></main>
      <footer>footer junk</footer>
    </body>
    `;
    const out = htmlToMarkdown(html, true);
    expect(out).toContain("Doc title");
    expect(out).toContain("Body text.");
    expect(out).not.toContain("Sign in");
    expect(out).not.toContain("footer junk");
  });

  it("falls back to the full document for tiny pages", () => {
    const html = "<body><h1>Tiny</h1><p>Just a short page.</p></body>";
    const out = htmlToMarkdown(html, true);
    expect(out).toContain("Tiny");
    expect(out).toContain("Just a short page.");
  });
});

describe("html_to_markdown formatting", () => {
  it("renders headings, lists, links, emphasis and code", () => {
    const html = `
      <h1>Title</h1>
      <p>Hello <strong>bold</strong> and <em>italic</em> with a <a href="https://x.com">link</a>.</p>
      <ul><li>one</li><li>two</li></ul>
      <ol><li>first</li><li>second</li></ol>
      <pre>code &lt;here&gt;</pre>
      <blockquote><p>quoted</p></blockquote>
    `;
    const out = htmlToMarkdown(html);
    expect(out).toContain("# Title");
    expect(out).toContain("**bold**");
    expect(out).toContain("*italic*");
    expect(out).toContain("[link](https://x.com)");
    expect(out).toMatch(/\* one/);
    expect(out).toMatch(/\* two/);
    expect(out).toMatch(/1\. first/);
    expect(out).toMatch(/2\. second/);
    expect(out).toContain("code <here>");
    expect(out).toContain("> quoted");
  });

  it("renders tables with a header separator", () => {
    const html =
      "<table><tr><th>Name</th><th>Count</th></tr><tr><td>a</td><td>1</td></tr></table>";
    const out = htmlToMarkdown(html);
    expect(out).toContain("| Name | Count |");
    expect(out).toContain("| --- | --- |");
    expect(out).toContain("| a | 1 |");
  });

  it("keeps fenced code verbatim during cleanup", () => {
    const html = "<pre>line1\n\n\nline2</pre>";
    const out = htmlToMarkdown(html);
    expect(out).toContain("line1");
    expect(out).toContain("line2");
  });

  it("does not treat a markdown README with a code fence as html", () => {
    const md = "# Readme\n\n```html\n<div>not a page</div>\n```";
    expect(htmlToMarkdown(md)).toContain("# Readme");
  });

  it("decodes entities", () => {
    const out = htmlToMarkdown("<p>AT&amp;T &mdash; 5 &lt; 6 &euro;</p>");
    expect(out).toContain("AT&T");
    expect(out).toContain("—");
    expect(out).toContain("5 < 6");
    expect(out).toContain("€");
  });
});

describe("raw-text scanning", () => {
  it("does not parse `<` inside inline scripts as markup", () => {
    const html =
      "<html><head>" +
      '<script>if ("u"<typeof navigator) x()</script>' +
"<style>.a { content: \"<\"; }</style>" +
      "</head><body><article><h1>Title</h1><p>Readable body text here.</p></article></body></html>";
    const out = htmlToMarkdown(html, true);
    expect(out).toContain("Title");
    expect(out).toContain("Readable body text here.");
  });

  it("keeps skip state balanced across many inline scripts", () => {
    const scripts = Array.from(
      { length: 20 },
      (_, i) => `<script>let a${i} = 1 < 2 < 3; if ("u"<typeof x) a${i}++;</script>`,
    ).join("");
    const out = htmlToMarkdown(`<body>${scripts}<p>visible prose after scripts</p></body>`);
    expect(out).toContain("visible prose after scripts");
  });

  it("matches closing raw-text tags case-insensitively", () => {
    const html =
      '<body><SCRIPT>if ("u"<typeof x) y()</SCRIPT><p>after script</p></body>';
    const out = htmlToMarkdown(html);
    expect(out).toContain("after script");
  });

  it("keeps `<` inside title and textarea content", () => {
    const html =
      "<title>a < b &amp; c</title><textarea>x < y</textarea><p>body text</p>";
    const out = htmlToMarkdown(html);
    expect(out).toContain("a < b & c");
    expect(out).toContain("x < y");
    expect(out).toContain("body text");
  });
});
