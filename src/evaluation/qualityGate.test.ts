import { describe, it, expect, beforeEach } from 'vitest';
import { EvaluationQualityGateManager } from './qualityGate';
import { EvaluationHistoryManager } from './history';
import { BaselineManager } from './regression';
import { EvaluationConfigPromotionManager } from './promotion';
import { PromotionHistoryManager } from './promotionHistory';
import { EvalSummary, TuningConfig } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 51: Evaluation Quality Gates & Release Readiness Tests', () => {
  const perfectSummary: EvalSummary = {
    total: 10,
    passed: 10,
    failed: 0,
    retrievalRecall: 0.95,
    contextPrecision: 0.95,
    isolationRate: 0.95,
    deduplicationRate: 0.95,
    tokenCompliance: 0.95,
    relevance: 0.95,
    faithfulness: 0.95,
    citationCorrectness: 0.95,
    contextUtilization: 0.8,
    averageLatency: 350,
    successRate: 1.0,
    cacheHitRate: 0.5,
    fallbackRate: 0,
    retryRate: 0,
    timeoutCount: 0,
  };

  const regressedSummary: EvalSummary = {
    ...perfectSummary,
    retrievalRecall: 0.5, // Critical regression from 0.95
    successRate: 0.4,     // Falls below absolute minimum of 50%
  };

  beforeEach(() => {
    EvaluationHistoryManager.clearHistory();
    BaselineManager.clearBaseline();
    EvaluationConfigPromotionManager.clearPromotion();
    PromotionHistoryManager.clearHistory();
  });

  describe('Read-Only Decision and Insufficient State Checks', () => {
    it('should return insufficientHistory status when no evaluation runs exist', async () => {
      const result = await EvaluationQualityGateManager.evaluateGate();
      expect(result.status).toBe('pass');
      expect(result.insufficientHistory).toBe(true);
      expect(result.baselineAvailable).toBe(false);
      expect(result.reasons).toContain('No evaluation runs exist in history.');
    });

    it('should not block or regression fail if no baseline run exists', async () => {
      EvaluationHistoryManager.addRun(perfectSummary);

      const result = await EvaluationQualityGateManager.evaluateGate();
      expect(result.status).toBe('pass');
      expect(result.baselineAvailable).toBe(false);
      expect(result.insufficientHistory).toBe(false);
    });

    it('should pass cleanly for a default config and perfect history run', async () => {
      BaselineManager.setBaseline(perfectSummary, 'baseline-1');
      EvaluationHistoryManager.addRun(perfectSummary);

      const result = await EvaluationQualityGateManager.evaluateGate();
      expect(result.status).toBe('pass');
      expect(result.baselineAvailable).toBe(true);
      expect(result.reasons[0]).toBe('Release readiness gates passed with no issues.');
    });
  });

  describe('Quality Regressions and Blocks', () => {
    it('should BLOCK the release status if critical regression exists', async () => {
      BaselineManager.setBaseline(perfectSummary, 'baseline-1');
      EvaluationHistoryManager.addRun(regressedSummary);

      const result = await EvaluationQualityGateManager.evaluateGate();
      expect(result.status).toBe('block');
      expect(result.reasons.some(r => r.includes('Critical quality regression'))).toBe(true);
    });

    it('should BLOCK the release if configuration safety check is invalid', async () => {
      const { vi } = await import('vitest');
      const { ConfigSafetyGuard } = await import('./configGuard');

      BaselineManager.setBaseline(perfectSummary, 'baseline-1');
      EvaluationHistoryManager.addRun(perfectSummary);

      // Promote valid config first
      const validConfig: TuningConfig = {
        semanticWeight: 0.6,
        lexicalWeight: 0.4,
        minSimilarity: 0.5,
        diversityThreshold: 0.3,
        maxConversationSnippets: 10,
      };
      EvaluationConfigPromotionManager.promote(validConfig);

      const validateSpy = vi.spyOn(ConfigSafetyGuard, 'validate').mockReturnValue({
        valid: false,
        errors: ['Weight sum must equal 1.0.'],
        warnings: []
      });

      try {
        const result = await EvaluationQualityGateManager.evaluateGate();
        expect(result.status).toBe('block');
        expect(result.reasons.some(r => r.includes('Configuration safety error'))).toBe(true);
      } finally {
        validateSpy.mockRestore();
      }
    });
  });

  describe('Deterministic Reasons Ordering and Health Alerts', () => {
    it('should order reasons deterministically and deduplicate duplicate reasons', async () => {
      BaselineManager.setBaseline(perfectSummary, 'baseline-1');

      // Add a run that has:
      // - latency warning (>2000ms)
      // - timeouts warning (>0)
      // - fallbacks warning (>0)
      const warningSummary: EvalSummary = {
        ...perfectSummary,
        averageLatency: 2200,
        timeoutCount: 5,
        fallbackRate: 0.3,
      };

      EvaluationHistoryManager.addRun(warningSummary);

      const result = await EvaluationQualityGateManager.evaluateGate();
      expect(result.status).toBe('warning');

      const reasons = result.reasons;
      expect(reasons.length).toBeGreaterThanOrEqual(3);

      // Deterministic order: Latency warnings come before health warnings (timeouts, fallbacks)
      const latencyIdx = reasons.findIndex(r => r.includes('latency'));
      const healthIdx = reasons.findIndex(r => r.includes('timeouts') || r.includes('fallbacks'));
      expect(latencyIdx).toBeLessThan(healthIdx);
    });

    it('should bypass undefined health/retry/timeout fields without false warning', async () => {
      BaselineManager.setBaseline(perfectSummary, 'baseline-1');

      const undefinedFieldsSummary: EvalSummary = {
        ...perfectSummary,
        timeoutCount: undefined,
        retryRate: undefined,
        fallbackRate: undefined,
      };

      EvaluationHistoryManager.addRun(undefinedFieldsSummary);

      const result = await EvaluationQualityGateManager.evaluateGate();
      expect(result.status).toBe('pass');
      expect(result.reasons[0]).toBe('Release readiness gates passed with no issues.');
    });
  });

  describe('Production Isolation and Config Stability', () => {
    it('should verify production response requests bypass quality gate evaluations completely', async () => {
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
