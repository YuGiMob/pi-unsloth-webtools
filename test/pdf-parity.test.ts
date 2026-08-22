import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { extractPdfText } from "../pdf.ts";
import { makePdf } from "./helpers.ts";

function ascii85Encode(data: Buffer): string {
  let out = "";
  let i = 0;
  while (i + 4 <= data.length) {
    const v =
      data[i] * 0x1000000 +
      data[i + 1] * 0x10000 +
      data[i + 2] * 0x100 +
      data[i + 3];
    if (v === 0) {
      out += "z";
    } else {
      const d = [v / 85 ** 4, 0, 0, 0, 0].map((_, k) => Math.floor(v / 85 ** (4 - k)) % 85);
      out += d.map((x) => String.fromCharCode(x + 33)).join("");
    }
    i += 4;
  }
  const rest = data.length - i;
  if (rest > 0) {
    const padded = Buffer.alloc(4);
    data.copy(padded, 0, i);
    const v = padded.readUInt32BE(0);
    const d = [0, 0, 0, 0, 0].map((_, k) => Math.floor(v / 85 ** (4 - k)) % 85);
    out += d
      .slice(0, rest + 1)
      .map((x) => String.fromCharCode(x + 33))
      .join("");
  }
  return out + "~>";
}

function buildSimplePdf(
  content: string,
  options: { filter?: string; encoding?: string } = {},
): Buffer {
  const encoded = options.filter === "ASCII85Decode" ? ascii85Encode(Buffer.from(content, "latin1")) : content;
  const filterEntry = options.filter ? ` /Filter /${options.filter}` : "";
  const encodingEntry = options.encoding ?? "";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj",
    `4 0 obj\n<< /Length ${encoded.length}${filterEntry} >>\nstream\n${encoded}\nendstream\nendobj`,
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ${encodingEntry}>>\nendobj`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (const o of objects) {
    offsets.push(out.length);
    out += o + "\n";
  }
  const xrefPos = out.length;
  out += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) {
    out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function buildObjectStreamPdf(): Buffer {
  const content = "BT /F1 12 Tf 72 720 Td (Object stream text) Tj ET";
  const pageBody =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>";
  const fontBody = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const header = `3 0 5 ${pageBody.length + 1}\n`;
  const objStmData = Buffer.from(header + pageBody + "\n" + fontBody, "latin1");
  const objStmBytes = deflateSync(objStmData);
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    `6 0 obj\n<< /Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode /Length ${objStmBytes.length} >>\nstream\n${objStmBytes.toString("latin1")}\nendstream\nendobj\n`,
  ];
  let out = "%PDF-1.5\n";
  const offsets = [0];
  for (const o of objects) {
    offsets.push(out.length);
    out += o;
  }
  const mk = (type: number, f2: number, f3: number) =>
    Buffer.from([type, (f2 >> 8) & 0xff, f2 & 0xff, f3 & 0xff]);
  const xrefEntries = [
    mk(0, 0, 255),
    mk(1, offsets[1], 0),
    mk(1, offsets[2], 0),
    mk(2, 6, 0),
    mk(1, offsets[3], 0),
    mk(2, 6, 1),
    mk(1, offsets[4], 0),
  ];
  const xrefCompressed = deflateSync(Buffer.concat(xrefEntries));
  const xrefStream = `7 0 obj\n<< /Type /XRef /Size 7 /Root 1 0 R /W [1 2 1] /Index [0 7] /Filter /FlateDecode /Length ${xrefCompressed.length} >>\nstream\n${xrefCompressed.toString("latin1")}\nendstream\nendobj\n`;
  const xrefStreamOffset = out.length;
  out += xrefStream;
  out += `startxref\n${xrefStreamOffset}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("mupdf engine parity", () => {
  it("reads content from PDF 1.5 object streams", async () => {
    const out = await extractPdfText(buildObjectStreamPdf());
    expect(out).toContain("Object stream text");
  });

  it("decodes ASCII85Decode content streams", async () => {
    const content = "BT /F1 12 Tf 72 720 Td (Ascii85 filter text) Tj ET";
    const out = await extractPdfText(buildSimplePdf(content, { filter: "ASCII85Decode" }));
    expect(out).toContain("Ascii85 filter text");
  });

  it("maps font encodings through /Differences", async () => {
    const content = "BT /F1 12 Tf 72 720 Td (AB) Tj ET";
    const encoding =
      "/Encoding << /Type /Encoding /Differences [65 /Aacute 66 /Omega] >> ";
    const out = await extractPdfText(buildSimplePdf(content, { encoding }));
    expect(out).toContain("Á\u2126");
  });

  it("renders headings and bold like pymupdf4llm", async () => {
    const pdf = makePdf([
      [
        { text: "Big Heading", size: 24 },
        { text: "A body paragraph with normal text." },
      ],
    ]);
    const out = await extractPdfText(pdf);
    expect(out).toContain("## Page 1");
    expect(out).toContain("# **Big Heading**");
    expect(out).toContain("A body paragraph with normal text.");
  });

  it("renders links with escaped parens", async () => {
    const linkBody = "BT /F1 12 Tf 72 720 Td (Linked) Tj ET";
    const objects = [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R] >>\nendobj",
      `4 0 obj\n<< /Length ${linkBody.length} >>\nstream\n${linkBody}\nendstream\nendobj`,
      "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj",
      "6 0 obj\n<< /Type /Annot /Subtype /Link /Rect [72 700 200 730] /A << /S /URI /URI (https://example.com/a(b)c) >> >>\nendobj",
    ];
    let out = "%PDF-1.4\n";
    const offsets = [0];
    for (const o of objects) {
      offsets.push(out.length);
      out += o + "\n";
    }
    const xrefPos = out.length;
    out += "xref\n0 7\n0000000000 65535 f \n";
    for (let i = 1; i <= 6; i++) {
      out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    }
    out += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    const text = await extractPdfText(Buffer.from(out, "latin1"));
    expect(text).toContain("[Linked](https://example.com/a%0x28b%0x29c)");
  });

  it("detects and renders aligned tables", async () => {
    const pdf = makePdf([
      [
        { text: "Name", x: 72, y: 720 },
        { text: "Value", x: 300, y: 720 },
        { text: "Alpha", x: 72, y: 700 },
        { text: "One", x: 300, y: 700 },
        { text: "Beta", x: 72, y: 680 },
        { text: "Two", x: 300, y: 680 },
        { text: "Trailing paragraph after the table." },
      ],
    ]);
    const out = await extractPdfText(pdf);
    expect(out).toContain("|Name|Value|");
    expect(out).toContain("|---|---|");
    expect(out).toContain("|Alpha|One|");
    expect(out).toContain("|Beta|Two|");
    expect(out).toContain("Trailing paragraph after the table.");
  });
});
