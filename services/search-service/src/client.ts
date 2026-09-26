import { Client } from '@opensearch-project/opensearch';

export const INDEX_NAME = process.env.OPENSEARCH_EVENTS_INDEX || 'events';

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

export async function ensureIndex(): Promise<void> {
  const exists = await opensearch.indices.exists({ index: INDEX_NAME });
  if (!exists.body) {
    await opensearch.indices.create({ index: INDEX_NAME, body: INDEX_MAPPING as any });
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
