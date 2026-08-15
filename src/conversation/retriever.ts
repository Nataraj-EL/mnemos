import { getDbPool } from '@/db';

export interface ConversationSnippetResult {
  conversationId: string;
  createdAt: Date;
  text: string;
}

export class ConversationRetriever {
  /**
   * Searches saved conversations for user query keywords and returns matching sentences.
   */
  async retrieveSnippets(
    userId: string,
    query: string,
    options?: { limitConversations?: number; maxSnippetsPerConversation?: number }
  ): Promise<ConversationSnippetResult[]> {
    if (!userId || !userId.trim()) {
      throw new Error('User ID is required.');
    }
    if (!query || !query.trim()) {
      throw new Error('Query is required.');
    }

    const limitConversations = options?.limitConversations ?? 3;
    const maxSnippetsPerConversation = options?.maxSnippetsPerConversation ?? 3;

    // Split query into keywords of length > 3 for search matching
    const keywords = query
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((word) => word.length > 3);

    if (keywords.length === 0) {
      keywords.push(query.toLowerCase().trim());
    }

    const pool = getDbPool();
    
    // Build parameters and query to find matching conversations
    const conditions = keywords.map((_, index) => `transcript ILIKE $${index + 2}`);
    const sql = `
      SELECT id, transcript, created_at as "createdAt"
      FROM conversations
      WHERE user_id = $1 AND (${conditions.join(' OR ')})
      ORDER BY created_at DESC
      LIMIT $${keywords.length + 2};
    `;

    const params = [userId, ...keywords.map(k => `%${k}%`), limitConversations];
    const result = await pool.query(sql, params);

    const snippets: ConversationSnippetResult[] = [];

    for (const row of result.rows) {
      const transcript = row.transcript || '';
      
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
        .filter((item: { sentence: string; matches: number }) => item.matches > 0)
        .sort((a: { sentence: string; matches: number }, b: { sentence: string; matches: number }) => b.matches - a.matches || a.sentence.length - b.sentence.length)
        .map((item: { sentence: string; matches: number }) => item.sentence);

      const selected = matchedSentences.slice(0, maxSnippetsPerConversation);

      for (const snippetText of selected) {
        snippets.push({
          conversationId: row.id,
          createdAt: new Date(row.createdAt),
          text: snippetText,
        });
      }
    }

    return snippets;
  }
}
