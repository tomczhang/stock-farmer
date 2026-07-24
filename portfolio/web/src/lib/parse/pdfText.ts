import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

export interface PdfLine {
  page: number;
  text: string;
}

/** 提取 PDF 每页按 y 坐标聚合的文本行（供现金余额启发式提取用）。 */
export async function extractPdfLines(data: ArrayBuffer, password?: string): Promise<PdfLine[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    password,
    disableFontFace: true,
    isEvalSupported: false,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  const document = await loadingTask.promise;
  const lines: PdfLine[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const tokens = content.items
      .flatMap((item) => {
        const candidate = item as { str?: string; transform?: number[] };
        if (typeof candidate.str !== "string" || candidate.str.trim().length === 0) return [];
        if (!Array.isArray(candidate.transform)) return [];
        return [
          {
            text: candidate.str.replace(/\s+/g, " ").trim(),
            x: Number(candidate.transform[4] ?? 0),
            y: Number(candidate.transform[5] ?? 0),
          },
        ];
      })
      .sort((a, b) => b.y - a.y || a.x - b.x);

    // 按 y 坐标（容差 3）聚合为行
    const rows: Array<{ y: number; items: Array<{ text: string; x: number }> }> = [];
    for (const token of tokens) {
      const row = rows.find((r) => Math.abs(r.y - token.y) <= 3);
      if (row) {
        row.items.push(token);
      } else {
        rows.push({ y: token.y, items: [token] });
      }
    }
    for (const row of rows) {
      const text = row.items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .join(" ")
        .trim();
      if (text) lines.push({ page: pageNumber, text });
    }
  }
  return lines;
}
