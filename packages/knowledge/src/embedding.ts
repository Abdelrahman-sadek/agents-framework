import type { EmbeddingProvider } from "@agent-farmework/core";

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Local, deterministic, dependency-free embedder (signed feature hashing over
 * words and word bigrams). Good enough for development, tests and small
 * corpora; use a hosted or local neural embedder in production (ADR 015).
 */
export function hashingEmbedder(options: { dimensions?: number } = {}): EmbeddingProvider {
  const dimensions = options.dimensions ?? 512;
  return {
    id: `hashing-${dimensions}`,
    dimensions,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array<number>(dimensions).fill(0);
        const tokens = tokenize(text);
        const features = [...tokens, ...tokens.slice(1).map((t, i) => `${tokens[i]}_${t}`)];
        for (const feature of features) {
          const h = fnv1a(feature);
          const index = h % dimensions;
          vector[index] = (vector[index] ?? 0) + ((h >>> 31) === 0 ? 1 : -1);
        }
        const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
        return norm === 0 ? vector : vector.map((v) => v / norm);
      });
    },
  };
}
