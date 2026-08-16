interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class RetrievalCache {
  private static instance: RetrievalCache;

  private embeddingCache = new Map<string, CacheEntry<number[]>>();
  private retrievalCache = new Map<string, CacheEntry<unknown[]>>();
  private inFlightPromises = new Map<string, Promise<unknown>>();

  private maxSize: number;
  private ttlMs: number;

  private constructor() {
    let max = Number(process.env.RETRIEVAL_CACHE_MAX_SIZE);
    if (isNaN(max) || max <= 0) {
      max = 100;
    }
    this.maxSize = max;

    let ttl = Number(process.env.RETRIEVAL_CACHE_TTL_MS);
    if (isNaN(ttl) || ttl <= 0) {
      ttl = 30000;
    }
    this.ttlMs = ttl;
  }

  public static getInstance(): RetrievalCache {
    if (!RetrievalCache.instance) {
      RetrievalCache.instance = new RetrievalCache();
    }
    return RetrievalCache.instance;
  }

  public clear(): void {
    this.embeddingCache.clear();
    this.retrievalCache.clear();
    this.inFlightPromises.clear();
  }

  public getMaxSize(): number {
    return this.maxSize;
  }

  public getTtlMs(): number {
    return this.ttlMs;
  }

  public normalizeQuery(query: string): string {
    return query.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  public hashConfig(config?: Record<string, unknown>): string {
    if (!config) return '';
    const relevantKeys = [
      'limit',
      'minSimilarity',
      'includeHistorical',
      'semanticWeight',
      'lexicalWeight',
      'maxConversationSnippets',
      'limitConversations'
    ];
    return relevantKeys
      .map(k => `${k}:${config[k] ?? ''}`)
      .join(',');
  }

  public async getOrCreateSingleFlight<T>(
    key: string,
    factory: () => Promise<T>
  ): Promise<T> {
    const existing = this.inFlightPromises.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = factory();
    this.inFlightPromises.set(key, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      this.inFlightPromises.delete(key);
    }
  }

  public getEmbedding(userId: string, query: string): number[] | null {
    if (!userId || !userId.trim()) return null;
    const norm = this.normalizeQuery(query);
    const key = `${userId}:${norm}`;
    
    const entry = this.embeddingCache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.embeddingCache.delete(key);
      return null;
    }

    // Refresh Recency (LRU behavior)
    this.embeddingCache.delete(key);
    this.embeddingCache.set(key, entry);

    return entry.value;
  }

  public setEmbedding(userId: string, query: string, embedding: number[]): void {
    if (!userId || !userId.trim() || !embedding || embedding.length === 0) return;
    const norm = this.normalizeQuery(query);
    const key = `${userId}:${norm}`;

    this.embeddingCache.delete(key);
    this.embeddingCache.set(key, {
      value: embedding,
      expiresAt: Date.now() + this.ttlMs
    });

    this.enforceLimit(this.embeddingCache);
  }

  public getRetrieval<T>(userId: string, query: string, config?: Record<string, unknown>): T[] | null {
    if (!userId || !userId.trim()) return null;
    const norm = this.normalizeQuery(query);
    const confHash = this.hashConfig(config);
    const key = `${userId}:${norm}:${confHash}`;

    const entry = this.retrievalCache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.retrievalCache.delete(key);
      return null;
    }

    // Refresh Recency (LRU behavior)
    this.retrievalCache.delete(key);
    this.retrievalCache.set(key, entry);

    return entry.value as T[];
  }

  public setRetrieval<T>(userId: string, query: string, results: T[], config?: Record<string, unknown>): void {
    if (!userId || !userId.trim() || !results || results.length === 0) return;
    const norm = this.normalizeQuery(query);
    const confHash = this.hashConfig(config);
    const key = `${userId}:${norm}:${confHash}`;

    this.retrievalCache.delete(key);
    this.retrievalCache.set(key, {
      value: results as unknown[],
      expiresAt: Date.now() + this.ttlMs
    });

    this.enforceLimit(this.retrievalCache);
  }

  public invalidate(userId: string): void {
    if (!userId || !userId.trim()) return;
    
    // Invalidate embeddings
    for (const key of Array.from(this.embeddingCache.keys())) {
      if (key.startsWith(`${userId}:`)) {
        this.embeddingCache.delete(key);
      }
    }

    // Invalidate retrieval results
    for (const key of Array.from(this.retrievalCache.keys())) {
      if (key.startsWith(`${userId}:`)) {
        this.retrievalCache.delete(key);
      }
    }
  }

  private enforceLimit(cache: Map<string, unknown>): void {
    if (cache.size > this.maxSize) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }
  }
}
