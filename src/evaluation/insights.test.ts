import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EvaluationHistoryManager } from './history';
import { EvaluationInsightsManager } from './insights';
import { EvalSummary } from './types';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 43: Evaluation Insights & Trend Analysis Tests', () => {
  beforeEach(() => {
    EvaluationHistoryManager.clearHistory();
  });

  const dummySummary: EvalSummary = {
    total: 10,
    passed: 10,
    failed: 0,
    retrievalRecall: 0.90,
    contextPrecision: 0.90,
    isolationRate: 1.0,
    deduplicationRate: 1.0,
    tokenCompliance: 1.0,
    relevance: 0.90,
    faithfulness: 0.90,
    citationCorrectness: 0.90,
    contextUtilization: 0.80,
    averageLatency: 1000,
    successRate: 0.90,
    cacheHitRate: 0.80,
    fallbackRate: 0.10,
    retryRate: 0.05,
    timeoutCount: 0,
  };

  describe('Insufficient History Handling', () => {
    it('should return insufficient status if fewer than 2 runs exist in history', () => {
      expect(EvaluationInsightsManager.generateInsights().status).toBe('insufficient');

      EvaluationHistoryManager.addRun(dummySummary);
      expect(EvaluationInsightsManager.generateInsights().status).toBe('insufficient');
    });
  });

  describe('Latest-vs-Previous Run Ordering', () => {
    it('should compare indices 0 (latest) and 1 (previous) from history runs list', () => {
      // First run added (will become previous, runs[1])
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        retrievalRecall: 0.80,
      });

      // Second run added (will become latest, runs[0])
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        retrievalRecall: 0.95, // recall increased by 0.15 (exceeds recallTolerance of 0.05)
      });

      const insights = EvaluationInsightsManager.generateInsights();
      expect(insights.status).toBe('improving');
      expect(insights.trends.retrievalRecall.type).toBe('improving');
      expect(insights.trends.retrievalRecall.delta).toBeCloseTo(0.15);
    });
  });

  describe('Tolerance / Tiny Changes Tolerance', () => {
    it('should label tiny floating-point changes below or equal to tolerances as stable', () => {
      // Add first run
      EvaluationHistoryManager.addRun(dummySummary);

      // Add second run with tiny noise
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        retrievalRecall: 0.93,       // recall increase of 0.03 <= 0.05 tolerance -> stable
        relevance: 0.91,             // relevance increase of 0.01 <= 0.02 tolerance -> stable
        averageLatency: 1200,        // latency slowdown of +200ms <= 500ms tolerance -> stable
      });

      const insights = EvaluationInsightsManager.generateInsights();
      expect(insights.status).toBe('stable');
      expect(insights.trends.retrievalRecall.type).toBe('stable');
      expect(insights.trends.relevance.type).toBe('stable');
      expect(insights.trends.averageLatency.type).toBe('stable');
    });
  });

  describe('Semantics Directions (Higher vs Lower)', () => {
    it('should correctly classify higher-is-better metrics', () => {
      EvaluationHistoryManager.addRun(dummySummary);
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        retrievalRecall: 0.70, // recall dropped by 0.20 > 0.05 tolerance -> degrading
      });

      const insights = EvaluationInsightsManager.generateInsights();
      expect(insights.trends.retrievalRecall.type).toBe('degrading');
    });

    it('should correctly classify lower-is-better metrics', () => {
      EvaluationHistoryManager.addRun(dummySummary);
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        averageLatency: 400, // latency decreased (improved) by -600ms > 500ms tolerance -> improving
      });

      const insights = EvaluationInsightsManager.generateInsights();
      expect(insights.trends.averageLatency.type).toBe('improving');
    });
  });

  describe('Mixed Improving & Degrading Metrics Trend Resolution', () => {
    it('should determine overall status based on majority count of improves vs degrades', () => {
      EvaluationHistoryManager.addRun(dummySummary);
      
      // Add 2 improvements (recall, prec) and 1 degradation (latency) exceeding tolerances
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        retrievalRecall: 1.0,      // +0.10 recall -> improving
        contextPrecision: 1.0,     // +0.10 precision -> improving
        averageLatency: 1600,      // +600ms latency -> degrading
      });

      const insights = EvaluationInsightsManager.generateInsights();
      expect(insights.status).toBe('improving'); // 2 improves > 1 degrades
    });

    it('should resolve to stable if count of improves equals degrades', () => {
      EvaluationHistoryManager.addRun(dummySummary);

      // Add 1 improvement (recall) and 1 degradation (latency)
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        retrievalRecall: 1.0,      // +0.10 recall -> improving
        averageLatency: 1600,      // +600ms latency -> degrading
      });

      const insights = EvaluationInsightsManager.generateInsights();
      expect(insights.status).toBe('stable'); // 1 improve === 1 degrade
    });
  });

  describe('Missing and Incomplete Metrics', () => {
    it('should flag undefined metrics as notComparable and ignore them from overall counts', () => {
      EvaluationHistoryManager.addRun(dummySummary);
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        cacheHitRate: undefined, // Missing
        retrievalRecall: 1.0,    // +0.10 recall -> improving
      });

      const insights = EvaluationInsightsManager.generateInsights();
      expect(insights.trends.cacheHitRate.type).toBe('notComparable');
      expect(insights.status).toBe('improving'); // 1 improve > 0 degrades
    });
  });

  describe('Refresh on History Mutation', () => {
    it('should update insights dynamically as runs are added or deleted', () => {
      EvaluationHistoryManager.addRun(dummySummary);
      expect(EvaluationInsightsManager.generateInsights().status).toBe('insufficient');

      EvaluationHistoryManager.addRun({
        ...dummySummary,
        retrievalRecall: 0.70, // degrading
      });
      expect(EvaluationInsightsManager.generateInsights().status).toBe('degrading');

      // Add a third run that is stable compared to the second run
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        retrievalRecall: 0.72, // Change of +0.02 <= 0.05 tolerance -> stable
      });
      expect(EvaluationInsightsManager.generateInsights().status).toBe('stable'); // run3 vs run2 is stable

      // Delete the latest run (run3), reverting calculation back to run2 vs run1
      EvaluationHistoryManager.deleteRun(EvaluationHistoryManager.listRuns()[0].id);
      expect(EvaluationInsightsManager.generateInsights().status).toBe('degrading'); // Reverts to run2 vs run1 (degrading)
    });
  });

  describe('Production Isolation', () => {
    it('should verify production respond queries bypass baseline/history tracking completely', async () => {
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

      // Trigger a production run
      const result = await service.respond('user-1', 'hi', {
        evaluationRun: false,
      });

      expect(result.diagnostics).toBeUndefined();
      expect(EvaluationHistoryManager.listRuns()).toHaveLength(0);
      expect(EvaluationInsightsManager.generateInsights().status).toBe('insufficient');
    });
  });
});
