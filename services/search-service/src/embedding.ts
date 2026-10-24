export const EMBEDDING_DIMS = 256;

export interface EmbeddableEvent {
  name: string;
  description: string;
  category: string;
  tags: string[];
}

/**
 * Feature-hashed bag-of-words embedding (signed hashing trick), L2
 * normalised so OpenSearch's cosine similarity ranks by shared vocabulary.
 * Category and tags are weighted up: they say more about "similar" than
 * free-text description words.
 * ponytail: lexical, not semantic ("gig" != "concert"). Swap this function
 * for a sentence-embedding model/API and bump EMBEDDING_DIMS for semantic
 * similarity; the k-NN index and query don't change.
 */
export function embed(event: EmbeddableEvent): number[] {
  const vector = new Array<number>(EMBEDDING_DIMS).fill(0);
  const add = (token: string, weight: number) => {
    const h = fnv1a(token);
    vector[h % EMBEDDING_DIMS] += (h & 0x80000000 ? -1 : 1) * weight;
  };
  for (const word of tokens(`${event.name} ${event.name} ${event.description}`)) add(word, 1);
  add(`category:${event.category.toLowerCase()}`, 4);
  for (const tag of event.tags) add(`tag:${tag.toLowerCase()}`, 2);

  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 2);
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
