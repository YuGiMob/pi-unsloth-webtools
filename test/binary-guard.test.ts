import { describe, expect, it } from "vitest";
import { isTextCandidateContentType } from "../web-fetch.ts";
import { fetchWith, makePdf, seamWithResponse } from "./helpers.ts";

function contentTypeMatrix() {
  return [
    ["text/html", true],
    ["text/plain; charset=utf-8", true],
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["application/xml", true],
    ["application/xhtml+xml", true],
    ["application/ld+json", true],
    ["application/yaml", true],
    ["application/x-yaml", true],
    ["application/x-ndjson", true],
    ["application/ndjson", true],
    ["application/sql", true],
    ["application/x-www-form-urlencoded", true],
    ["application/pdf", false],
    ["image/png", false],
    ["image/svg+xml", false],
    ["application/octet-stream", true],
    ["application/zip", false],
    ["application/vnd.ms-excel", true],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", true],
    ["", true],
    [null, true],
  ] as const;
}

describe("content-type candidacy", () => {
  for (const [contentType, expected] of contentTypeMatrix()) {
    it(`classifies ${contentType ?? "(none)"} as ${expected ? "textual" : "binary"}`, () => {
      expect(isTextCandidateContentType(contentType)).toBe(expected);
    });
  }
});

describe("pdf handling", () => {
  it("extracts page-delimited text regardless of content-type", async () => {
    const pdf = makePdf(["First page marker", "Second page marker"]);
    for (const contentType of ["application/pdf", "application/octet-stream", "text/html", "text/plain", null]) {
      const out = await fetchWith(pdf, contentType);
      expect(out).toContain("## Page 1\n\nFirst page marker");
      expect(out).toContain("## Page 2");
      expect(out).toContain("Second page marker");
      expect(out).not.toContain("binary content");
      expect(out).not.toContain("non-text content");
    }
  });

  it("returns a safe placeholder for malformed pdfs", async () => {
    for (const contentType of ["application/pdf", "text/plain"]) {
      const out = await fetchWith(Buffer.from("%PDF-1.7\nnot a complete PDF"), contentType);
      expect(out).toBe("(PDF content could not be read as text)");
    }
  });

  it("reports pdfs without a text layer", async () => {
    const out = await fetchWith(makePdf([""]), "application/pdf");
    expect(out).toBe("(PDF contains no extractable text)");
  });

  it("returns a safe placeholder for encrypted pdfs", async () => {
    const out = await fetchWith(makePdf(["private text"], { encrypt: true }), "application/pdf");
    expect(out).toBe("(PDF content could not be read as text)");
  });

  it("enforces the pdf download limit", async () => {
    const out = await fetchWith(makePdf(["Readable but oversized"]), "application/pdf", {
      maxPdfBytes: 256,
    });
    expect(out).toBe("(PDF content exceeds the download limit; not readable as text)");
  });

  it("reads a mislabeled pdf past the text download cap", async () => {
    const body = makePdf(["Cross-reference data was fetched"]);
    const out = await fetchWith(body, "text/plain", {
      maxBytes: 128,
      maxPdfBytes: body.length + 100,
    });
    expect(out).toContain("Cross-reference data was fetched");
  });

  it("caps pdf pages and marks intermediate text limits", async () => {
    const pages = Array.from({ length: 60 }, () => Array.from({ length: 30 }, () => "x".repeat(100)));
    const out = await fetchWith(makePdf(pages), "application/pdf");
    expect(out.length).toBeLessThanOrEqual(100_000);
    expect(out).toContain("text limited to 100,000 characters");
    expect(out).toContain("page processing capped at 50 pages");
  });

  it("does not mark a pdf at exactly the page cap", async () => {
    const pages = Array.from({ length: 50 }, () => "short");
    const out = await fetchWith(makePdf(pages), "application/pdf");
    expect(out).not.toContain("page processing capped");
    expect(out).toContain("## Page 50\n\nshort");
  });

  it("does not claim later pages are textless", async () => {
    const pages = Array.from({ length: 60 }, () => "");
    const out = await fetchWith(makePdf(pages), "application/pdf");
    expect(out).toBe("(PDF contains no extractable text in the first 50 pages)");
  });

  it("discards a pdf result that lands after the fetch deadline", async () => {
    const clock = { t: 1000 };
    const out = await fetchWith(makePdf(["Readable text"]), "application/pdf", {
      nowMs: () => clock.t,
      seams: {
        resolve: async () => ({ ok: true, reason: "", ip: "93.184.216.34", family: 4 }),
        request: async () => {
          clock.t += 10_000;
          return {
            status: 200,
            headers: { "content-type": "application/pdf" },
            body: makePdf(["Readable text"]),
          };
        },
      },
    });
    expect(out).toBe("Failed to fetch URL: timed out.");
  });

  it("extracts flate-compressed pdf streams", async () => {
    const out = await fetchWith(makePdf(["Compressed page marker"], { flate: true }), "application/pdf");
    expect(out).toContain("Compressed page marker");
  });
});

describe("binary sniffing", () => {
  it("keeps text octet-streams after sniffing", async () => {
    const body = Buffer.from("level=info\nmessage=plain text artifact\n".repeat(100));
    const out = await fetchWith(body, "application/octet-stream");
    expect(out).toContain("plain text artifact");
    expect(out).not.toContain("non-text content");
    expect(out).not.toContain("binary content");
  });

  it("rejects binary candidates after sniffing", async () => {
    const body = repeatBuffer(Buffer.from(Array.from({ length: 256 }, (_, i) => i)), 20);
    for (const contentType of ["application/octet-stream", "application/x-custom-binary", "text/plain", null]) {
      const out = await fetchWith(body, contentType);
      expect(out).not.toContain("\ufffd");
      expect(out).toContain("binary content");
    }
  });

  it("keeps unknown application text after sniffing", async () => {
    for (const contentType of ["application/sql", "application/x-www-form-urlencoded"]) {
      const out = await fetchWith(Buffer.from("select readable_text from artifacts;\n".repeat(100)), contentType);
      expect(out).toContain("readable_text");
      expect(out).not.toContain("non-text content");
      expect(out).not.toContain("binary content");
    }
  });

  it("keeps an excel-labeled csv after sniffing", async () => {
    const body = Buffer.from("name,value\nreadable,42\n".repeat(100));
    const out = await fetchWith(body, "application/vnd.ms-excel");
    expect(out).toContain("readable");
    expect(out).not.toContain("binary content");
  });

  it("keeps BOM unicode text without a charset", async () => {
    const text = "name,value\nreadable,42\n".repeat(100);
    const cases: [Buffer, Buffer][] = [
      [Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")],
      [Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()],
      [Buffer.from([0xff, 0xfe, 0x00, 0x00]), encodeUtf32(text, true)],
      [Buffer.from([0x00, 0x00, 0xfe, 0xff]), encodeUtf32(text, false)],
    ];
    for (const contentType of ["text/plain", "application/vnd.ms-excel"]) {
      for (const [bom, encoded] of cases) {
        const out = await fetchWith(Buffer.concat([bom, encoded]), contentType);
        expect(out).toContain("readable");
        expect(out).not.toContain("binary content");
      }
    }
  });

  it("catches valid utf-8 binary via control chars", async () => {
    const body = repeatBuffer(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]), 400);
    const out = await fetchWith(body, "text/plain");
    expect(out).toContain("binary content");
  });

  it("catches text-labeled binary by magic", async () => {
    const magics = [
      Buffer.from("PK\x03\x04"),
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from([0x1f, 0x8b]),
      Buffer.from("BZh"),
      Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
    ];
    for (const magic of magics) {
      const body = Buffer.concat([magic, Buffer.from(" printable text-heavy body".repeat(100))]);
      const out = await fetchWith(body, "text/plain");
      expect(out).toContain("binary content");
    }
  });

  it("catches binary magic after harmless prefixes", async () => {
    const prefixes = [
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from([0xff, 0xfe]),
      Buffer.from([0xfe, 0xff]),
      Buffer.from([0xff, 0xfe, 0x00, 0x00]),
      Buffer.from([0x00, 0x00, 0xfe, 0xff]),
      Buffer.from(" \r\n"),
      Buffer.from([0x09, 0xef, 0xbb, 0xbf, 0x20]),
    ];
    for (const prefix of prefixes) {
      const body = Buffer.concat([prefix, Buffer.from([0x1f, 0x8b]), Buffer.from(" printable text-heavy body".repeat(100))]);
      const out = await fetchWith(body, "text/plain");
      expect(out).toContain("binary content");
    }
  });

  it("catches office-labeled binary by magic", async () => {
    const cases: [string, Buffer][] = [
      ["application/vnd.ms-excel", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK\x03\x04")],
    ];
    for (const [contentType, magic] of cases) {
      const body = Buffer.concat([magic, Buffer.from(" printable text-heavy body".repeat(100))]);
      const out = await fetchWith(body, contentType);
      expect(out).toContain("binary content");
    }
  });

  it("rescues latin1 text without a charset via cp1252", async () => {
    const body = encodeCp1252(
      ("Muller lauft uber die Strasse: schoene, groesse. MARKERWORD ".replaceAll("ue", "ü") + "äöüß éèà ").repeat(30),
    );
    const out = await fetchWith(body, "text/plain");
    expect(out).not.toContain("binary content");
    expect(out).toContain("MARKERWORD");
  });

  it("keeps declared latin1 with cp1252 punctuation", async () => {
    for (const charset of ["iso-8859-1", "latin-1", "latin1"]) {
      const body = encodeCp1252("“quoted” ".repeat(100));
      const out = await fetchWith(body, `text/plain; charset=${charset}`);
      expect(out).toContain("quoted");
      expect(out).not.toContain("binary content");
    }
  });

  it("does not rescue high-byte binary as cp1252", async () => {
    const body = repeatBuffer(Buffer.from(Array.from({ length: 0x100 - 0xa0 }, (_, i) => i + 0xa0)), 40);
    const out = await fetchWith(body, "text/plain");
    expect(out).toContain("binary content");
  });

  it("keeps ansi-colored text logs", async () => {
    const body = Buffer.from("".concat(...Array.from({ length: 300 }, (_, i) => `\x1b[32m+${i}\x1b[0m\n`)));
    const out = await fetchWith(body, "text/plain");
    expect(out).not.toContain("binary content");
  });

  it("leaves real html pages untouched", async () => {
    const html = Buffer.from("<html><body><h1>Hello</h1><p>Real text content here.</p></body></html>");
    const out = await fetchWith(html, "text/html; charset=utf-8");
    expect(out).toContain("Hello");
    expect(out).not.toContain("non-text content");
    expect(out).not.toContain("binary content");
  });

  it("sanitizes content-type in messages", async () => {
    const out = await fetchWith(repeatBuffer(Buffer.from("PK\x03\x04"), 500), "application/zip\r\n data: injected");
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
    expect(out).not.toContain("injected");
    expect(out).toContain("application/zip");
  });

  it("applies the binary char ratio boundary", async () => {
    expect((await fetchWith(Buffer.concat([Buffer.alloc(120, 0), Buffer.alloc(880, 0x61)]), "text/plain")).includes("binary content")).toBe(false);
    expect((await fetchWith(Buffer.concat([Buffer.alloc(130, 0), Buffer.alloc(870, 0x61)]), "text/plain")).includes("binary content")).toBe(true);
  });

  it("keeps text with a few stray replacement chars", async () => {
    const body = Buffer.concat([Buffer.from("Real article text. ".repeat(200)), Buffer.from([0xff, 0xfe, 0xff])]);
    const out = await fetchWith(body, "text/html");
    expect(out).toContain("Real article text.");
    expect(out).not.toContain("binary content");
  });
});

function encodeUtf32(text: string, littleEndian: boolean): Buffer {
  const out = Buffer.alloc(text.length * 4);
  for (let i = 0; i < text.length; i++) {
    if (littleEndian) out.writeUInt32LE(text.charCodeAt(i), i * 4);
    else out.writeUInt32BE(text.charCodeAt(i), i * 4);
  }
  return out;
}

function repeatBuffer(buf: Buffer, times: number): Buffer {
  return Buffer.concat(Array.from({ length: times }, () => buf));
}

const CP1252_ENCODE: Record<string, number> = {
  "\u20ac": 0x80, "\u201a": 0x82, "\u0192": 0x83, "\u201e": 0x84, "\u2026": 0x85,
  "\u2020": 0x86, "\u2021": 0x87, "\u02c6": 0x88, "\u2030": 0x89, "\u0160": 0x8a,
  "\u2039": 0x8b, "\u0152": 0x8c, "\u017d": 0x8e, "\u2018": 0x91, "\u2019": 0x92,
  "\u201c": 0x93, "\u201d": 0x94, "\u2022": 0x95, "\u2013": 0x96, "\u2014": 0x97,
  "\u02dc": 0x98, "\u2122": 0x99, "\u0161": 0x9a, "\u203a": 0x9b, "\u0153": 0x9c,
  "\u017e": 0x9e, "\u0178": 0x9f,
};

function encodeCp1252(text: string): Buffer {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
      bytes.push(code);
    } else {
      const mapped = CP1252_ENCODE[char];
      if (mapped !== undefined) bytes.push(mapped);
      else bytes.push(0x3f);
    }
  }
  return Buffer.from(bytes);
}
