import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "../html-to-md.ts";

describe("decodeHtmlEntities parity with html.unescape", () => {
  it("decodes named references with and without semicolons", () => {
    expect(decodeHtmlEntities("&amp;")).toBe("&");
    expect(decodeHtmlEntities("&amp")).toBe("&");
    expect(decodeHtmlEntities("&lt;x&gt;")).toBe("<x>");
    expect(decodeHtmlEntities("&quot;q&quot;")).toBe('"q"');
    expect(decodeHtmlEntities("&nbsp;")).toBe("\u00a0");
    expect(decodeHtmlEntities("&copy;")).toBe("\u00a9");
    expect(decodeHtmlEntities("&mdash;")).toBe("\u2014");
    expect(decodeHtmlEntities("&apos;")).toBe("'");
  });

  it("applies the longest-prefix rule", () => {
    expect(decodeHtmlEntities("&notit;")).toBe("\u00acit;");
    expect(decodeHtmlEntities("&notin;")).toBe("\u2209");
    expect(decodeHtmlEntities("&ampx")).toBe("&x");
    expect(decodeHtmlEntities("&ampx;")).toBe("&x;");
  });

  it("maps numeric references through Windows-1252", () => {
    expect(decodeHtmlEntities("&#128;")).toBe("\u20ac");
    expect(decodeHtmlEntities("&#x80;")).toBe("\u20ac");
    expect(decodeHtmlEntities("&#130;")).toBe("\u201a");
    expect(decodeHtmlEntities("&#x91;")).toBe("\u2018");
    expect(decodeHtmlEntities("&#153;")).toBe("\u2122");
  });

  it("handles invalid and out-of-range numeric references", () => {
    expect(decodeHtmlEntities("&#0;")).toBe("\ufffd");
    expect(decodeHtmlEntities("&#13;")).toBe("\r");
    expect(decodeHtmlEntities("&#1;")).toBe("");
    expect(decodeHtmlEntities("&#127;")).toBe("");
    expect(decodeHtmlEntities("&#xD800;")).toBe("\ufffd");
    expect(decodeHtmlEntities("&#x110000;")).toBe("\ufffd");
  });

  it("leaves unknown and malformed references intact", () => {
    expect(decodeHtmlEntities("&nosuchentity;")).toBe("&nosuchentity;");
    expect(decodeHtmlEntities("&Amp;")).toBe("&Amp;");
    expect(decodeHtmlEntities("&#xZZ;")).toBe("&#xZZ;");
    expect(decodeHtmlEntities("plain text")).toBe("plain text");
    expect(decodeHtmlEntities("a & b")).toBe("a & b");
  });
});
