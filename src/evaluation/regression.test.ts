import { describe, it, expect, beforeEach } from 'vitest';
import {
  BaselineManager,
  compareSummaries,
  sanitizeSummary,
} from './regression';
import { EvalSummary } from './types';

describe('Sprint 41: Evaluation Quality & Regression Detection Tests', () => {
  beforeEach(() => {
    BaselineManager.clearBaseline();
  });

  describe('Sanitization & Sensitive Data Prevention', () => {
    it('should strip raw diagnostics, prompts, transcripts, or IDs and keep only sanitized aggregate EvalSummary', () => {
      const dirtySummary = {
        total: 10,
        passed: 9,
        failed: 1,
        retrievalRecall: 0.9,
        contextPrecision: 0.9,
        isolationRate: 1.0,
        deduplicationRate: 1.0,
        tokenCompliance: 1.0,
        relevance: 0.95,
        faithfulness: 0.95,
        citationCorrectness: 0.95,
        contextUtilization: 0.8,
        averageLatency: 450,
        successRate: 0.9,
        cacheHitRate: 0.8,
        fallbackRate: 0.1,
        retryRate: 0.05,
        timeoutCount: 0,
        // Sensitive/invalid fields to be stripped
        apiKey: 'sk-1234567890',
        sqlQuery: 'SELECT * FROM memories',
        prompt: 'You are a helpful assistant...',
        scenarios: [{ id: 'sc-1', text: 'secret user query' }],
      };

      const clean = sanitizeSummary(dirtySummary as unknown as EvalSummary);
      const cleanRecord = clean as unknown as Record<string, unknown>;

      expect(cleanRecord.apiKey).toBeUndefined();
      expect(cleanRecord.sqlQuery).toBeUndefined();
      expect(cleanRecord.prompt).toBeUndefined();
      expect(cleanRecord.scenarios).toBeUndefined();

      expect(clean.total).toBe(10);
      expect(clean.passed).toBe(9);
      expect(clean.averageLatency).toBe(450);
      expect(clean.successRate).toBe(0.9);
    });
  });

  describe('Baseline Management Lifecycle', () => {
    const summary1: EvalSummary = {
      total: 10,
      passed: 10,
      failed: 0,
      retrievalRecall: 1.0,
      contextPrecision: 1.0,
      isolationRate: 1.0,
      deduplicationRate: 1.0,
      tokenCompliance: 1.0,
      relevance: 1.0,
      faithfulness: 1.0,
      citationCorrectness: 1.0,
      contextUtilization: 1.0,
      averageLatency: 200,
      successRate: 1.0,
      cacheHitRate: 0.9,
      fallbackRate: 0.0,
      retryRate: 0.0,
      timeoutCount: 0,
    };

    const summary2: EvalSummary = {
      ...summary1,
      averageLatency: 250,
    };

    it('should record baseline on first valid run and NOT auto-overwrite on later runs', () => {
      expect(BaselineManager.getBaseline()).toBeNull();

      // First run establishes the baseline
      BaselineManager.setBaseline(summary1, 'run-1');
      expect(BaselineManager.getBaseline()?.averageLatency).toBe(200);
      expect(BaselineManager.getLabel()).toBe('run-1');

      // Subsequent comparison does not overwrite the baseline
      const regression = compareSummaries(summary2, BaselineManager.getBaseline());
      expect(regression.baselineAvailable).toBe(true);
      expect(BaselineManager.getBaseline()?.averageLatency).toBe(200); // Baseline preserved
    });

    it('should support explicit baseline replacement using setBaseline', () => {
      BaselineManager.setBaseline(summary1, 'run-1');
      expect(BaselineManager.getBaseline()?.averageLatency).toBe(200);

      // Explicit set overwrites baseline intentionally
      BaselineManager.setBaseline(summary2, 'run-2');
      expect(BaselineManager.getBaseline()?.averageLatency).toBe(250);
      expect(BaselineManager.getLabel()).toBe('run-2');
    });
  });

  describe('Higher-Is-Better vs Lower-Is-Better Semantics', () => {
    const baseline: EvalSummary = {
      total: 10,
      passed: 9,
      failed: 1,
      retrievalRecall: 0.9,
      contextPrecision: 0.8,
      isolationRate: 1.0,
      deduplicationRate: 1.0,
      tokenCompliance: 1.0,
      relevance: 0.9,
      faithfulness: 0.9,
      citationCorrectness: 0.9,
      contextUtilization: 0.8,
      averageLatency: 1000,
      successRate: 0.9,
      cacheHitRate: 0.7,
      fallbackRate: 0.2,
      retryRate: 0.1,
      timeoutCount: 1,
    };

    it('should classify higher-is-better score drops as regressions', () => {
      const current: EvalSummary = {
        ...baseline,
        retrievalRecall: 0.85, // Regressed: 0.85 < 0.90
        faithfulness: 0.95,    // Improved: 0.95 > 0.90
      };

      const result = compareSummaries(current, baseline);

      expect(result.deltas.retrievalRecall.type).toBe('regression');
      expect(result.deltas.retrievalRecall.absolute).toBeCloseTo(-0.05);

      expect(result.deltas.faithfulness.type).toBe('improvement');
      expect(result.deltas.faithfulness.absolute).toBeCloseTo(0.05);
    });

    it('should classify lower-is-better metric increases as regressions', () => {
      const current: EvalSummary = {
        ...baseline,
        averageLatency: 1200, // Regressed (higher latency): 1200 > 1000
        timeoutCount: 0,      // Improved (lower timeouts): 0 < 1
      };

      const result = compareSummaries(current, baseline);

      expect(result.deltas.averageLatency.type).toBe('regression');
      expect(result.deltas.averageLatency.absolute).toBe(200);

      expect(result.deltas.timeoutCount.type).toBe('improvement');
      expect(result.deltas.timeoutCount.absolute).toBe(-1);
    });

    it('should classify identical values as unchanged', () => {
      const result = compareSummaries(baseline, baseline);
      expect(result.deltas.retrievalRecall.type).toBe('unchanged');
      expect(result.deltas.retrievalRecall.absolute).toBe(0);
      expect(result.deltas.averageLatency.type).toBe('unchanged');
      expect(result.deltas.averageLatency.absolute).toBe(0);
    });
  });

  describe('Missing or Incomplete Data', () => {
    it('should mark missing/undefined metrics as notComparable instead of treating them as 0', () => {
      const baseline: EvalSummary = {
        total: 10,
        passed: 10,
        failed: 0,
        retrievalRecall: 1.0,
        contextPrecision: 1.0,
        isolationRate: 1.0,
        deduplicationRate: 1.0,
        tokenCompliance: 1.0,
        relevance: 1.0,
        faithfulness: 1.0,
        citationCorrectness: 1.0,
        contextUtilization: 1.0,
        averageLatency: 200,
        successRate: 1.0,
        cacheHitRate: undefined, // Missing metric in baseline
        fallbackRate: 0.1,
        retryRate: 0.05,
        timeoutCount: 0,
      };

      const current: EvalSummary = {
        ...baseline,
        fallbackRate: undefined, // Missing metric in current
        cacheHitRate: 0.8,
      };

      const result = compareSummaries(current, baseline);

      expect(result.deltas.cacheHitRate.type).toBe('notComparable');
      expect(result.deltas.cacheHitRate.notComparable).toBe(true);
      expect(result.deltas.cacheHitRate.absolute).toBeUndefined();

      expect(result.deltas.fallbackRate.type).toBe('notComparable');
      expect(result.deltas.fallbackRate.notComparable).toBe(true);

      // Verify recall is comparable normally
      expect(result.deltas.retrievalRecall.type).toBe('unchanged');
    });
  });

  describe('Baseline Boundary Edge Cases', () => {
    it('should handle baseline value = 0 by keeping percentage delta undefined', () => {
      const baseline: EvalSummary = {
        total: 10,
        passed: 10,
        failed: 0,
        retrievalRecall: 1.0,
        contextPrecision: 1.0,
        isolationRate: 1.0,
        deduplicationRate: 1.0,
        tokenCompliance: 1.0,
        relevance: 1.0,
        faithfulness: 1.0,
        citationCorrectness: 1.0,
        contextUtilization: 1.0,
        averageLatency: 200,
        successRate: 1.0,
        cacheHitRate: 0.5,
        fallbackRate: 0.0, // 0 baseline
        retryRate: 0.0,    // 0 baseline
        timeoutCount: 0,   // 0 baseline
      };

      const current: EvalSummary = {
        ...baseline,
        fallbackRate: 0.2, // Increases (regression)
      };

      const result = compareSummaries(current, baseline);

      expect(result.deltas.fallbackRate.type).toBe('regression');
      expect(result.deltas.fallbackRate.absolute).toBe(0.2);
      expect(result.deltas.fallbackRate.percentage).toBeUndefined(); // Handled division by zero
    });
  });

  describe('Warning vs Fail Status Precedence Rules', () => {
    const baseline: EvalSummary = {
      total: 10,
      passed: 10,
      failed: 0,
      retrievalRecall: 1.0,
      contextPrecision: 1.0,
      isolationRate: 1.0,
      deduplicationRate: 1.0,
      tokenCompliance: 1.0,
      relevance: 1.0,
      faithfulness: 1.0,
      citationCorrectness: 1.0,
      contextUtilization: 1.0,
      averageLatency: 500,
      successRate: 1.0,
      cacheHitRate: 0.8,
      fallbackRate: 0.1,
      retryRate: 0.05,
      timeoutCount: 0,
    };

    it('should return PASS if no thresholds are exceeded', () => {
      const result = compareSummaries(baseline, baseline);
      expect(result.status).toBe('pass');
      expect(result.failedThresholds).toHaveLength(0);
    });

    it('should return WARNING if only latency or non-critical diagnostic thresholds are exceeded', () => {
      const current: EvalSummary = {
        ...baseline,
        averageLatency: 1100, // Latency exceeds 500ms tolerance (+600ms)
      };

      const result = compareSummaries(current, baseline);
      expect(result.status).toBe('warning');
      expect(result.failedThresholds).toContain('averageLatency');
    });

    it('should return FAIL if critical quality thresholds are exceeded', () => {
      const current: EvalSummary = {
        ...baseline,
        relevance: 0.95, // Drops by 5% absolute (exceeds relevanceTolerance of 0.02)
      };

      const result = compareSummaries(current, baseline);
      expect(result.status).toBe('fail');
      expect(result.failedThresholds).toContain('relevance');
    });

    it('should return FAIL (fail takes precedence over warning) if both are exceeded', () => {
      const current: EvalSummary = {
        ...baseline,
        averageLatency: 1200, // Exceeds latency warning
        relevance: 0.95,      // Exceeds quality fail
      };

      const result = compareSummaries(current, baseline);
      expect(result.status).toBe('fail');
      expect(result.failedThresholds).toContain('averageLatency');
      expect(result.failedThresholds).toContain('relevance');
    });
  });
});
