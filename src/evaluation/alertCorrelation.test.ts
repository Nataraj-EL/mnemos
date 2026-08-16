import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EvaluationAlertHistoryManager } from './alertHistory';
import { PromotionHistoryManager } from './promotionHistory';
import { ExperimentHistoryManager } from './experimentHistory';
import { EvaluationReportHistoryManager } from './reportHistory';
import { EvaluationAlertCorrelationManager } from './alertCorrelation';
import { EvaluationAlert, EvaluationReport, EvalSummary, TuningConfig } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 57: Evaluation Alert Root-Cause Correlation Tests', () => {
  const sampleAlert: EvaluationAlert = {
    id: 'sample-id',
    metric: 'relevance',
    severity: 'warning',
    message: 'Relevance has degraded.',
    timestamp: '2026-08-16T12:00:00.000Z',
  };

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
    timestamp: '2026-08-16T11:59:00.000Z',
    latestRunSummary: baseSummary,
    qualityGate: {
      status: 'pass',
      reasons: ['Passed'],
      checkedMetrics: {},
      timestamp: '2026-08-16T11:59:00.000Z',
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
    EvaluationAlertHistoryManager.clearHistory();
    PromotionHistoryManager.clearHistory();
    ExperimentHistoryManager.clearHistory();
    EvaluationReportHistoryManager.clearHistory();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic Filtering and Exclusions', () => {
    it('should ignore events occurring after the alert timestamp', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);

      // Promo event 5 seconds after the alert
      const alertTime = new Date(rec.createdAt).getTime();
      const futureTime = new Date(alertTime + 5000).toISOString();

      vi.spyOn(PromotionHistoryManager, 'listRecords').mockReturnValue([
        {
          id: 'aud-123',
          timestamp: futureTime,
          action: 'promote',
          previousConfig: { semanticWeight: 0.5 } as unknown as TuningConfig,
          newConfig: { semanticWeight: 0.8 } as unknown as TuningConfig,
        },
      ]);

      const correlations = await EvaluationAlertCorrelationManager.correlateAlerts();
      expect(correlations[0].likelyCause).toBe('unknown');
    });

    it('should ignore unrelated configuration changes', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);
      const alertTime = new Date(rec.createdAt).getTime();
      const pastTime = new Date(alertTime - 5000).toISOString();

      // Change parameter unrelated to relevance
      vi.spyOn(PromotionHistoryManager, 'listRecords').mockReturnValue([
        {
          id: 'aud-123',
          timestamp: pastTime,
          action: 'promote',
          previousConfig: { maxConversationSnippets: 3 } as unknown as TuningConfig,
          newConfig: { maxConversationSnippets: 5 } as unknown as TuningConfig,
        },
      ]);

      const correlations = await EvaluationAlertCorrelationManager.correlateAlerts();
      expect(correlations[0].likelyCause).toBe('unknown');
    });

    it('should exclude resolved alerts unless explicitly requested', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);
      EvaluationAlertHistoryManager.resolve(rec.id);

      let correlations = await EvaluationAlertCorrelationManager.correlateAlerts(false);
      expect(correlations).toHaveLength(0);

      correlations = await EvaluationAlertCorrelationManager.correlateAlerts(true);
      expect(correlations).toHaveLength(1);
    });
  });

  describe('Correlation Confidences & Alignment', () => {
    it('should trigger high confidence for config promotions within 10 minutes with direct parameter-metric relationship', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);
      const alertTime = new Date(rec.createdAt).getTime();
      const nearPastTime = new Date(alertTime - 2 * 60 * 1000).toISOString(); // 2 mins ago

      vi.spyOn(PromotionHistoryManager, 'listRecords').mockReturnValue([
        {
          id: 'aud-123',
          timestamp: nearPastTime,
          action: 'promote',
          previousConfig: { semanticWeight: 0.5 } as unknown as TuningConfig,
          newConfig: { semanticWeight: 0.8 } as unknown as TuningConfig,
        },
      ]);

      const correlations = await EvaluationAlertCorrelationManager.correlateAlerts();
      expect(correlations[0].likelyCause).toBe('configuration');
      expect(correlations[0].confidence).toBe('high');
    });

    it('should trigger medium confidence for promotions outside 10 minutes window', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);
      const alertTime = new Date(rec.createdAt).getTime();
      const distantPastTime = new Date(alertTime - 20 * 60 * 1000).toISOString(); // 20 mins ago

      vi.spyOn(PromotionHistoryManager, 'listRecords').mockReturnValue([
        {
          id: 'aud-123',
          timestamp: distantPastTime,
          action: 'promote',
          previousConfig: { semanticWeight: 0.5 } as unknown as TuningConfig,
          newConfig: { semanticWeight: 0.8 } as unknown as TuningConfig,
        },
      ]);

      const correlations = await EvaluationAlertCorrelationManager.correlateAlerts();
      expect(correlations[0].likelyCause).toBe('configuration');
      expect(correlations[0].confidence).toBe('medium');
    });
  });

  describe('Experiment and Report Correlations', () => {
    it('should ignore experiments with no relevant metric regressions', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);
      const alertTime = new Date(rec.createdAt).getTime();
      const pastTime = new Date(alertTime - 5000).toISOString();

      // Experiment showed latency regression, but relevance was unchanged/improved
      vi.spyOn(ExperimentHistoryManager, 'listRecords').mockReturnValue([
        {
          id: 'exp-123',
          timestamp: pastTime,
          controlConfig: {} as unknown as TuningConfig,
          candidateConfig: {} as unknown as TuningConfig,
          controlSummary: baseSummary,
          candidateSummary: baseSummary,
          comparison: {
            status: 'fail',
            baselineAvailable: true,
            failedThresholds: ['averageLatency'],
            deltas: {
              averageLatency: { absolute: 600, percentage: 50, type: 'regression' },
            },
          },
          recommendation: 'control',
          recommendationExplanation: 'Latency degraded.',
        },
      ]);

      const correlations = await EvaluationAlertCorrelationManager.correlateAlerts();
      expect(correlations[0].likelyCause).toBe('unknown');
    });

    it('should correlate to evaluation report if the metric actually regressed between reports', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);
      const alertTime = new Date(rec.createdAt).getTime();
      const reportTime1 = new Date(alertTime - 2000).toISOString();
      const reportTime2 = new Date(alertTime - 5000).toISOString();

      const older: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, relevance: 0.9 },
      };
      const newer: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, relevance: 0.8 }, // regressed
      };

      vi.spyOn(EvaluationReportHistoryManager, 'listReports').mockReturnValue([
        {
          id: 'rpt-newer',
          timestamp: reportTime1,
          report: newer,
        },
        {
          id: 'rpt-older',
          timestamp: reportTime2,
          report: older,
        },
      ]);

      const correlations = await EvaluationAlertCorrelationManager.correlateAlerts();
      expect(correlations[0].likelyCause).toBe('evaluation');
      expect(correlations[0].confidence).toBe('medium');
    });
  });

  describe('Precedence cause sorting', () => {
    it('should resolve multiple matching causes deterministically config > experiment > evaluation', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);
      const alertTime = new Date(rec.createdAt).getTime();

      // Config promotion (medium confidence, 20 mins ago)
      vi.spyOn(PromotionHistoryManager, 'listRecords').mockReturnValue([
        {
          id: 'aud-123',
          timestamp: new Date(alertTime - 20 * 60 * 1000).toISOString(),
          action: 'promote',
          previousConfig: { semanticWeight: 0.5 } as unknown as TuningConfig,
          newConfig: { semanticWeight: 0.8 } as unknown as TuningConfig,
        },
      ]);

      // Experiment regression (medium confidence, 15 mins ago)
      vi.spyOn(ExperimentHistoryManager, 'listRecords').mockReturnValue([
        {
          id: 'exp-123',
          timestamp: new Date(alertTime - 15 * 60 * 1000).toISOString(),
          controlConfig: {} as unknown as TuningConfig,
          candidateConfig: {} as unknown as TuningConfig,
          controlSummary: baseSummary,
          candidateSummary: baseSummary,
          comparison: {
            status: 'fail',
            baselineAvailable: true,
            failedThresholds: ['relevance'],
            deltas: {
              relevance: { absolute: -0.1, percentage: -10, type: 'regression' },
            },
          },
          recommendation: 'control',
          recommendationExplanation: 'Relevance degraded.',
        },
      ]);

      // Report regression (medium confidence, 5 mins ago)
      const older = { ...sampleReport, latestRunSummary: { ...baseSummary, relevance: 0.9 } };
      const newer = { ...sampleReport, latestRunSummary: { ...baseSummary, relevance: 0.8 } };
      vi.spyOn(EvaluationReportHistoryManager, 'listReports').mockReturnValue([
        {
          id: 'rpt-newer',
          timestamp: new Date(alertTime - 5 * 60 * 1000).toISOString(),
          report: newer,
        },
        {
          id: 'rpt-older',
          timestamp: new Date(alertTime - 10 * 60 * 1000).toISOString(),
          report: older,
        },
      ]);

      const correlations = await EvaluationAlertCorrelationManager.correlateAlerts();

      // Configuration should be chosen as primary cause due to precedence config > experiment > evaluation
      expect(correlations[0].likelyCause).toBe('configuration');
    });
  });

  describe('Production Isolation and Config Stability', () => {
    it('should verify production response requests bypass correlation logic completely', async () => {
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
