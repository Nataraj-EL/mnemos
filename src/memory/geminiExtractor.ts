import { Memory } from '@/core/types';
import { MemoryExtractor, ExtractedAction } from './extractor';

export class GeminiMemoryExtractor implements MemoryExtractor {
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
  }

  async reconcile(text: string, candidates: Memory[]): Promise<ExtractedAction[]> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not defined.');
    }

    const filteredCandidates = candidates.map((c) => ({
      id: c.id,
      type: c.type,
      content: c.content,
      metadata: {
        source: c.metadata.source,
        confidence: c.metadata.confidence,
        importance: c.metadata.importance,
        status: c.metadata.status || 'active',
      },
    }));

    const prompt = `You are the memory engine of an AI. Your task is to extract memories from the new input and reconcile them against the user's existing candidate memories.

Existing Candidate Memories:
${filteredCandidates.length > 0 ? JSON.stringify(filteredCandidates, null, 2) : 'None'}

New Input Text:
"${text}"

Compare the new input to the existing candidate memories and output a list of actions to update the memory base:
1. CREATE: If the input reveals a new, meaningful fact, preference, goal, decision, event, or relationship not represented in the existing list.
2. UPDATE: If the input updates or adds details to an existing active memory, output UPDATE with the existing memory's exact ID, and update its content, type, confidence, and importance. Prefer updating or superseding over deleting.
3. DELETE: If the input directly contradicts an existing active memory or indicates it is no longer true, and it cannot be updated, output DELETE with the existing memory's exact ID.
4. NONE: If the input contains information that is already fully represented in an existing active memory with no changes, output NONE with the existing memory's exact ID to avoid duplicates.

Return your actions in the specified JSON schema format. Make sure the content of any CREATE or UPDATE action is a clear, concise, declarative user-focused statement. Do not use phrases like "I prefer" or "The user wants"; instead, make it third-person declarative (e.g. "User prefers Neon PostgreSQL" or "Mnemos uses Next.js").`;

    const requestBody = {
      contents: [
        {
          parts: [
            {
              text: prompt,
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            actions: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  action: {
                    type: 'STRING',
                    enum: ['CREATE', 'UPDATE', 'DELETE', 'NONE'],
                  },
                  id: {
                    type: 'STRING',
                    description: 'The exact ID of the existing memory to update, delete or ignore. Leave empty for CREATE.',
                  },
                  type: {
                    type: 'STRING',
                    enum: ['FACT', 'PREFERENCE', 'GOAL', 'DECISION', 'EVENT', 'RELATIONSHIP'],
                    description: 'Cognitive type of the memory. Required for CREATE and UPDATE.',
                  },
                  content: {
                    type: 'STRING',
                    description: 'The concise declarative statement of the memory. Required for CREATE and UPDATE.',
                  },
                  confidence: {
                    type: 'NUMBER',
                    description: 'Confidence score from 0.0 to 1.0. Required for CREATE and UPDATE.',
                  },
                  importance: {
                    type: 'INTEGER',
                    description: 'Importance rating from 1 (trivial) to 10 (crucial). Required for CREATE and UPDATE.',
                  },
                },
                required: ['action'],
              },
            },
          },
          required: ['actions'],
        },
      },
    };

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error (HTTP ${response.status}): ${errorText}`);
      }

      const jsonResponse = await response.json();
      const textResponse = jsonResponse?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!textResponse) {
        throw new Error('Malformed response: No text candidate returned by Gemini.');
      }

      const parsed = JSON.parse(textResponse);
      if (!parsed || !Array.isArray(parsed.actions)) {
        throw new Error('Malformed response: "actions" array is missing.');
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return parsed.actions.map((act: any) => {
        if (!['CREATE', 'UPDATE', 'DELETE', 'NONE'].includes(act.action)) {
          throw new Error(`Invalid action type: ${act.action}`);
        }
        return {
          action: act.action as 'CREATE' | 'UPDATE' | 'DELETE' | 'NONE',
          id: act.id || undefined,
          type: act.type || undefined,
          content: act.content || undefined,
          confidence: typeof act.confidence === 'number' ? act.confidence : undefined,
          importance: typeof act.importance === 'number' ? act.importance : undefined,
        };
      });
    } catch (error) {
      console.error('Error during Gemini memory extraction:', error);
      throw error;
    }
  }
}
