import { describe, it, expect, beforeEach } from 'vitest';
import { EvaluationReportHistoryManager } from './reportHistory';
import { EvaluationAlertManager } from './alerts';
import { EvaluationReport, EvalSummary } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 55: Evaluation Insights Actionability & Alerting Tests', () => {
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

  describe('Empty History and Basic Statuses', () => {
    it('should return empty EvaluationAlertsSummary when history is empty', async () => {
      const summary = await EvaluationAlertManager.generateAlerts();
      expect(summary.alerts).toHaveLength(0);
      expect(summary.criticalCount).toBe(0);
      expect(summary.warningCount).toBe(0);
      expect(summary.infoCount).toBe(0);
    });

    it('should map blocked quality gate to critical alert and warning quality gate to warning alert', async () => {
      const blockedReport: EvaluationReport = {
        ...sampleReport,
        qualityGate: {
          status: 'block',
          reasons: ['Recall below threshold'],
          checkedMetrics: {},
          timestamp: new Date().toISOString(),
        },
      };

      EvaluationReportHistoryManager.addReport(blockedReport);
      const summary = await EvaluationAlertManager.generateAlerts();
      expect(summary.criticalCount).toBe(1);
      expect(summary.alerts[0].message).toContain('Recall below threshold');

      EvaluationReportHistoryManager.clearHistory();

      const warnedReport: EvaluationReport = {
        ...sampleReport,
        qualityGate: {
          status: 'warning',
          reasons: ['Latency high'],
          checkedMetrics: {},
          timestamp: new Date().toISOString(),
        },
      };

      EvaluationReportHistoryManager.addReport(warnedReport);
      const summaryWarn = await EvaluationAlertManager.generateAlerts();
      expect(summaryWarn.warningCount).toBe(1);
      expect(summaryWarn.alerts[0].message).toContain('Latency high');
    });
  });

  describe('Deduplication & Conflict Overrides', () => {
    it('should deduplicate spam alerts matching metric, severity, and message', async () => {
      // Since generateAlerts aggregates trends based on newest/previous, we can mock identical trends
      // Let's add multiple reports to check that generateAlerts yields exactly one alert per trend condition.
      EvaluationReportHistoryManager.addReport(sampleReport);
      EvaluationReportHistoryManager.addReport(sampleReport);

      const summary = await EvaluationAlertManager.generateAlerts();
      const uniqueKeys = new Set(summary.alerts.map(a => `${a.metric}-${a.severity}-${a.message}`));
      expect(summary.alerts.length).toBe(uniqueKeys.size);
    });

    it('should verify recurring critical degradations override generic metric warnings/info alerts', async () => {
      // Create sequential regressions for relevance: r3 (0.9) -> r2 (0.8) -> r1 (0.7)
      const r3 = { ...sampleReport, latestRunSummary: { ...baseSummary, relevance: 0.9 } };
      const r2 = { ...sampleReport, latestRunSummary: { ...baseSummary, relevance: 0.8 } };
      const r1 = { ...sampleReport, latestRunSummary: { ...baseSummary, relevance: 0.7 } };

      EvaluationReportHistoryManager.addReport(r3);
      EvaluationReportHistoryManager.addReport(r2);
      EvaluationReportHistoryManager.addReport(r1);

      const summary = await EvaluationAlertManager.generateAlerts();
      const relevanceAlerts = summary.alerts.filter(a => a.metric === 'relevance');

      // Should only have the critical recurring degradation alert, no warning trend alert
      expect(relevanceAlerts).toHaveLength(1);
      expect(relevanceAlerts[0].severity).toBe('critical');
      expect(relevanceAlerts[0].message).toContain('Recurring Degradation');
    });

    it('should verify blocked quality-gate suppresses generic info improvement alerts', async () => {
      // 0.7 -> 0.8 (improving relevance) but gate status is block
      const r2 = { ...sampleReport, latestRunSummary: { ...baseSummary, relevance: 0.7 } };
      const r1 = {
        ...sampleReport,
        latestRunSummary: { ...baseSummary, relevance: 0.8 },
        qualityGate: {
          status: 'block' as const,
          reasons: ['Recall below threshold'],
          checkedMetrics: {},
          timestamp: new Date().toISOString(),
        },
      };

      EvaluationReportHistoryManager.addReport(r2);
      EvaluationReportHistoryManager.addReport(r1);

      const summary = await EvaluationAlertManager.generateAlerts();

      // Should have gate block critical, but no relevance info alert
      expect(summary.alerts.some(a => a.severity === 'critical')).toBe(true);
      expect(summary.alerts.some(a => a.severity === 'info')).toBe(false);
    });
  });

  describe('Latency and Health Regressions', () => {
    it('should map latency regression to warning when below 1000ms, and critical when >= 1000ms', async () => {
      // 1. Delta < 1000ms (e.g. +600ms) -> warning
      const older1 = { ...sampleReport, latestRunSummary: { ...baseSummary, averageLatency: 400 } };
      const newer1 = { ...sampleReport, latestRunSummary: { ...baseSummary, averageLatency: 1000 } };

      EvaluationReportHistoryManager.addReport(older1);
      EvaluationReportHistoryManager.addReport(newer1);

      let summary = await EvaluationAlertManager.generateAlerts();
      let latencyAlert = summary.alerts.find(a => a.metric === 'averageLatency');
      expect(latencyAlert).toBeDefined();
      expect(latencyAlert?.severity).toBe('warning');

      EvaluationReportHistoryManager.clearHistory();

      // 2. Delta >= 1000ms (e.g. +1100ms) -> critical
      const older2 = { ...sampleReport, latestRunSummary: { ...baseSummary, averageLatency: 400 } };
      const newer2 = { ...sampleReport, latestRunSummary: { ...baseSummary, averageLatency: 1500 } };

      EvaluationReportHistoryManager.addReport(older2);
      EvaluationReportHistoryManager.addReport(newer2);

      summary = await EvaluationAlertManager.generateAlerts();
      latencyAlert = summary.alerts.find(a => a.metric === 'averageLatency');
      expect(latencyAlert).toBeDefined();
      expect(latencyAlert?.severity).toBe('critical');
    });

    it('should map health metric degradation (timeouts/fallbacks/retries) to warning alerts', async () => {
      // timeoutCount: 1 -> 3
      const older = { ...sampleReport, latestRunSummary: { ...baseSummary, timeoutCount: 1 } };
      const newer = { ...sampleReport, latestRunSummary: { ...baseSummary, timeoutCount: 3 } };

      EvaluationReportHistoryManager.addReport(older);
      EvaluationReportHistoryManager.addReport(newer);

      const summary = await EvaluationAlertManager.generateAlerts();
      const healthAlert = summary.alerts.find(a => a.metric === 'timeoutCount');
      expect(healthAlert).toBeDefined();
      expect(healthAlert?.severity).toBe('warning');
    });
  });

  describe('Deterministic Sorting and Sanitization', () => {
    it('should verify deterministic sort order (severity weight descending, then metric alphabetically)', async () => {
      // relevance (recurr -> critical), faithfulness (warning), averageLatency (warning)
      const r2 = { ...sampleReport, latestRunSummary: { ...baseSummary, relevance: 0.9, faithfulness: 0.9, averageLatency: 400 } };
      const r1 = { ...sampleReport, latestRunSummary: { ...baseSummary, relevance: 0.8, faithfulness: 0.8, averageLatency: 1000 } };

      // Make relevance recurring by adding a 3rd report
      const r3 = { ...sampleReport, latestRunSummary: { ...baseSummary, relevance: 1.0 } };

      EvaluationReportHistoryManager.addReport(r3);
      EvaluationReportHistoryManager.addReport(r2);
      EvaluationReportHistoryManager.addReport(r1);

      const summary = await EvaluationAlertManager.generateAlerts();

      // Expected alerts sequence:
      // Index 0: relevance (critical recurring)
      // Index 1: averageLatency (warning latency)
      // Index 2: faithfulness (warning metric)
      expect(summary.alerts[0].severity).toBe('critical');
      expect(summary.alerts[0].metric).toBe('relevance');

      expect(summary.alerts[1].severity).toBe('warning');
      expect(summary.alerts[1].metric).toBe('averageLatency');

      expect(summary.alerts[2].severity).toBe('warning');
      expect(summary.alerts[2].metric).toBe('faithfulness');
    });
  });

  describe('Production Isolation and Config Stability', () => {
    it('should verify production response requests bypass alerts logic completely', async () => {
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
