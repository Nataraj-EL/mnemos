export interface RetrievalSettings {
  semanticWeight: number;
  lexicalWeight: number;
  minSimilarity: number;
  diversityThreshold: number;
  maxConversationSnippets: number;
}

export const RETRIEVAL_SETTINGS: RetrievalSettings = {
  semanticWeight: 0.50,
  lexicalWeight: 0.10,
  minSimilarity: 0.0,
  diversityThreshold: 0.70,
  maxConversationSnippets: 3,
};
