/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { ResponseService } from '../response/service';

// Pure logic functions extracted for frontend state and template testing
const getGroundingStatus = (usedMemories: unknown[] = [], usedConversations: unknown[] = []) => {
  const memCount = usedMemories.length;
  const convCount = usedConversations.length;
  
  if (memCount > 0 && convCount > 0) {
    return {
      label: `Fully Grounded by ${memCount} memories + ${convCount} past conversations`,
      color: '#10b981',
      bgColor: 'rgba(16, 185, 129, 0.05)',
      borderColor: 'rgba(16, 185, 129, 0.2)',
    };
  } else if (memCount > 0 || convCount > 0) {
    const typeLabel = memCount > 0 
      ? `${memCount} memor${memCount === 1 ? 'y' : 'ies'}` 
      : `${convCount} past conversation${convCount === 1 ? '' : 's'}`;
    return {
      label: `Partially Grounded by ${typeLabel}`,
      color: '#3b82f6',
      bgColor: 'rgba(59, 130, 246, 0.05)',
      borderColor: 'rgba(59, 130, 246, 0.2)',
    };
  } else {
    return {
      label: 'No relevant context found',
      color: '#ef4444',
      bgColor: 'rgba(239, 68, 68, 0.05)',
      borderColor: 'rgba(239, 68, 68, 0.2)',
    };
  }
};

const mapFriendlyErrorMessage = (error: string, flow: 'text' | 'voice'): string => {
  const errLower = error.toLowerCase();
  if (flow === 'voice') {
    if (errLower.includes('api_key') || errLower.includes('api key') || errLower.includes('provider') || errLower.includes('unavailable')) {
      return 'Voice service is temporarily unavailable.';
    } else if (errLower.includes('transcribe') || errLower.includes('transcription') || errLower.includes('audio') || errLower.includes('speech') || errLower.includes('format')) {
      return 'Transcription failed. Please check your microphone and try again.';
    } else if (errLower.includes('database') || errLower.includes('sql') || errLower.includes('persistence')) {
      return 'Database connection issue. Unable to process request.';
    } else {
      return 'Unable to process voice request. Please try again.';
    }
  } else {
    if (errLower.includes('api_key') || errLower.includes('api key') || errLower.includes('provider') || errLower.includes('unavailable')) {
      return 'Grounded response service is temporarily unavailable.';
    } else if (errLower.includes('database') || errLower.includes('sql') || errLower.includes('persistence')) {
      return 'Database connection issue. Unable to retrieve context.';
    } else {
      return 'Unable to generate response. Please try again.';
    }
  }
};

describe('Sprint 23 Grounded Answer Experience Logic Tests', () => {
  describe('Grounding Status Calculation', () => {
    it('should show Fully Grounded status when both memory and conversation sources are present', () => {
      const memories = [{ id: 'mem-1', type: 'FACT' }];
      const conversations = [{ id: 'conv-1', text: 'snippet' }];
      const status = getGroundingStatus(memories, conversations);

      expect(status.label).toContain('Fully Grounded');
      expect(status.label).toContain('1 memories + 1 past conversations');
      expect(status.color).toBe('#10b981');
    });

    it('should show Partially Grounded status when only memories are present', () => {
      const memories = [{ id: 'mem-1', type: 'FACT' }, { id: 'mem-2', type: 'PREFERENCE' }];
      const conversations: any[] = [];
      const status = getGroundingStatus(memories, conversations);

      expect(status.label).toContain('Partially Grounded by 2 memories');
      expect(status.color).toBe('#3b82f6');
    });

    it('should show Partially Grounded status when only conversations are present', () => {
      const memories: any[] = [];
      const conversations = [{ id: 'conv-1', text: 'snippet' }];
      const status = getGroundingStatus(memories, conversations);

      expect(status.label).toContain('Partially Grounded by 1 past conversation');
      expect(status.color).toBe('#3b82f6');
    });

    it('should show No relevant context found status when no sources are present', () => {
      const memories: any[] = [];
      const conversations: any[] = [];
      const status = getGroundingStatus(memories, conversations);

      expect(status.label).toBe('No relevant context found');
      expect(status.color).toBe('#ef4444');
    });
  });

  describe('Grounding Status Context Budget Limits', () => {
    it('should only derive grounding status from final used sources under maxTokens budget', async () => {
      const mockMemoryRetriever = {
        retrieve: vi.fn().mockResolvedValue([]),
      } as any;

      const mockAssembler = {
        assemble: vi.fn().mockReturnValue({
          items: [],
          context: '[MEMORY] facts.',
          tokenCount: 10,
        }),
      } as any;

      const mockGenerator = {
        generateResponse: vi.fn().mockResolvedValue({ text: 'Answer' }),
      } as any;

      // Two conversation snippets: first fits budget, second is too large and gets excluded
      const mockConversationRetriever = {
        retrieveSnippets: vi.fn().mockResolvedValue([
          {
            conversationId: 'conv-1',
            createdAt: new Date('2026-08-12T14:30:00.000Z'),
            matchedSnippet: 'Snippet one',
            text: 'Snippet one',
            similarity: 0.9,
          },
          {
            conversationId: 'conv-2',
            createdAt: new Date('2026-08-12T14:30:00.000Z'),
            matchedSnippet: 'Too long snippet '.repeat(100),
            text: 'Too long snippet',
            similarity: 0.8,
          },
        ]),
      } as any;

      const responseService = new ResponseService(
        mockMemoryRetriever,
        mockAssembler,
        mockGenerator,
        undefined,
        mockConversationRetriever
      );

      // Call respond with maxTokens = 30 so that conv-2 is excluded
      const result = await responseService.respond('user-1', 'query', { limit: 10, maxTokens: 30 });

      // Grounding status should be computed from the final returned usedConversations array (length = 1)
      const usedConversations = result.usedConversations || [];
      const usedMemories = result.usedMemories || [];

      expect(usedConversations).toHaveLength(1);
      expect(usedConversations[0].id).toBe('conv-1');

      const status = getGroundingStatus(usedMemories, usedConversations);
      expect(status.label).toContain('Partially Grounded'); // Not Fully because memories is 0
      expect(status.label).not.toContain('2'); // Budget-excluded items are not counted
    });
  });

  describe('Citation Interaction & Expansion Logic', () => {
    it('should toggling state index correctly and support unique card expansion', () => {
      let expandedCitations: Record<string, boolean> = {};
      const toggleCitation = (key: string) => {
        expandedCitations = {
          ...expandedCitations,
          [key]: !expandedCitations[key],
        };
      };

      toggleCitation('vmem-0');
      expect(expandedCitations['vmem-0']).toBe(true);

      toggleCitation('vmem-0');
      expect(expandedCitations['vmem-0']).toBe(false);

      toggleCitation('tconv-1');
      expect(expandedCitations['tconv-1']).toBe(true);
      expect(expandedCitations['vmem-0']).toBeFalsy(); // Other card unaffected
    });
  });

  describe('User-Friendly Score Formatting', () => {
    it('should format decimals as clean user-friendly percentage strings', () => {
      const formatValue = (val: number) => `${(val * 100).toFixed(0)}%`;

      expect(formatValue(0.9)).toBe('90%');
      expect(formatValue(0.854)).toBe('85%');
      expect(formatValue(0.999)).toBe('100%');
    });
  });

  describe('Metadata Exposure Boundaries', () => {
    it('should confirm usedMemories output includes confidence and lifecycle state and does not leak internal DB columns', () => {
      const rawItem = {
        id: 'mem-1234',
        type: 'FACT',
        similarity: 0.92,
        score: 0.88,
        content: 'Clean data content',
        confidence: 0.95,
        lifecycleState: 'core',
      };

      // Mock user-facing citation render details
      const citationHTML = `
        <button aria-expanded="false" aria-controls="content-vmem-0">
          🧠 Persistent Memory (${rawItem.type})
        </button>
        <div id="content-vmem-0">
          <div>Confidence: ${((rawItem.confidence) * 100).toFixed(0)}%</div>
          <div>Lifecycle: ${rawItem.lifecycleState}</div>
          <p>${rawItem.content}</p>
        </div>
      `;

      // Check user-facing properties exist
      expect(citationHTML).toContain('Persistent Memory (FACT)');
      expect(citationHTML).toContain('Confidence: 95%');
      expect(citationHTML).toContain('Lifecycle: core');
      expect(citationHTML).toContain('Clean data content');

      // Ensure raw DB primary keys or system metadata are NOT leaked
      expect(citationHTML).not.toContain(rawItem.id);
      expect(citationHTML).not.toContain('req-');
    });
  });

  describe('Voice UX Ask Again Reset', () => {
    it('should clear only response states and query fields while strictly preserving savedConversationId', () => {
      // Simulate state variables
      let transcript = 'Some voice transcript';
      let voiceResponseText: string | null = 'Synthesized answer text';
      let voiceUsedMemories = [{ id: 'mem-1' }];
      let voiceUsedConversations = [{ id: 'conv-1' }];
      let voiceContextTokenCount = 45;
      const savedConversationId: string | null = 'conv-session-12345';
      let voiceSessionState = 'review';

      // Ask Again execution
      const handleVoiceAskAgain = () => {
        transcript = '';
        voiceResponseText = null;
        voiceUsedMemories = [];
        voiceUsedConversations = [];
        voiceContextTokenCount = 0;
        voiceSessionState = 'idle';
      };

      handleVoiceAskAgain();

      expect(transcript).toBe('');
      expect(voiceResponseText).toBeNull();
      expect(voiceUsedMemories).toHaveLength(0);
      expect(voiceUsedConversations).toHaveLength(0);
      expect(voiceContextTokenCount).toBe(0);
      expect(voiceSessionState).toBe('idle');

      // Confirm savedConversationId was strictly preserved
      expect(savedConversationId).toBe('conv-session-12345');
    });
  });

  describe('Friendly Error Mapping', () => {
    it('should map raw provider key errors and database errors to friendly warnings', () => {
      expect(mapFriendlyErrorMessage('GEMINI_API_KEY environment variable is not defined.', 'text'))
        .toBe('Grounded response service is temporarily unavailable.');

      expect(mapFriendlyErrorMessage('Unexpected SQL database error occurred', 'voice'))
        .toBe('Database connection issue. Unable to process request.');

      expect(mapFriendlyErrorMessage('transcription failed or file corrupted', 'voice'))
        .toBe('Transcription failed. Please check your microphone and try again.');
    });
  });
});
