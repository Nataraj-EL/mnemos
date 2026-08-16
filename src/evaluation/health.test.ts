import { describe, it, expect, vi } from 'vitest';
import { HealthTracker } from '@/response/healthTracker';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';
import { ConversationRetriever } from '@/conversation/retriever';

describe('Sprint 40: Retrieval Health Monitoring Tests', () => {
  describe('HealthTracker Unit Tests', () => {
    it('should initialize with undefined retrieval, cache, and fallback states', () => {
      const tracker = new HealthTracker();
      const summary = tracker.getSummary();

      expect(summary.memoryRetrievalSuccess).toBeUndefined();
      expect(summary.conversationRetrievalSuccess).toBeUndefined();
      expect(summary.memoryCacheHit).toBeUndefined();
      expect(summary.conversationCacheHit).toBeUndefined();
      expect(summary.memoryFallbackUsed).toBeUndefined();
      expect(summary.conversationFallbackUsed).toBeUndefined();
      expect(summary.retryOccurred).toBe(false);
      expect(summary.timeoutOccurred).toBe(false);
      expect(summary.latencyAvailable).toBe(false);
    });

    it('should aggregate request-level signals, not raw event counts', () => {
      const tracker = new HealthTracker();
      tracker.setMemoryCacheHit(true);
      tracker.setMemoryCacheHit(true); // Redundant calls shouldn't mutate rate calculations
      tracker.setRetryOccurred(true);
      tracker.setTimeoutOccurred(true);
      tracker.setLatencyAvailable(true);

      const summary = tracker.getSummary();
      expect(summary.memoryCacheHit).toBe(true);
      expect(summary.retryOccurred).toBe(true);
      expect(summary.timeoutOccurred).toBe(true);
      expect(summary.latencyAvailable).toBe(true);
    });
  });

  describe('Integration with ResponseService', () => {
    it('should track memory-only retrieval and keep conversation states undefined', async () => {
      const mockGenerator = {
        generateResponse: vi.fn().mockImplementation(async () => {
          return { text: 'Answer', metadata: { model: 'gemini-3.5-flash' } };
        }),
      };
      const mockRetriever = {
        retrieve: vi.fn().mockImplementation(async () => {
          return [];
        }),
      };
      const mockAssembler = {
        assemble: vi.fn().mockImplementation(() => {
          return { items: [], context: '', tokenCount: 0, governance: {} };
        }),
      };

      const service = new ResponseService(
        mockRetriever as unknown as MemoryRetriever,
        mockAssembler as unknown as ContextAssembler,
        mockGenerator as unknown as ResponseGenerator
      );

      const result = await service.respond('user-1', 'hi', {
        evaluationRun: true,
      });

      expect(result.diagnostics?.health).toBeDefined();
      expect(result.diagnostics?.health?.memoryRetrievalSuccess).toBe(true);
      expect(result.diagnostics?.health?.memoryCacheHit).toBe(false);
      expect(result.diagnostics?.health?.memoryFallbackUsed).toBe(false);

      // Conversation elements were not executed, so they must be undefined
      expect(result.diagnostics?.health?.conversationRetrievalSuccess).toBeUndefined();
      expect(result.diagnostics?.health?.conversationCacheHit).toBeUndefined();
      expect(result.diagnostics?.health?.conversationFallbackUsed).toBeUndefined();
    });

    it('should track conversation-only retrieval states if simulated', async () => {
      // Create a scenario where conversation retriever runs but memory retriever throws and is caught,
      // or we can test this by checking that conversationRetriever states are set when it runs.
      const mockGenerator = {
        generateResponse: vi.fn().mockImplementation(async () => {
          return { text: 'Answer', metadata: { model: 'gemini-3.5-flash' } };
        }),
      };
      const mockRetriever = {
        retrieve: vi.fn().mockImplementation(async () => {
          return [];
        }),
      };
      const mockAssembler = {
        assemble: vi.fn().mockImplementation(() => {
          return { items: [], context: '', tokenCount: 0, governance: {} };
        }),
      };
      const mockConvRetriever = {
        retrieveSnippets: vi.fn().mockImplementation(async () => {
          return [];
        }),
      };

      const service = new ResponseService(
        mockRetriever as unknown as MemoryRetriever,
        mockAssembler as unknown as ContextAssembler,
        mockGenerator as unknown as ResponseGenerator,
        undefined,
        mockConvRetriever as unknown as ConversationRetriever
      );

      const result = await service.respond('user-1', 'hi', {
        evaluationRun: true,
      });

      expect(result.diagnostics?.health?.memoryRetrievalSuccess).toBe(true);
      // Both retrieval paths executed
      expect(result.diagnostics?.health?.conversationRetrievalSuccess).toBe(true);
      expect(result.diagnostics?.health?.conversationCacheHit).toBe(false);
      expect(result.diagnostics?.health?.conversationFallbackUsed).toBe(false);
    });

    it('should record timeout without retry on deterministic stage timeout error', async () => {
      const mockRetriever = {
        retrieve: vi.fn().mockImplementation(async () => {
          throw new Error('Timeout: memoryRetrieval stage exceeded limit');
        }),
      };
      const mockAssembler = {
        assemble: vi.fn(),
      };
      const mockGenerator = {
        generateResponse: vi.fn(),
      };

      const service = new ResponseService(
        mockRetriever as unknown as MemoryRetriever,
        mockAssembler as unknown as ContextAssembler,
        mockGenerator as unknown as ResponseGenerator
      );

      try {
        await service.respond('user-1', 'hi', {
          evaluationRun: true,
        });
        expect.fail('Should have thrown timeout error');
      } catch (err: unknown) {
        const diagnostics = (err as unknown as { diagnostics?: { health?: { timeoutOccurred?: boolean; retryOccurred?: boolean; memoryRetrievalSuccess?: boolean } } }).diagnostics;
        expect(diagnostics).toBeDefined();
        expect(diagnostics?.health?.timeoutOccurred).toBe(true);
        expect(diagnostics?.health?.retryOccurred).toBe(false);
        expect(diagnostics?.health?.memoryRetrievalSuccess).toBe(false);
      }
    });

    it('should preserve undefined diagnostics for normal production queries', async () => {
      const mockGenerator = {
        generateResponse: vi.fn().mockImplementation(async () => {
          return { text: 'Answer', metadata: { model: 'gemini-3.5-flash' } };
        }),
      };
      const mockRetriever = {
        retrieve: vi.fn().mockImplementation(async () => {
          return [];
        }),
      };
      const mockAssembler = {
        assemble: vi.fn().mockImplementation(() => {
          return { items: [], context: '', tokenCount: 0, governance: {} };
        }),
      };

      const service = new ResponseService(
        mockRetriever as unknown as MemoryRetriever,
        mockAssembler as unknown as ContextAssembler,
        mockGenerator as unknown as ResponseGenerator
      );

      const result = await service.respond('user-1', 'hi', {
        evaluationRun: false,
      });

      expect(result.diagnostics).toBeUndefined();
    });
  });

  describe('UI Metric Denominator Rate Calculations', () => {
    const calculateRates = (evalResults: { passed: boolean; diagnostics?: { health?: { memoryCacheHit?: boolean; conversationCacheHit?: boolean; memoryFallbackUsed?: boolean; conversationFallbackUsed?: boolean; retryOccurred: boolean; timeoutOccurred: boolean } } }[]) => {
      const successCount = evalResults.filter(r => r.passed).length;
      let cacheHits = 0;
      let cacheSamples = 0;
      let fallbackHits = 0;
      let fallbackSamples = 0;
      let retryCount = 0;
      let timeoutCount = 0;

      for (const r of evalResults) {
        const health = r.diagnostics?.health;
        if (health) {
          if (health.memoryCacheHit !== undefined) {
            cacheSamples++;
            if (health.memoryCacheHit) cacheHits++;
          }
          if (health.conversationCacheHit !== undefined) {
            cacheSamples++;
            if (health.conversationCacheHit) cacheHits++;
          }
          if (health.memoryFallbackUsed !== undefined) {
            fallbackSamples++;
            if (health.memoryFallbackUsed) fallbackHits++;
          }
          if (health.conversationFallbackUsed !== undefined) {
            fallbackSamples++;
            if (health.conversationFallbackUsed) fallbackHits++;
          }
          if (health.retryOccurred) {
            retryCount++;
          }
          if (health.timeoutOccurred) {
            timeoutCount++;
          }
        }
      }

      const cacheHitRate = cacheSamples > 0 ? (cacheHits / cacheSamples) : 0;
      const fallbackRate = fallbackSamples > 0 ? (fallbackHits / fallbackSamples) : 0;
      const retryRate = evalResults.length > 0 ? (retryCount / evalResults.length) : 0;
      const successRate = evalResults.length > 0 ? (successCount / evalResults.length) : 0;

      return {
        successRate,
        cacheHitRate,
        fallbackRate,
        retryRate,
        timeoutCount,
      };
    };

    it('should calculate rates using correct denominator ignoring undefined stages', () => {
      const mockResults = [
        {
          passed: true,
          diagnostics: {
            health: {
              memoryCacheHit: true,
              conversationCacheHit: undefined, // Ignored from denominator
              memoryFallbackUsed: false,
              conversationFallbackUsed: undefined,
              retryOccurred: false,
              timeoutOccurred: false,
            },
          },
        },
        {
          passed: false,
          diagnostics: {
            health: {
              memoryCacheHit: false,
              conversationCacheHit: false, // Counted
              memoryFallbackUsed: true,
              conversationFallbackUsed: false,
              retryOccurred: true,
              timeoutOccurred: true,
            },
          },
        },
      ];

      const rates = calculateRates(mockResults);

      expect(rates.successRate).toBe(0.5); // 1 passed out of 2
      // Cache Hits: memory (1 hit, 1 miss) + conv (0 hit, 1 miss). Total hits = 1. Total applicable samples = 3.
      expect(rates.cacheHitRate).toBe(1 / 3);
      // Fallbacks: memory (0 fallback, 1 fallback) + conv (0 fallback). Total fallbacks = 1. Total applicable = 3.
      expect(rates.fallbackRate).toBe(1 / 3);
      expect(rates.retryRate).toBe(0.5); // 1 scenario with retry out of 2
      expect(rates.timeoutCount).toBe(1);
    });

    it('should return 0 for rates when evalResults is empty', () => {
      const rates = calculateRates([]);

      expect(rates.successRate).toBe(0);
      expect(rates.cacheHitRate).toBe(0);
      expect(rates.fallbackRate).toBe(0);
      expect(rates.retryRate).toBe(0);
      expect(rates.timeoutCount).toBe(0);
    });
  });
});
