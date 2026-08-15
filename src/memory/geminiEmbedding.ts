import { EmbeddingProvider } from './embedding';

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string | undefined;
  private model: string;
  private dimension: number;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    this.model = process.env.EMBEDDING_MODEL || 'gemini-embedding-2';
    this.dimension = Number(process.env.EMBEDDING_DIMENSION || '768');
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not defined.');
    }
    if (!text || !text.trim()) {
      throw new Error('Text to embed cannot be empty.');
    }

    const urlModel = this.model.startsWith('models/') ? this.model.substring(7) : this.model;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${urlModel}:embedContent?key=${this.apiKey}`;

    const requestBody = {
      model: this.model.startsWith('models/') ? this.model : `models/${this.model}`,
      content: {
        parts: [
          {
            text: text,
          },
        ],
      },
      outputDimensionality: this.dimension,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(10000), // 10-second timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini Embedding API error (HTTP ${response.status}): ${errorText}`);
      }

      const json = await response.json();
      const vector = json?.embedding?.values;

      if (!vector || !Array.isArray(vector)) {
        throw new Error('Malformed response: "embedding.values" array is missing or invalid.');
      }

      return vector;
    } catch (error) {
      console.error('Error during Gemini embedding generation:', error);
      throw error;
    }
  }
}
