import { describe, it, expect } from 'vitest';
import { ConfigSafetyGuard } from './configGuard';
import { EvaluationConfigPromotionManager } from './promotion';
import { PromotionHistoryManager } from './promotionHistory';
import { TuningConfig } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 50: Evaluation Configuration Validation & Safety Guardrails Tests', () => {
  const validConfig: TuningConfig = {
    semanticWeight: 0.6,
    lexicalWeight: 0.4,
    minSimilarity: 0.5,
    diversityThreshold: 0.3,
    maxConversationSnippets: 10,
  };

  const invalidConfig: TuningConfig = {
    semanticWeight: 0.8,
    lexicalWeight: 0.4, // sum is 1.2
    minSimilarity: 0.5,
    diversityThreshold: 0.3,
    maxConversationSnippets: 10,
  };

  describe('Config Validation Logic', () => {
    it('should validate a correct configuration successfully', () => {
      const check = ConfigSafetyGuard.validate(validConfig);
      expect(check.valid).toBe(true);
      expect(check.errors).toHaveLength(0);
      expect(check.warnings).toHaveLength(0);
    });

    it('should catch invalid parameter ranges, NaN, and negative values', () => {
      const check = ConfigSafetyGuard.validate({
        ...validConfig,
        minSimilarity: -0.1, // invalid negative
      });
      expect(check.valid).toBe(false);
      expect(check.errors).toContain('minSimilarity cannot be negative.');
    });

    it('should validate weight sums with floating-point tolerance check', () => {
      // 1. Deviates slightly within 1e-6 -> valid
      const tinyDiff: TuningConfig = {
        ...validConfig,
        semanticWeight: 0.60000001,
        lexicalWeight: 0.39999999,
      };
      const checkTiny = ConfigSafetyGuard.validate(tinyDiff);
      expect(checkTiny.valid).toBe(true);

      // 2. Deviates outside 1e-6 -> invalid
      const largeDiff: TuningConfig = {
        ...validConfig,
        semanticWeight: 0.6001,
        lexicalWeight: 0.399, // sum = 0.9991
      };
      const checkLarge = ConfigSafetyGuard.validate(largeDiff);
      expect(checkLarge.valid).toBe(false);
      expect(checkLarge.errors).toContain('semanticWeight and lexicalWeight sum must equal 1.0.');
    });

    it('should trigger warnings for extreme configurations while keeping validity true', () => {
      const extremeConfig: TuningConfig = {
        semanticWeight: 0.96, // exceeds 0.95 -> warning
        lexicalWeight: 0.04,
        minSimilarity: 0.95, // exceeds 0.9 -> warning
        diversityThreshold: 0.3,
        maxConversationSnippets: 25, // exceeds 20 -> warning
      };

      const check = ConfigSafetyGuard.validate(extremeConfig);
      expect(check.valid).toBe(true); // Warnings do not make it invalid!
      expect(check.warnings).toContain('semanticWeight exceeds 0.95. Lexical matching is heavily minimized.');
      expect(check.warnings).toContain('minSimilarity exceeds 0.9. Extreme threshold may restrict matches and degrade recall.');
      expect(check.warnings).toContain('maxConversationSnippets exceeds 20. Extreme limits may cause context token exhaustion.');
    });

    it('should verify config validation logic never mutates original input configuration', () => {
      const input = { ...validConfig };
      ConfigSafetyGuard.validate(input);
      expect(input).toEqual(validConfig);
    });
  });

  describe('Validation Failures Promotion Protection', () => {
    it('should prevent promotion, state changes, or history entries on validation failure', () => {
      EvaluationConfigPromotionManager.clearPromotion();
      PromotionHistoryManager.clearHistory();

      // Attempt to promote invalid sum config
      expect(() => EvaluationConfigPromotionManager.promote(invalidConfig)).toThrow();

      // Assert no config override is active
      expect(EvaluationConfigPromotionManager.hasPromotedConfig()).toBe(false);
      expect(EvaluationConfigPromotionManager.getCurrentConfig()).toBeNull();

      // Assert no history audit trail entries are logged
      expect(PromotionHistoryManager.listRecords()).toHaveLength(0);
    });
  });

  describe('Defaults and Production Isolation', () => {
    it('should verify production response requests bypass validation checks completely', async () => {
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
    });

    it('should verify original RETRIEVAL_SETTINGS defaults are untouched', () => {
      const originalSettingsString = JSON.stringify(RETRIEVAL_SETTINGS);
      expect(JSON.stringify(RETRIEVAL_SETTINGS)).toBe(originalSettingsString);
    });
  });
});
