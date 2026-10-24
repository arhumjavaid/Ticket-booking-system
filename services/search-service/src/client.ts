import { Client } from '@opensearch-project/opensearch';

import { EMBEDDING_DIMS } from './embedding';

export const INDEX_NAME = process.env.OPENSEARCH_EVENTS_INDEX || 'events';
// k-NN needs index.knn at creation time, so vectors live in their own index
// rather than forcing a rebuild of the keyword index above.
export const VECTOR_INDEX_NAME = `${INDEX_NAME}_vectors`;

export const opensearch = new Client({
  node: process.env.OPENSEARCH_URL || 'http://localhost:9200',
});

export const INDEX_MAPPING = {
  mappings: {
    properties: {
      eventId: { type: 'keyword' },
      name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      description: { type: 'text' },
      category: { type: 'keyword' },
      venueName: { type: 'text' },
      city: { type: 'keyword' },
      tags: { type: 'keyword' },
      startsAt: { type: 'date' },
      basePrice: { type: 'float' },
      status: { type: 'keyword' },
      availableSeats: { type: 'integer' },
    },
  },
} as const;

export const VECTOR_INDEX_MAPPING = {
  settings: { index: { knn: true } },
  mappings: {
    properties: {
      ...INDEX_MAPPING.mappings.properties,
      embedding: {
        type: 'knn_vector',
        dimension: EMBEDDING_DIMS,
        method: { name: 'hnsw', space_type: 'cosinesimil', engine: 'lucene' },
      },
    },
  },
} as const;

export async function ensureIndex(): Promise<void> {
  for (const [index, body] of [
    [INDEX_NAME, INDEX_MAPPING],
    [VECTOR_INDEX_NAME, VECTOR_INDEX_MAPPING],
  ] as const) {
    const exists = await opensearch.indices.exists({ index });
    if (!exists.body) await opensearch.indices.create({ index, body: body as any });
  }
}

export async function pingOpenSearch(): Promise<boolean> {
  try {
    const res = await opensearch.ping();
    return res.body === true || res.statusCode === 200;
  } catch {
    return false;
  }
}
