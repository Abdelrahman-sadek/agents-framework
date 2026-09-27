import type { Chunk, Document } from "./types.js";

export interface Chunker {
  chunk(document: Document): Chunk[];
}

function toChunks(document: Document, pieces: string[]): Chunk[] {
  return pieces
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text, index) => ({
      id: `${document.id}#${index}`,
      documentId: document.id,
      index,
      text,
      metadata: document.metadata ?? {},
      ...(document.title === undefined ? {} : { title: document.title }),
      ...(document.uri === undefined ? {} : { uri: document.uri }),
      ...(document.tenantId === undefined ? {} : { tenantId: document.tenantId }),
    }));
}

/** Fixed-size character windows with overlap. */
export function fixedSizeChunker(options: { size?: number; overlap?: number } = {}): Chunker {
  const size = options.size ?? 1000;
  const overlap = options.overlap ?? 100;
  if (overlap >= size) throw new RangeError("overlap must be smaller than size");
  return {
    chunk(document) {
      const pieces: string[] = [];
      for (let start = 0; start < document.text.length; start += size - overlap) {
        pieces.push(document.text.slice(start, start + size));
        if (start + size >= document.text.length) break;
      }
      return toChunks(document, pieces);
    },
  };
}

/**
 * Structure-aware chunker: split on headings/paragraphs, then sentences, and
 * pack pieces up to `maxChars`, carrying `overlap` characters of context.
 */
export function recursiveChunker(options: { maxChars?: number; overlap?: number } = {}): Chunker {
  const maxChars = options.maxChars ?? 1000;
  const overlap = options.overlap ?? 0;
  const split = (text: string): string[] => {
    if (text.length <= maxChars) return [text];
    for (const separator of [/\n(?=#{1,6} )/, /\n\s*\n/, /(?<=[.!?])\s+/, /\s+/]) {
      const parts = text.split(separator).filter((p) => p.trim() !== "");
      if (parts.length > 1) return parts.flatMap(split);
    }
    const out: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
    return out;
  };
  return {
    chunk(document) {
      const packed: string[] = [];
      let current = "";
      for (const part of split(document.text)) {
        if (current !== "" && current.length + part.length + 1 > maxChars) {
          packed.push(current);
          current = overlap > 0 ? current.slice(-overlap) : "";
        }
        current = current === "" ? part : `${current} ${part}`;
      }
      if (current.trim() !== "") packed.push(current);
      return toChunks(document, packed);
    },
  };
}

/** Minimal HTML → text for ingestion. Use a real parser for complex documents. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
