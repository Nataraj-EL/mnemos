import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EvaluationHistoryManager } from './history';
import { EvaluationRecommendationsManager, RECOMMENDATION_THRESHOLDS } from './recommendations';
import { EvalSummary } from './types';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 44: Adaptive Evaluation Recommendations Tests', () => {
  beforeEach(() => {
    EvaluationHistoryManager.clearHistory();
  });

  const dummySummary: EvalSummary = {
    total: 10,
    passed: 10,
    failed: 0,
    retrievalRecall: 0.95,
    contextPrecision: 0.95,
    isolationRate: 1.0,
    deduplicationRate: 1.0,
    tokenCompliance: 1.0,
    relevance: 0.95,
    faithfulness: 0.95,
    citationCorrectness: 0.95,
    contextUtilization: 0.90,
    averageLatency: 500,
    successRate: 0.95,
    cacheHitRate: 0.85,
    fallbackRate: 0.05,
    retryRate: 0.05,
    timeoutCount: 0,
  };

  describe('Empty or Single Run History', () => {
    it('should return empty recommendations if history is empty or contains only 1 run', () => {
      expect(EvaluationRecommendationsManager.generateRecommendations()).toHaveLength(0);

      EvaluationHistoryManager.addRun(dummySummary);
      expect(EvaluationRecommendationsManager.generateRecommendations()).toHaveLength(0);
    });
  });

  describe('Trend-Aware Suppressions', () => {
    it('should suppress warning/info recommendations if the metric trend is improving', () => {
      // Previous run (poor relevance, runs[1])
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        relevance: 0.60,
      });

      // Latest run (improved but still below 0.85 threshold, runs[0])
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        relevance: 0.75, // relevance trend: improving (0.75 > 0.60, exceeds relevanceTolerance of 0.02)
      });

      const recs = EvaluationRecommendationsManager.generateRecommendations();
      // Relevance is warning severity, so it should be suppressed because it is improving
      const relevanceRec = recs.find((r) => r.metric === 'relevance');
      expect(relevanceRec).toBeUndefined();
    });

    it('should NOT suppress critical recommendations even if the metric trend is improving', () => {
      // Previous run (poor recall, runs[1])
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        retrievalRecall: 0.50,
      });

      // Latest run (improved but still below 0.80 critical threshold, runs[0])
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        retrievalRecall: 0.65, // recall trend: improving
      });

      const recs = EvaluationRecommendationsManager.generateRecommendations();
      // Recall is critical severity, so it must still be recommended even while improving
      const recallRec = recs.find((r) => r.metric === 'retrievalRecall');
      expect(recallRec).toBeDefined();
      expect(recallRec?.severity).toBe('critical');
    });
  });

  describe('Boundary Condition Values', () => {
    it('should not recommend if value is exactly equal to the threshold', () => {
      EvaluationHistoryManager.addRun(dummySummary);
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        retrievalRecall: RECOMMENDATION_THRESHOLDS.retrievalRecall, // Exactly 0.80 (pass limit)
        faithfulness: RECOMMENDATION_THRESHOLDS.faithfulness,       // Exactly 0.85
      });

      const recs = EvaluationRecommendationsManager.generateRecommendations();
      expect(recs.find((r) => r.metric === 'retrievalRecall')).toBeUndefined();
      expect(recs.find((r) => r.metric === 'faithfulness')).toBeUndefined();
    });
  });

  describe('Deterministic Ordering', () => {
    it('should sort recommendations by severity (critical > warning > info) and then alphabetically by id', () => {
      EvaluationHistoryManager.addRun(dummySummary);
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        faithfulness: 0.70,     // critical -> rec-faithfulness-low
        retrievalRecall: 0.70,  // critical -> rec-recall-low
        relevance: 0.70,         // warning -> rec-relevance-low
        cacheHitRate: 0.40,      // info -> rec-cache-low
      });

      const recs = EvaluationRecommendationsManager.generateRecommendations();
      expect(recs).toHaveLength(4);

      // Severities: critical, critical, warning, info
      expect(recs[0].severity).toBe('critical');
      expect(recs[1].severity).toBe('critical');
      expect(recs[2].severity).toBe('warning');
      expect(recs[3].severity).toBe('info');

      // Alphabetical check for criticals tie: rec-faithfulness-low < rec-recall-low
      expect(recs[0].id).toBe('rec-faithfulness-low');
      expect(recs[1].id).toBe('rec-recall-low');
    });
  });

  describe('Maximum Recommendation Limits', () => {
    it('should cap the recommendations at a maximum size of 5 items', () => {
      EvaluationHistoryManager.addRun(dummySummary);
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        faithfulness: 0.70,      // critical (1)
        retrievalRecall: 0.70,   // critical (2)
        averageLatency: 4000,    // critical (3)
        relevance: 0.70,         // warning (4)
        timeoutCount: 5,         // warning (5)
        cacheHitRate: 0.40,      // info (6)
        fallbackRate: 0.50,      // info (7)
      });

      const recs = EvaluationRecommendationsManager.generateRecommendations();
      expect(recs.length).toBeLessThanOrEqual(5);
      expect(recs).toHaveLength(5);
    });
  });

  describe('Missing / Undefined Metric values', () => {
    it('should treat missing metrics as not actionable and gracefully ignore them', () => {
      EvaluationHistoryManager.addRun(dummySummary);
      EvaluationHistoryManager.addRun({
        ...dummySummary,
        faithfulness: undefined, // Missing
        retrievalRecall: 0.70,   // critical recall -> should trigger
      } as unknown as EvalSummary);

      const recs = EvaluationRecommendationsManager.generateRecommendations();
      expect(recs).toHaveLength(1);
      expect(recs[0].metric).toBe('retrievalRecall');
    });
  });

  describe('Production Isolation', () => {
    it('should verify production respond queries bypass baseline/history/recommendations tracking completely', async () => {
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
      expect(EvaluationRecommendationsManager.generateRecommendations()).toHaveLength(0);
    });
  });
});
