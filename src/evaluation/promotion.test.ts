import { describe, it, expect, beforeEach } from 'vitest';
import { EvaluationConfigPromotionManager } from './promotion';
import { TuningConfig } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';
import { EvaluationRunner } from './runner';
import { EvalScenario } from './types';

describe('Sprint 48: Configuration Recommendation & Promotion Workflow Tests', () => {
  const validConfig: TuningConfig = {
    semanticWeight: 0.6,
    lexicalWeight: 0.4,
    minSimilarity: 0.4,
    diversityThreshold: 0.2,
    maxConversationSnippets: 8,
  };

  const invalidConfig: TuningConfig = {
    semanticWeight: 1.5, // invalid semantic/lexical sum
    lexicalWeight: 0.4,
    minSimilarity: -0.1, // out of bounds
    diversityThreshold: 1.2,
    maxConversationSnippets: 55, // excessive limit
  };

  beforeEach(() => {
    EvaluationConfigPromotionManager.clearPromotion();
  });

  describe('Promotion Mechanics and Validations', () => {
    it('should successfully promote a valid configuration', () => {
      EvaluationConfigPromotionManager.promote(validConfig);
      expect(EvaluationConfigPromotionManager.hasPromotedConfig()).toBe(true);
      expect(EvaluationConfigPromotionManager.getCurrentConfig()).toEqual(validConfig);
    });

    it('should reject out of bounds or invalid parameter configuration promotions', () => {
      expect(() => EvaluationConfigPromotionManager.promote(invalidConfig)).toThrow();
      expect(EvaluationConfigPromotionManager.hasPromotedConfig()).toBe(false);
    });

    it('should guarantee deep copy immutability when promoting and retrieving config objects', () => {
      const configToPromote = { ...validConfig };
      EvaluationConfigPromotionManager.promote(configToPromote);

      // Mutate original object
      configToPromote.semanticWeight = 0.9;
      expect(EvaluationConfigPromotionManager.getCurrentConfig()?.semanticWeight).toBe(0.6);

      // Mutate retrieved object
      const retrieved = EvaluationConfigPromotionManager.getCurrentConfig()!;
      retrieved.semanticWeight = 0.9;
      expect(EvaluationConfigPromotionManager.getCurrentConfig()?.semanticWeight).toBe(0.6);
    });
  });

  describe('Rollback Semantics', () => {
    it('should restore immediately previous configuration on rollback and clear previous slot', () => {
      // First promotion
      EvaluationConfigPromotionManager.promote(validConfig);

      // Second promotion
      const secondConfig = { ...validConfig, minSimilarity: 0.3 };
      EvaluationConfigPromotionManager.promote(secondConfig);

      expect(EvaluationConfigPromotionManager.getCurrentConfig()).toEqual(secondConfig);
      expect(EvaluationConfigPromotionManager.getPreviousConfig()).toEqual(validConfig);

      // First rollback
      EvaluationConfigPromotionManager.rollback();
      expect(EvaluationConfigPromotionManager.getCurrentConfig()).toEqual(validConfig);
      expect(EvaluationConfigPromotionManager.getPreviousConfig()).toBeNull();

      // Second rollback (should be safe no-op since previous slot is clear)
      EvaluationConfigPromotionManager.rollback();
      expect(EvaluationConfigPromotionManager.getCurrentConfig()).toEqual(validConfig);
    });

    it('should be a safe no-op when executing rollback with no previous configuration', () => {
      expect(() => EvaluationConfigPromotionManager.rollback()).not.toThrow();
      expect(EvaluationConfigPromotionManager.getCurrentConfig()).toBeNull();
    });

    it('should preserve only the immediately previous configuration on repeated promotions', () => {
      const config1 = { ...validConfig, minSimilarity: 0.1 };
      const config2 = { ...validConfig, minSimilarity: 0.2 };
      const config3 = { ...validConfig, minSimilarity: 0.3 };

      EvaluationConfigPromotionManager.promote(config1);
      EvaluationConfigPromotionManager.promote(config2);
      EvaluationConfigPromotionManager.promote(config3);

      // Should rollback only to config2, not config1
      EvaluationConfigPromotionManager.rollback();
      expect(EvaluationConfigPromotionManager.getCurrentConfig()).toEqual(config2);
      expect(EvaluationConfigPromotionManager.getPreviousConfig()).toBeNull();
    });
  });

  describe('Precedence Order and Integrations', () => {
    const mockScenario: EvalScenario = {
      scenarioId: 'scen-1',
      name: 'PostgreSQL setup scenario',
      isPersonal: false,
      userId: 'user-1',
      query: 'PostgreSQL setups',
      maxTokens: 1000,
      inputMemories: [
        {
          id: 'mem-1',
          userId: 'user-1',
          content: 'postgresql setup database',
          type: 'FACT',
          metadata: {
            category: 'technical',
            status: 'active',
            source: 'chat',
            confidence: 1.0,
            importance: 1,
            timestamp: new Date().toISOString(),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      expectedRelevantIds: ['mem-1'],
    };

    it('should resolve configs with priority override > promoted > default settings', async () => {
      // 1. Promoted config active
      const promoted = { ...validConfig, minSimilarity: 0.8 };
      EvaluationConfigPromotionManager.promote(promoted);

      const runner = new EvaluationRunner(
        { assemble: () => ({ items: [], context: '', tokenCount: 0, governance: {} }) } as unknown as ContextAssembler,
        { generateResponse: async () => ({ text: 'mock text' }) } as unknown as ResponseGenerator
      );

      // Explicit override has highest precedence
      // We pass minSimilarity: 0.1, which should match similar memory (similarity 0.9)
      const resOverride = await runner.runScenario(mockScenario, { minSimilarity: 0.1 });
      expect(resOverride.metrics.retrievalRecall).toBe(1.0);

      // Promoted config has precedence over default defaults
      // If we pass no override, it uses promoted (minSimilarity: 0.8)
      // Since expected memory similarity is simulated at 0.9 (matches >= 0.8), it is retrieved
      const resPromoted = await runner.runScenario(mockScenario);
      expect(resPromoted.metrics.retrievalRecall).toBe(1.0);

      // If we promote a configuration with minSimilarity: 0.95 (greater than simulated 0.9)
      // Expected memory should fail similarity filter and not be retrieved
      EvaluationConfigPromotionManager.promote({ ...validConfig, minSimilarity: 0.95 });
      const resFailingPromoted = await runner.runScenario(mockScenario);
      expect(resFailingPromoted.metrics.retrievalRecall).toBe(0.0);
    });

    it('should verify production response requests bypass promoted configuration overrides', async () => {
      // Promote config that would restrict retrieval: minSimilarity 0.95
      EvaluationConfigPromotionManager.promote({ ...validConfig, minSimilarity: 0.95 });

      const mockGenerator = {
        generateResponse: async () => ({ text: 'Answer' }),
      };
      const mockRetriever = {
        retrieve: async (_uid: string, _q: string, opts?: Record<string, unknown>) => {
          // Verify that production service calls retrieve with production configuration, not the promoted evaluation config
          // Production default minSimilarity is 0.5 (from RETRIEVAL_SETTINGS)
          expect(opts?.minSimilarity).toBeUndefined(); // should not pass promoted config fields
          return [];
        },
      };
      const mockAssembler = {
        assemble: () => ({ items: [], context: '', tokenCount: 0, governance: {} }),
      };

      const service = new ResponseService(
        mockRetriever as unknown as MemoryRetriever,
        mockAssembler as unknown as ContextAssembler,
        mockGenerator as unknown as ResponseGenerator
      );

      await service.respond('user-1', 'hi', {
        evaluationRun: false, // production
      });
    });

    it('should verify global RETRIEVAL_SETTINGS remains byte-for-byte unchanged', () => {
      const original = JSON.stringify(RETRIEVAL_SETTINGS);
      EvaluationConfigPromotionManager.promote(validConfig);
      expect(JSON.stringify(RETRIEVAL_SETTINGS)).toBe(original);
    });
  });
});
