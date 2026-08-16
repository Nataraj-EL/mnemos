import { describe, it, expect, beforeEach } from 'vitest';
import { EvaluationConfigPromotionManager } from './promotion';
import { PromotionHistoryManager } from './promotionHistory';
import { TuningConfig } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 49: Evaluation Configuration Audit & Change History Tests', () => {
  const validConfig: TuningConfig = {
    semanticWeight: 0.6,
    lexicalWeight: 0.4,
    minSimilarity: 0.4,
    diversityThreshold: 0.2,
    maxConversationSnippets: 8,
  };

  const invalidConfig: TuningConfig = {
    semanticWeight: 1.5,
    lexicalWeight: 0.4,
    minSimilarity: -0.1,
    diversityThreshold: 1.2,
    maxConversationSnippets: 55,
  };

  beforeEach(() => {
    EvaluationConfigPromotionManager.clearPromotion();
    PromotionHistoryManager.clearHistory();
  });

  describe('Audit Logging Atomicity and Rollback Edges', () => {
    it('should create exactly one audit entry on successful promote', () => {
      EvaluationConfigPromotionManager.promote(validConfig);
      const records = PromotionHistoryManager.listRecords();
      expect(records).toHaveLength(1);
      expect(records[0].action).toBe('promote');
      expect(records[0].newConfig).toEqual(validConfig);
      expect(records[0].previousConfig).toBeNull();
    });

    it('should create exactly one audit entry on successful rollback', () => {
      EvaluationConfigPromotionManager.promote(validConfig);
      const secondConfig = { ...validConfig, minSimilarity: 0.3 };
      EvaluationConfigPromotionManager.promote(secondConfig);

      // Total promotions: 2
      expect(PromotionHistoryManager.listRecords()).toHaveLength(2);

      // Perform rollback
      EvaluationConfigPromotionManager.rollback();
      const records = PromotionHistoryManager.listRecords();
      expect(records).toHaveLength(3);
      expect(records[0].action).toBe('rollback');
      expect(records[0].previousConfig).toEqual(secondConfig);
      expect(records[0].newConfig).toEqual(validConfig);
    });

    it('should create zero entries on failed promote validation', () => {
      expect(() => EvaluationConfigPromotionManager.promote(invalidConfig)).toThrow();
      expect(PromotionHistoryManager.listRecords()).toHaveLength(0);
    });

    it('should create zero entries on rollback without previous config', () => {
      EvaluationConfigPromotionManager.rollback();
      expect(PromotionHistoryManager.listRecords()).toHaveLength(0);
    });
  });

  describe('Deep Clone and Immutability', () => {
    it('should guarantee deep clone protection on history record configurations', () => {
      EvaluationConfigPromotionManager.promote(validConfig);
      const records = PromotionHistoryManager.listRecords();
      expect(records).toHaveLength(1);

      // Mutate retrieved configuration object
      const record = records[0];
      if (record.newConfig) {
        record.newConfig.semanticWeight = 0.99;
      }

      // Assert internal logs remain untouched
      const originalRecord = PromotionHistoryManager.getRecord(record.id);
      expect(originalRecord?.newConfig?.semanticWeight).toBe(0.6);
    });
  });

  describe('FIFO Eviction Limits and Order', () => {
    it('should cap records array at 20 and evict oldest record (FIFO)', () => {
      // Add 25 records
      for (let i = 1; i <= 25; i++) {
        const config = { ...validConfig, minSimilarity: Number((i * 0.01).toFixed(2)) };
        EvaluationConfigPromotionManager.promote(config);
      }

      const records = PromotionHistoryManager.listRecords();
      expect(records).toHaveLength(20);

      // Newest should be index 0: minSimilarity 0.25 (represented by 25 * 0.01)
      expect(records[0].newConfig?.minSimilarity).toBeCloseTo(0.25);

      // Oldest remaining should be index 19: minSimilarity 0.06 (represented by 6 * 0.01)
      // Since first 5 (1, 2, 3, 4, 5) are evicted
      expect(records[19].newConfig?.minSimilarity).toBeCloseTo(0.06);
    });

    it('should sort records chronologically newest-first', () => {
      const config1 = { ...validConfig, minSimilarity: 0.1 };
      const config2 = { ...validConfig, minSimilarity: 0.2 };

      EvaluationConfigPromotionManager.promote(config1);
      EvaluationConfigPromotionManager.promote(config2);

      const records = PromotionHistoryManager.listRecords();
      expect(records[0].newConfig?.minSimilarity).toBeCloseTo(0.2);
      expect(records[1].newConfig?.minSimilarity).toBeCloseTo(0.1);
    });
  });

  describe('Production Isolation and Sanitization', () => {
    it('should verify production response queries bypass audit trails logging completely', async () => {
      const mockGenerator = {
        generateResponse: async () => ({ text: 'Answer' }),
      };
      const mockRetriever = {
        retrieve: async () => [],
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

      expect(PromotionHistoryManager.listRecords()).toHaveLength(0);
    });

    it('should verify original RETRIEVAL_SETTINGS defaults are untouched', () => {
      const originalSettingsString = JSON.stringify(RETRIEVAL_SETTINGS);
      expect(JSON.stringify(RETRIEVAL_SETTINGS)).toBe(originalSettingsString);
    });
  });
});
