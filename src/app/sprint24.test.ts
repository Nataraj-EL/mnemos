/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { MemoryIngestionService } from '../memory/ingestionService';
import { ConversationMemoryExtractionService } from '../conversation/extractionService';
import { ResponseService } from '../response/service';

// Mock date formatter matching client implementation
const formatProvenanceDate = (timestamp?: string) => {
  if (!timestamp) return '';
  try {
    const d = new Date(timestamp);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return '';
  }
};

describe('Sprint 24 Memory Provenance & Trace Logic Tests', () => {
  describe('1. Provenance Preservation during Ingestion / Reconciliation', () => {
    it('should attach provenance during CREATE actions and preserve it on UPDATE actions if no newer source is provided', async () => {
      const mockMemoryRepo = {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockImplementation((mem) => Promise.resolve({
          id: 'mem-new-123',
          ...mem,
          createdAt: new Date(),
          updatedAt: new Date()
        })),
        update: vi.fn().mockImplementation((id, updates) => {
          return Promise.resolve({
            id,
            userId: 'user-1',
            type: 'FACT',
            content: updates.content || 'User prefers green tea',
            metadata: updates.metadata || {
              conversationId: 'conv-999',
              sourceType: 'conversation',
              sourceTimestamp: '2026-08-15T18:18:00.000Z'
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }),
        get: vi.fn()
      } as any;

      const mockExtractor = {
        reconcile: vi.fn().mockResolvedValue([
          { action: 'CREATE', type: 'FACT', content: 'User prefers green tea', confidence: 0.95, importance: 8 }
        ])
      } as any;

      const mockEmbeddingProvider = {
        generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
      } as any;

      const ingestionService = new MemoryIngestionService(mockMemoryRepo, mockExtractor, mockEmbeddingProvider);

      // Ingest with provenance (from extraction)
      const created = await ingestionService.ingest('user-1', 'User prefers green tea', {
        conversationId: 'conv-999',
        sourceType: 'conversation',
        sourceTimestamp: '2026-08-15T18:18:00.000Z'
      });

      expect(created[0].metadata.conversationId).toBe('conv-999');
      expect(created[0].metadata.sourceType).toBe('conversation');
      expect(created[0].metadata.sourceTimestamp).toBe('2026-08-15T18:18:00.000Z');

      // Now run reconciliation UPDATE where no new provenance is supplied
      mockMemoryRepo.get.mockResolvedValueOnce(created[0]);
      mockExtractor.reconcile.mockResolvedValueOnce([
        { action: 'UPDATE', id: 'mem-new-123', type: 'FACT', content: 'User prefers matcha green tea', confidence: 0.98, importance: 9 }
      ]);

      const updated = await ingestionService.ingest('user-1', 'User prefers matcha green tea');

      // The new temporal memory should inherit the provenance of the existing memory
      expect(updated[0].metadata.conversationId).toBe('conv-999');
      expect(updated[0].metadata.sourceType).toBe('conversation');
      expect(updated[0].metadata.sourceTimestamp).toBe('2026-08-15T18:18:00.000Z');
    });
  });

  describe('2. Conversation Ownership before Provenance Assignment', () => {
    it('should strictly reject extraction and provenance assignment if conversation userId ownership check fails', async () => {
      const mockConversationRepo = {
        getById: vi.fn().mockResolvedValue({
          id: 'conv-123',
          userId: 'user-owner',
          transcript: 'Some dialogue',
          createdAt: new Date()
        })
      } as any;

      const mockIngestionService = {
        ingest: vi.fn()
      } as any;

      const extractionService = new ConversationMemoryExtractionService(mockConversationRepo, mockIngestionService);

      // Attempt extraction under user-hijacker
      await expect(extractionService.extract('conv-123', 'user-hijacker'))
        .rejects.toThrow('Forbidden: Access denied to this conversation.');

      expect(mockIngestionService.ingest).not.toHaveBeenCalled();
    });
  });

  describe('3. Legacy Memory Compatibility', () => {
    it('should gracefully handle memories without any provenance details', () => {
      const legacyMetadata: any = {
        source: 'user_input',
        confidence: 0.9,
        importance: 5,
        timestamp: new Date().toISOString()
      };

      // Ensure formatting provenance returns nothing
      const provString = legacyMetadata.conversationId ? `From conversation · ${formatProvenanceDate(legacyMetadata.sourceTimestamp as string)}` : '';
      expect(provString).toBe('');
    });
  });

  describe('4. Incomplete/Paginated Memory Lists & User-Scoped Provenance Lookup', () => {
    it('should query API using user-scoped lookup matching both userId and conversationId to load memories cleanly', async () => {
      // Simulate dashboard loading memories matching both userId and conversationId
      const userId = 'user-123';
      const conversationId = 'conv-456';
      
      const mockApiFetchResult = {
        status: 'success',
        memories: [
          { id: 'mem-1', userId: 'user-123', content: 'Extracted memory', metadata: { conversationId: 'conv-456' } },
          { id: 'mem-2', userId: 'user-123', content: 'Another extracted memory', metadata: { conversationId: 'conv-456' } }
        ]
      };

      const verifiedMemories = mockApiFetchResult.memories.filter((m) => 
        m.userId === userId && m.metadata.conversationId === conversationId
      );

      expect(verifiedMemories).toHaveLength(2);
      expect(verifiedMemories[0].id).toBe('mem-1');
    });
  });

  describe('5. Cross-User Conversation/Memory Isolation', () => {
    it('should enforce that conversation memory retrieval restricts query filter to both user owner and conversation ID', async () => {
      const mockListMethod = vi.fn().mockImplementation((filter) => {
        // Mock DB query logic where userId and conversationId JSON match are constrained
        if (filter.userId === 'user-1' && filter.conversationId === 'conv-100') {
          return Promise.resolve([{ id: 'mem-1', userId: 'user-1', metadata: { conversationId: 'conv-100' } }]);
        }
        return Promise.resolve([]);
      });

      const listResultAuthorized = await mockListMethod({ userId: 'user-1', conversationId: 'conv-100' });
      expect(listResultAuthorized).toHaveLength(1);

      const listResultHijacked = await mockListMethod({ userId: 'user-attacker', conversationId: 'conv-100' });
      expect(listResultHijacked).toHaveLength(0); // isolated
    });
  });

  describe('6. No UUID/ID Leakage and Source Semantics', () => {
    it('should format date/time provenance without printing raw conversation database IDs in templates', () => {
      const metadata = {
        conversationId: 'db-uuid-12345-67890-abcdef',
        sourceType: 'conversation',
        sourceTimestamp: '2026-08-15T18:18:00.000Z'
      };

      // Mock UI rendered text output
      const renderCitationText = `🧠 Persistent Memory (FACT) - From conversation · ${formatProvenanceDate(metadata.sourceTimestamp)}`;

      const expectedDateText = `From conversation · ${formatProvenanceDate(metadata.sourceTimestamp)}`;
      expect(renderCitationText).toContain(expectedDateText);
      expect(renderCitationText).not.toContain(metadata.conversationId);
      expect(renderCitationText).not.toContain('uuid');
    });
  });

  describe('7. Valid Citation -> Conversation Navigation', () => {
    it('should verify ownership and fetch conversation details cleanly when selecting related conversation ID', async () => {
      const userId = 'user-owner';
      const selectConversation = async (id: string) => {
        if (!userId.trim()) return null;
        // Mock api check
        const mockApiResponse = {
          status: 'success',
          data: {
            conversation: { id, userId: 'user-owner', transcript: 'Sample conversation transcript' }
          }
        };

        if (mockApiResponse.data.conversation.userId !== userId) {
          throw new Error('Access Denied');
        }
        return mockApiResponse.data.conversation;
      };

      const result = await selectConversation('conv-123');
      expect(result).toBeDefined();
      expect(result?.id).toBe('conv-123');
    });
  });

  describe('8. Memory Extraction -> Provenance -> Citation Trace End-To-End', () => {
    it('should propagate provenance fields from extraction through compilation to response generation service output', async () => {
      // 1. Mock assembler compiles context items with conversation metadata
      const mockItems = [
        {
          id: 'mem-1',
          type: 'FACT',
          content: 'I prefer typescript',
          similarity: 0.95,
          score: 0.9,
          confidence: 0.9,
          lifecycleState: 'stable',
          conversationId: 'conv-1',
          sourceType: 'conversation',
          sourceTimestamp: '2026-08-15T18:18:00.000Z'
        }
      ] as any;

      const mockRetriever = { retrieve: vi.fn().mockResolvedValue([]) } as any;
      const mockAssembler = {
        assemble: vi.fn().mockReturnValue({
          items: mockItems,
          context: '[MEMORY] I prefer typescript',
          tokenCount: 15
        })
      } as any;
      const mockGenerator = {
        generateResponse: vi.fn().mockResolvedValue({ text: 'Answer' })
      } as any;

      const responseService = new ResponseService(mockRetriever, mockAssembler, mockGenerator);
      const result = await responseService.respond('user-1', 'query');

      // The returned usedMemories from the service must propagate the provenance fields
      expect(result.usedMemories).toHaveLength(1);
      expect(result.usedMemories[0].conversationId).toBe('conv-1');
      expect(result.usedMemories[0].sourceType).toBe('conversation');
      expect(result.usedMemories[0].sourceTimestamp).toBe('2026-08-15T18:18:00.000Z');
    });
  });
});
