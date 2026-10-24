import { opensearch, INDEX_NAME, VECTOR_INDEX_NAME } from './client';

export interface SearchParams {
  q?: string;
  category?: string;
  city?: string;
  date?: string;
  minPrice?: number;
  maxPrice?: number;
  page?: number;
  pageSize?: number;
}

export async function searchEvents(params: SearchParams) {
  const page = Math.max(params.page || 1, 1);
  const pageSize = Math.min(Math.max(params.pageSize || 20, 1), 100);

  const must: unknown[] = [];
  const filter: unknown[] = [{ term: { status: 'PUBLISHED' } }];

  if (params.q) {
    must.push({
      multi_match: {
        query: params.q,
        fields: ['name^3', 'description', 'tags', 'category', 'venueName'],
        fuzziness: 'AUTO',
      },
    });
  }
  if (params.category) filter.push({ term: { category: params.category } });
  if (params.city) filter.push({ term: { city: params.city } });
  if (params.date) {
    const start = new Date(params.date);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    filter.push({ range: { startsAt: { gte: start.toISOString(), lt: end.toISOString() } } });
  }
  if (params.minPrice !== undefined || params.maxPrice !== undefined) {
    filter.push({
      range: {
        basePrice: {
          ...(params.minPrice !== undefined ? { gte: params.minPrice } : {}),
          ...(params.maxPrice !== undefined ? { lte: params.maxPrice } : {}),
        },
      },
    });
  }

  const response = await opensearch.search({
    index: INDEX_NAME,
    body: {
      query: { bool: { must: must.length > 0 ? must : [{ match_all: {} }], filter } },
      sort: params.q ? ['_score'] : [{ startsAt: 'asc' }],
      from: (page - 1) * pageSize,
      size: pageSize,
    },
  });

  const hits = response.body.hits.hits as { _id: string; _source: unknown; _score: number }[];
  const total = typeof response.body.hits.total === 'number' ? response.body.hits.total : response.body.hits.total.value;

  return {
    results: hits.map((h) => ({ ...(h._source as object), score: h._score })),
    pagination: { page, pageSize, total },
  };
}

/** k-NN over the event embeddings: the events closest to this one. */
export async function similarEvents(eventId: string, size = 5) {
  const source = await opensearch.get({ index: VECTOR_INDEX_NAME, id: eventId }, { ignore: [404] });
  if (!source.body.found) return null;

  const response = await opensearch.search({
    index: VECTOR_INDEX_NAME,
    body: {
      // Over-fetch: the source event itself and unpublished events are dropped below.
      size: size + 5,
      query: { knn: { embedding: { vector: source.body._source.embedding, k: size + 5 } } },
      _source: { excludes: ['embedding'] },
    },
  });
  const hits = response.body.hits.hits as { _id: string; _source: { status: string }; _score: number }[];
  return hits
    .filter((h) => h._id !== eventId && h._source.status === 'PUBLISHED')
    .slice(0, size)
    .map((h) => ({ ...h._source, score: h._score }));
}
