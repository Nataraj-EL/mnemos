import { getDbPool } from '@/db';
import { PgConversationRepository } from './repository';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';

export interface ConversationSnippetResult {
  conversationId: string;
  createdAt: Date;
  text: string;
  similarity?: number;
}

export class ConversationRetriever {
  /**
   * Searches saved conversations semantically and returns relevant matching sentences as snippets.
   * Falls back to keyword term matching if embedding generation fails.
   */
  async retrieveSnippets(
    userId: string,
    query: string,
    options?: { limitConversations?: number; maxSnippetsPerConversation?: number; minSimilarity?: number }
  ): Promise<ConversationSnippetResult[]> {
    if (!userId || !userId.trim()) {
      throw new Error('User ID is required.');
    }
    if (!query || !query.trim()) {
      throw new Error('Query is required.');
    }

    const limitConversations = options?.limitConversations ?? 3;
    const maxSnippetsPerConversation = options?.maxSnippetsPerConversation ?? 3;
    const minSimilarity = options?.minSimilarity ?? 0.3;

    // Split query into keywords for sentence-level ranking
    const keywords = query
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((word) => word.length > 3);

    if (keywords.length === 0) {
      keywords.push(query.toLowerCase().trim());
    }

    // 1. Attempt semantic retrieval
    let queryEmbedding: number[] | null = null;
    try {
      const embeddingProvider = new GeminiEmbeddingProvider();
      queryEmbedding = await embeddingProvider.generateEmbedding(query);
    } catch (err) {
      console.warn('Embedding generation failed in ConversationRetriever, falling back to keyword search:', err);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resultsToProcess: { conversation: any; similarity?: number }[] = [];

    if (queryEmbedding) {
      try {
        const repo = new PgConversationRepository();
        const similarityResults = await repo.searchSimilarity(userId, queryEmbedding, limitConversations);
        const filteredResults = similarityResults.filter((r) => r.similarity >= minSimilarity);
        if (filteredResults.length > 0) {
          resultsToProcess = filteredResults;
        }
      } catch (searchErr) {
        console.warn('Semantic search query failed in database, falling back to keyword search:', searchErr);
      }
    }

    // 2. Fallback to keyword retrieval if no semantic results found
    if (resultsToProcess.length === 0) {
      const pool = getDbPool();
      const conditions = keywords.map((_, index) => `transcript ILIKE $${index + 2}`);
      const sql = `
        SELECT id, transcript, created_at as "createdAt"
        FROM conversations
        WHERE user_id = $1 AND (${conditions.join(' OR ')})
        ORDER BY created_at DESC
        LIMIT $${keywords.length + 2};
      `;
      const params = [userId, ...keywords.map((k) => `%${k}%`), limitConversations];
      const result = await pool.query(sql, params);
      resultsToProcess = result.rows.map((row) => ({
        conversation: {
          id: row.id,
          transcript: row.transcript,
          createdAt: row.createdAt,
        },
      }));
    }

    const snippets: ConversationSnippetResult[] = [];

    for (const item of resultsToProcess) {
      const conv = item.conversation;
      const transcript = conv.transcript || '';

      // Split into sentences
      const sentences = transcript
        .split(/[.!?\n]+/)
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 5);

      // Rank sentences by term frequency matching
      const rankedSentences = sentences.map((sentence: string) => {
        const sentenceLower = sentence.toLowerCase();
        let matches = 0;
        for (const k of keywords) {
          if (sentenceLower.includes(k)) {
            matches++;
          }
        }
        return { sentence, matches };
      });

      const matchedSentences = rankedSentences
        .filter((s: { sentence: string; matches: number }) => s.matches > 0)
        .sort((a: { sentence: string; matches: number }, b: { sentence: string; matches: number }) => b.matches - a.matches || a.sentence.length - b.sentence.length)
        .map((s: { sentence: string; matches: number }) => s.sentence);

      let selected = matchedSentences.slice(0, maxSnippetsPerConversation);

      // If semantic search matched the conversation, but no sentences matched the keywords literally,
      // fall back to returning the first sentences of the conversation.
      if (selected.length === 0 && sentences.length > 0) {
        selected = sentences.slice(0, maxSnippetsPerConversation);
      }

      for (const snippetText of selected) {
        snippets.push({
          conversationId: conv.id,
          createdAt: new Date(conv.createdAt),
          text: snippetText,
          similarity: item.similarity,
        });
      }
    }

    // Sort all snippets by conversation similarity score if available
    snippets.sort((a: ConversationSnippetResult, b: ConversationSnippetResult) => (b.similarity ?? 0) - (a.similarity ?? 0));

    return snippets;
  }
}
