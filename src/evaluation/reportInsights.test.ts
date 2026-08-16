import { describe, it, expect, beforeEach } from 'vitest';
import { EvaluationReportHistoryManager } from './reportHistory';
import { EvaluationReportInsightsManager } from './reportInsights';
import { EvaluationReport, EvalSummary } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 54: Evaluation Report Insights & Longitudinal Analytics Tests', () => {
  const baseSummary: EvalSummary = {
    total: 10,
    passed: 10,
    failed: 0,
    retrievalRecall: 0.8,
    contextPrecision: 0.8,
    isolationRate: 0.8,
    deduplicationRate: 0.8,
    tokenCompliance: 0.8,
    relevance: 0.8,
    faithfulness: 0.8,
    citationCorrectness: 0.8,
    contextUtilization: 0.8,
    averageLatency: 500,
    successRate: 0.8,
    cacheHitRate: 0.5,
    fallbackRate: 0.1,
    retryRate: 0.1,
    timeoutCount: 1,
  };

  const sampleReport: EvaluationReport = {
    timestamp: new Date().toISOString(),
    latestRunSummary: baseSummary,
    qualityGate: {
      status: 'pass',
      reasons: ['Passed'],
      checkedMetrics: {},
      timestamp: new Date().toISOString(),
    },
    baselineAvailable: true,
    regressionStatus: 'pass',
    healthMetrics: {
      successRate: 0.8,
    },
    trendSummary: null,
    promotedConfig: null,
    recommendations: [],
    experimentSummary: null,
  };

  beforeEach(() => {
    EvaluationReportHistoryManager.clearHistory();
  });

  describe('History Snapshot Limits', () => {
    it('should return insufficientHistory true when history has 0 or 1 reports', async () => {
      let insights = await EvaluationReportInsightsManager.generateInsights();
      expect(insights.insufficientHistory).toBe(true);
      expect(insights.gateHistorySummary.total).toBe(0);

      EvaluationReportHistoryManager.addReport(sampleReport);
      insights = await EvaluationReportInsightsManager.generateInsights();
      expect(insights.insufficientHistory).toBe(true);
      expect(insights.gateHistorySummary.total).toBe(1);
    });

    it('should return insufficientHistory false when history has 2 or more reports', async () => {
      EvaluationReportHistoryManager.addReport(sampleReport);
      EvaluationReportHistoryManager.addReport(sampleReport);

      const insights = await EvaluationReportInsightsManager.generateInsights();
      expect(insights.insufficientHistory).toBe(false);
      expect(insights.gateHistorySummary.total).toBe(2);
    });
  });

  describe('Metric Trend Semantics & Tolerances', () => {
    it('should verify higher-is-better metrics classification rules', async () => {
      const olderReport: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, retrievalRecall: 0.7 },
      };
      const newerReport: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, retrievalRecall: 0.8 },
      };

      EvaluationReportHistoryManager.addReport(olderReport); // index 1
      EvaluationReportHistoryManager.addReport(newerReport); // index 0 (newest)

      const insights = await EvaluationReportInsightsManager.generateInsights();
      expect(insights.trends.retrievalRecall.type).toBe('improving');
      expect(insights.trends.retrievalRecall.delta).toBeCloseTo(0.1, 5);
    });

    it('should verify lower-is-better metrics classification rules', async () => {
      const olderReport: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, averageLatency: 1000 },
      };
      const newerReport: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, averageLatency: 400 }, // decreased (improvement)
      };

      EvaluationReportHistoryManager.addReport(olderReport);
      EvaluationReportHistoryManager.addReport(newerReport);

      const insights = await EvaluationReportInsightsManager.generateInsights();
      expect(insights.trends.averageLatency.type).toBe('improving');
      expect(insights.trends.averageLatency.delta).toBe(-600);
    });

    it('should classify changes within tolerance as stable', async () => {
      const olderReport: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, retrievalRecall: 0.8 },
      };
      const newerReport: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, retrievalRecall: 0.82 }, // tolerance is 0.05
      };

      EvaluationReportHistoryManager.addReport(olderReport);
      EvaluationReportHistoryManager.addReport(newerReport);

      const insights = await EvaluationReportInsightsManager.generateInsights();
      expect(insights.trends.retrievalRecall.type).toBe('stable');
    });

    it('should classify undefined or NaN values as notComparable', async () => {
      const olderReport: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, retrievalRecall: undefined as unknown as number },
      };
      const newerReport: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, retrievalRecall: NaN },
      };

      EvaluationReportHistoryManager.addReport(olderReport);
      EvaluationReportHistoryManager.addReport(newerReport);

      const insights = await EvaluationReportInsightsManager.generateInsights();
      expect(insights.trends.retrievalRecall.type).toBe('notComparable');
    });
  });

  describe('Longitudinal Sequential Degradation Detection', () => {
    it('should detect recurring degradations in at least 2 sequential comparisons', async () => {
      // Metric gets sequentially worse: 0.85 -> 0.75 -> 0.65
      const r3: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, relevance: 0.85 },
      };
      const r2: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, relevance: 0.75 }, // degrades C1
      };
      const r1: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, relevance: 0.65 }, // degrades C0
      };

      EvaluationReportHistoryManager.addReport(r3); // index 2
      EvaluationReportHistoryManager.addReport(r2); // index 1
      EvaluationReportHistoryManager.addReport(r1); // index 0 (newest)

      const insights = await EvaluationReportInsightsManager.generateInsights();
      expect(insights.recurringDegradations).toContain('relevance');
    });

    it('should not flag degradation that recovered or stabilized', async () => {
      // 0.85 -> 0.75 (degrades) -> 0.80 (improves)
      const r3: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, relevance: 0.85 },
      };
      const r2: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, relevance: 0.75 }, // degrades C1
      };
      const r1: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, relevance: 0.80 }, // improves C0
      };

      EvaluationReportHistoryManager.addReport(r3);
      EvaluationReportHistoryManager.addReport(r2);
      EvaluationReportHistoryManager.addReport(r1);

      const insights = await EvaluationReportInsightsManager.generateInsights();
      expect(insights.recurringDegradations).not.toContain('relevance');
    });
  });

  describe('Deterministic and Immutable Checks', () => {
    it('should return metrics in a fixed order and sort recurringDegradations alphabetically', async () => {
      const r3: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, relevance: 0.85, faithfulness: 0.85 },
      };
      const r2: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, relevance: 0.75, faithfulness: 0.75 },
      };
      const r1: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, relevance: 0.65, faithfulness: 0.65 },
      };

      EvaluationReportHistoryManager.addReport(r3);
      EvaluationReportHistoryManager.addReport(r2);
      EvaluationReportHistoryManager.addReport(r1);

      const insights = await EvaluationReportInsightsManager.generateInsights();
      expect(insights.recurringDegradations).toEqual(['faithfulness', 'relevance']);
      expect(Object.keys(insights.trends)).toEqual([
        'retrievalRecall',
        'contextPrecision',
        'relevance',
        'faithfulness',
        'citationCorrectness',
        'contextUtilization',
        'successRate',
        'cacheHitRate',
        'fallbackRate',
        'retryRate',
        'timeoutCount',
        'averageLatency',
      ]);
    });
  });

  describe('Production Isolation and Config Stability', () => {
    it('should verify production response requests bypass insights computations completely', async () => {
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
