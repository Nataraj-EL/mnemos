import { getDbPool } from '@/db';
import { PgConversationRepository } from './repository';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';

export interface ConversationSnippetResult {
  conversationId: string;
  createdAt: Date;
  matchedSnippet: string;
  text: string; // for backward compatibility
  similarity?: number;
  score?: number; // combined score
}

function getWordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

function isTooSimilar(text1: string, text2: string): boolean {
  const set1 = getWordSet(text1);
  const set2 = getWordSet(text2);
  if (set1.size === 0 || set2.size === 0) return false;
  let intersection = 0;
  for (const word of set1) {
    if (set2.has(word)) {
      intersection++;
    }
  }
  const union = new Set([...set1, ...set2]).size;
  const jaccard = intersection / union;
  return jaccard > 0.45; // nearly identical if word overlap is > 45%
}

export class ConversationRetriever {
  /**
   * Searches saved conversations semantically and returns diverse matching sentences as snippets.
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

    // Split query into keywords for sentence-level ranking and lexical relevance
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
    const globalSelectedTexts: string[] = [];

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

      // Apply local diversity selection and maxSnippetsPerConversation constraint
      const selected: string[] = [];
      for (const snippetText of matchedSentences) {
        if (selected.length >= maxSnippetsPerConversation) {
          break;
        }
        // Check local (within-conversation) and global diversity
        let isDuplicate = false;
        for (const existing of globalSelectedTexts) {
          if (isTooSimilar(snippetText, existing)) {
            isDuplicate = true;
            break;
          }
        }
        if (!isDuplicate) {
          selected.push(snippetText);
          globalSelectedTexts.push(snippetText);
        }
      }

      // If semantic search matched the conversation, but no sentences matched the keywords literally,
      // fall back to returning the first sentences of the conversation.
      if (selected.length === 0 && sentences.length > 0) {
        for (const s of sentences) {
          if (selected.length >= maxSnippetsPerConversation) {
            break;
          }
          let isDuplicate = false;
          for (const existing of globalSelectedTexts) {
            if (isTooSimilar(s, existing)) {
              isDuplicate = true;
              break;
            }
          }
          if (!isDuplicate) {
            selected.push(s);
            globalSelectedTexts.push(s);
          }
        }
      }

      // Calculate lexical relevance based on keyword match ratio in the transcript
      const matchCount = keywords.filter((k) => transcript.toLowerCase().includes(k)).length;
      const lexicalRelevance = matchCount / keywords.length;

      // Combine semantic similarity with lexical relevance
      const combinedScore = (item.similarity !== undefined && item.similarity !== null)
        ? (item.similarity * 0.7 + lexicalRelevance * 0.3)
        : lexicalRelevance;

      for (const snippetText of selected) {
        snippets.push({
          conversationId: conv.id,
          createdAt: new Date(conv.createdAt),
          matchedSnippet: snippetText,
          text: snippetText,
          similarity: item.similarity,
          score: combinedScore,
        });
      }
    }

    // Sort all snippets by combined score
    snippets.sort((a: ConversationSnippetResult, b: ConversationSnippetResult) => (b.score ?? 0) - (a.score ?? 0));

    return snippets;
  }
}
