import { describe, it, expect, vi } from 'vitest';
import { normalizeMetadata, deriveLifecycleState, Memory, MemoryType, MemoryMetadata } from '@/core/types';
import { ContextAssembler } from '@/context/assembler';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { PgMemoryRepository } from '@/memory/repository';
import { MemoryConsolidationService } from '@/memory/consolidationService';

const mockMemory = (
  id: string,
  userId: string,
  content: string,
  type: MemoryType = 'FACT',
  metadata: Partial<MemoryMetadata> = {}
): Memory => ({
  id,
  userId,
  type,
  content,
  metadata: {
    source: 'chat',
    confidence: metadata.confidence ?? 0.9,
    importance: metadata.importance ?? 5,
    timestamp: metadata.timestamp || new Date().toISOString(),
    status: metadata.status || 'active',
    accessCount: metadata.accessCount,
    lastAccessedAt: metadata.lastAccessedAt,
    reinforcementCount: metadata.reinforcementCount,
    lifecycleUpdatedAt: metadata.lifecycleUpdatedAt,
    supersedes: metadata.supersedes,
    supersededBy: metadata.supersededBy,
    validFrom: metadata.validFrom,
    validUntil: metadata.validUntil,
  },
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('Sprint 8 Memory Lifecycle Intelligence', () => {
  describe('normalizeMetadata', () => {
    it('should fall back to safe metadata defaults for backward compatibility', () => {
      const nowStr = new Date().toISOString();
      const legacyMeta = {
        source: 'chat',
        confidence: 0.8,
        importance: 6,
        timestamp: nowStr,
      };

      const normalized = normalizeMetadata(legacyMeta);
      expect(normalized.accessCount).toBe(0);
      expect(normalized.reinforcementCount).toBe(0);
      expect(normalized.lastAccessedAt).toBe(nowStr);
      expect(normalized.lifecycleUpdatedAt).toBe(nowStr);
      expect(normalized.confidence).toBe(0.8);
      expect(normalized.importance).toBe(6);
    });
  });

  describe('deriveLifecycleState', () => {
    it('should dynamically derive core, stable, fading, and historical states', () => {
      const now = new Date();

      // Historical: status is superseded
      const hist = mockMemory('1', 'u', 'fact', 'FACT', { status: 'superseded' });
      expect(deriveLifecycleState(hist, now)).toBe('historical');

      // Core: importance >= 8, confidence >= 0.8, active, decayFactor >= 0.5 (recently accessed)
      const core = mockMemory('2', 'u', 'fact', 'FACT', {
        importance: 9,
        confidence: 0.85,
        lastAccessedAt: now.toISOString(),
      });
      expect(deriveLifecycleState(core, now)).toBe('core');

      // Stable: confidence >= 0.5 or accessCount >= 5, decayFactor >= 0.5
      const stable = mockMemory('3', 'u', 'fact', 'FACT', {
        importance: 5,
        confidence: 0.6,
        lastAccessedAt: now.toISOString(),
      });
      expect(deriveLifecycleState(stable, now)).toBe('stable');

      // Fading: decayFactor < 0.5 (accessed long ago, half-life 90 days, let's use 100 days ago)
      const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();
      const fading = mockMemory('4', 'u', 'fact', 'FACT', {
        importance: 9,
        confidence: 0.9,
        lastAccessedAt: hundredDaysAgo,
        timestamp: hundredDaysAgo,
      });
      expect(deriveLifecycleState(fading, now)).toBe('fading');
    });
  });

  describe('Decay and Context Scoring', () => {
    it('should decrease retrieval score for older, dormant memories based on decayFactor', () => {
      const assembler = new ContextAssembler();
      const now = new Date();
      const tenDaysAgoStr = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const hundredDaysAgoStr = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();

      const freshMemory = mockMemory('mem-fresh', 'user-1', 'Active preference content', 'PREFERENCE', {
        timestamp: tenDaysAgoStr,
        lastAccessedAt: tenDaysAgoStr,
        confidence: 0.9,
        importance: 8,
      });

      const dormantMemory = mockMemory('mem-dormant', 'user-1', 'Dormant fact content', 'PREFERENCE', {
        timestamp: tenDaysAgoStr, // original observation was recent
        lastAccessedAt: hundredDaysAgoStr, // but not accessed for 100 days
        confidence: 0.9,
        importance: 8,
      });

      const res = assembler.assemble(
        'preference',
        [
          { memory: freshMemory, similarity: 0.8 },
          { memory: dormantMemory, similarity: 0.8 },
        ],
        1000,
        false
      );

      expect(res.items).toHaveLength(2);
      expect(res.items[0].id).toBe('mem-fresh');
      expect(res.items[1].id).toBe('mem-dormant');
      expect(res.items[0].score).toBeGreaterThan(res.items[1].score);

      // Verify explanation reason contains confidence and decayFactor
      expect(res.items[0].reason).toContain('Conf: 0.90');
      expect(res.items[0].reason).toContain('Decay:');
    });
  });

  describe('Reinforcement', () => {
    it('should increment access count and only reinforce outside of 5 minutes cooldown', async () => {
      const memory = mockMemory('mem-1', 'user-1', 'Preferences content', 'PREFERENCE', {
        confidence: 0.8,
        accessCount: 1,
        lastAccessedAt: new Date(Date.now() - 400 * 1000).toISOString(), // 400 seconds ago (outside cooldown)
      });

      const repoMock = {
        async get() {
          return memory;
        },
        update: vi.fn().mockImplementation((_id, updates) => {
          return { ...memory, metadata: updates.metadata };
        }),
      } as unknown as PgMemoryRepository;

      const mockRetriever = {
        async retrieve() {
          return [{ memory, similarity: 0.9 }];
        },
      } as unknown as MemoryRetriever;

      const mockGenerator = {
        async generateResponse() {
          return { text: 'Grounded response' };
        },
      };

      const assembler = new ContextAssembler();
      const service = new ResponseService(mockRetriever, assembler, mockGenerator, repoMock);

      // Trigger respond which runs reinforcement
      await service.respond('user-1', 'query');

      // Assert update was called with +1 reinforcementCount and +0.05 confidence
      expect(repoMock.update).toHaveBeenCalledWith(
        'mem-1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            accessCount: 2,
            reinforcementCount: 1,
            confidence: 0.85,
          }),
        })
      );
    });

    it('should respect cooldown and not increment reinforcementCount within 5 minutes', async () => {
      const memory = mockMemory('mem-1', 'user-1', 'Preferences content', 'PREFERENCE', {
        confidence: 0.8,
        accessCount: 1,
        lastAccessedAt: new Date(Date.now() - 100 * 1000).toISOString(), // 100 seconds ago (inside cooldown)
      });

      const repoMock = {
        async get() {
          return memory;
        },
        update: vi.fn().mockImplementation((_id, updates) => {
          return { ...memory, metadata: updates.metadata };
        }),
      } as unknown as PgMemoryRepository;

      const mockRetriever = {
        async retrieve() {
          return [{ memory, similarity: 0.9 }];
        },
      } as unknown as MemoryRetriever;

      const mockGenerator = {
        async generateResponse() {
          return { text: 'Grounded response' };
        },
      };

      const assembler = new ContextAssembler();
      const service = new ResponseService(mockRetriever, assembler, mockGenerator, repoMock);

      await service.respond('user-1', 'query');

      // Assert update was called with +1 accessCount but reinforcementCount and confidence remain unchanged
      expect(repoMock.update).toHaveBeenCalledWith(
        'mem-1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            accessCount: 2,
            reinforcementCount: 0,
            confidence: 0.8,
          }),
        })
      );
    });

    it('should cap confidence at 1.0 ceiling limit', async () => {
      const memory = mockMemory('mem-1', 'user-1', 'Preferences content', 'PREFERENCE', {
        confidence: 0.98,
        accessCount: 1,
        lastAccessedAt: new Date(Date.now() - 400 * 1000).toISOString(), // outside cooldown
      });

      const repoMock = {
        async get() {
          return memory;
        },
        update: vi.fn().mockImplementation((_id, updates) => {
          return { ...memory, metadata: updates.metadata };
        }),
      } as unknown as PgMemoryRepository;

      const mockRetriever = {
        async retrieve() {
          return [{ memory, similarity: 0.9 }];
        },
      } as unknown as MemoryRetriever;

      const mockGenerator = {
        async generateResponse() {
          return { text: 'Grounded response' };
        },
      };

      const assembler = new ContextAssembler();
      const service = new ResponseService(mockRetriever, assembler, mockGenerator, repoMock);

      await service.respond('user-1', 'query');

      // Confidence should be capped at 1.0
      expect(repoMock.update).toHaveBeenCalledWith(
        'mem-1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            confidence: 1.0,
          }),
        })
      );
    });

    it('should only reinforce memories that are actually sliced and included in the final context', async () => {
      const mem1 = mockMemory('mem-1', 'user-1', 'C1', 'FACT', {
        lastAccessedAt: new Date(0).toISOString(),
      });
      const mem2 = mockMemory('mem-2', 'user-1', 'C2', 'FACT', {
        lastAccessedAt: new Date(0).toISOString(),
      });

      const repoMock = {
        async get(id: string) {
          return id === 'mem-1' ? mem1 : mem2;
        },
        update: vi.fn(),
      } as unknown as PgMemoryRepository;

      const mockRetriever = {
        async retrieve() {
          return [
            { memory: mem1, similarity: 0.9 },
            { memory: mem2, similarity: 0.8 },
          ];
        },
      } as unknown as MemoryRetriever;

      const mockGenerator = {
        async generateResponse() {
          return { text: 'res' };
        },
      };

      const assembler = new ContextAssembler();
      const service = new ResponseService(mockRetriever, assembler, mockGenerator, repoMock);

      // Call respond requesting limit = 1. Only mem-1 should end up in finalItems and be reinforced.
      await service.respond('user-1', 'query', { limit: 1 });

      expect(repoMock.update).toHaveBeenCalledWith('mem-1', expect.any(Object));
      expect(repoMock.update).not.toHaveBeenCalledWith('mem-2', expect.any(Object));
    });
  });

  describe('Duplicate Consolidation', () => {
    it('should group duplicates of same type with Jaccard >= 0.70 and soft-supersede them', async () => {
      // Duplicates: "User prefers python" vs "prefers Python" vs "user prefers python language"
      const m1 = mockMemory('m1', 'user-1', 'User prefers python programming', 'PREFERENCE', {
        confidence: 0.8,
        importance: 6,
      });
      const m2 = mockMemory('m2', 'user-1', 'User prefers Python programming language', 'PREFERENCE', {
        confidence: 0.95,
        importance: 5,
      }); // m2 has higher confidence, should become primary

      const repoMock = {
        async list() {
          return [m1, m2];
        },
        update: vi.fn(),
      } as unknown as PgMemoryRepository;

      const service = new MemoryConsolidationService(repoMock);
      const result = await service.consolidate('user-1');

      expect(result.consolidatedCount).toBe(1);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].primaryId).toBe('m2'); // selected by highest confidence
      expect(result.actions[0].supersededIds).toContain('m1');

      // Assert primary was updated to merge access details and get confidence boost
      expect(repoMock.update).toHaveBeenCalledWith(
        'm2',
        expect.objectContaining({
          metadata: expect.objectContaining({
            confidence: 1.0, // 0.95 + 0.05
            consolidatedFrom: ['m1'],
          }),
        })
      );

      // Assert duplicate was soft-superseded with validUntil link
      expect(repoMock.update).toHaveBeenCalledWith(
        'm1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            status: 'superseded',
            supersededBy: 'm2',
          }),
        })
      );
    });

    it('should NOT consolidate conflicting polarity facts', async () => {
      const m1 = mockMemory('m1', 'user-1', 'User likes PostgreSQL', 'PREFERENCE');
      const m2 = mockMemory('m2', 'user-1', 'User does not like PostgreSQL', 'PREFERENCE');

      const repoMock = {
        async list() {
          return [m1, m2];
        },
        update: vi.fn(),
      } as unknown as PgMemoryRepository;

      const service = new MemoryConsolidationService(repoMock);
      const result = await service.consolidate('user-1');

      expect(result.consolidatedCount).toBe(0);
      expect(repoMock.update).not.toHaveBeenCalled();
    });

    it('should remain user isolated during consolidation', async () => {
      const m1 = mockMemory('m1', 'user-1', 'Same content', 'FACT');

      const repoMock = {
        async list(filter: { userId?: string }) {
          // repository is user isolated, returns only user-1
          expect(filter.userId).toBe('user-1');
          return [m1];
        },
        update: vi.fn(),
      } as unknown as PgMemoryRepository;

      const service = new MemoryConsolidationService(repoMock);
      const result = await service.consolidate('user-1');

      expect(result.consolidatedCount).toBe(0);
      expect(repoMock.update).not.toHaveBeenCalled();
    });
  });
});
