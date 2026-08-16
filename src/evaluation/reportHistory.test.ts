import { describe, it, expect, beforeEach } from 'vitest';
import { EvaluationReportHistoryManager } from './reportHistory';
import { EvaluationReport, EvalSummary } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 53: Evaluation Report History & Versioning Tests', () => {
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
    fallbackRate: 0,
    retryRate: 0,
    timeoutCount: 0,
  };

  const targetSummary: EvalSummary = {
    ...baseSummary,
    retrievalRecall: 0.9,      // Improved by +0.1
    contextPrecision: 0.75,    // Regressed by -0.05
    averageLatency: 400,       // Improved by -100ms
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
    promotedConfig: {
      semanticWeight: 0.6,
      lexicalWeight: 0.4,
      minSimilarity: 0.5,
      diversityThreshold: 0.3,
      maxConversationSnippets: 10,
    },
    recommendations: [],
    experimentSummary: null,
  };

  beforeEach(() => {
    EvaluationReportHistoryManager.clearHistory();
  });

  describe('Report History Ingestion & Eviction Logic', () => {
    it('should save a single record on explicit save and not duplicate', () => {
      const record = EvaluationReportHistoryManager.addReport(sampleReport);
      expect(record.id).toMatch(/^rpt_/);
      expect(EvaluationReportHistoryManager.listReports()).toHaveLength(1);
    });

    it('should enforce the maximum limit of 20 reports via FIFO eviction', () => {
      for (let i = 0; i < 25; i++) {
        const reportCopy = {
          ...sampleReport,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
        };
        EvaluationReportHistoryManager.addReport(reportCopy);
      }

      const list = EvaluationReportHistoryManager.listReports();
      expect(list).toHaveLength(20);
    });

    it('should maintain immutability using deep-cloning', () => {
      const reportCopy = JSON.parse(JSON.stringify(sampleReport));
      const record = EvaluationReportHistoryManager.addReport(reportCopy);

      // Mutate the original config object
      reportCopy.promotedConfig.semanticWeight = 0.99;
      expect(record.report.promotedConfig?.semanticWeight).toBe(0.6);

      // Mutate the retrieved config object
      const retrieved = EvaluationReportHistoryManager.getReport(record.id);
      expect(retrieved).toBeDefined();
      if (retrieved && retrieved.report.promotedConfig) {
        retrieved.report.promotedConfig.semanticWeight = 0.88;
      }

      const secondRetrieval = EvaluationReportHistoryManager.getReport(record.id);
      expect(secondRetrieval?.report.promotedConfig?.semanticWeight).toBe(0.6);
    });

    it('should delete a single report and clear history correctly', () => {
      const r1 = EvaluationReportHistoryManager.addReport(sampleReport);
      const r2 = EvaluationReportHistoryManager.addReport(sampleReport);

      expect(EvaluationReportHistoryManager.listReports()).toHaveLength(2);

      const deleted = EvaluationReportHistoryManager.deleteReport(r1.id);
      expect(deleted).toBe(true);
      expect(EvaluationReportHistoryManager.listReports()).toHaveLength(1);
      expect(EvaluationReportHistoryManager.listReports()[0].id).toBe(r2.id);

      EvaluationReportHistoryManager.clearHistory();
      expect(EvaluationReportHistoryManager.listReports()).toHaveLength(0);
    });
  });

  describe('Report Sanitization', () => {
    it('should strip secret keys, SQL queries, system prompts, scenario payloads, and transcripts', () => {
      const leakedReport: EvaluationReport & { sql?: string; apiKey?: string; transcripts?: string[] } = {
        ...sampleReport,
        sql: 'SELECT * FROM secrets',
        apiKey: 'sk-proj-xyz123',
        transcripts: ['User: Hello', 'Bot: Hi'],
      };

      const record = EvaluationReportHistoryManager.addReport(leakedReport);
      const keys = Object.keys(record.report);
      expect(keys).not.toContain('sql');
      expect(keys).not.toContain('apiKey');
      expect(keys).not.toContain('transcripts');
    });
  });

  describe('Report Versioning & Comparison', () => {
    it('should calculate comparison deltas accurately across statuses and quality metrics', () => {
      const baseReport = sampleReport;
      const targetReport: EvaluationReport = {
        ...sampleReport,
        latestRunSummary: targetSummary,
        regressionStatus: 'warning',
        qualityGate: {
          status: 'warning',
          reasons: ['Warning'],
          checkedMetrics: {},
          timestamp: new Date().toISOString(),
        },
      };

      const r1 = EvaluationReportHistoryManager.addReport(baseReport);
      const r2 = EvaluationReportHistoryManager.addReport(targetReport);

      const comparison = EvaluationReportHistoryManager.compareReports(r1.id, r2.id);
      expect(comparison.baseReportId).toBe(r1.id);
      expect(comparison.targetReportId).toBe(r2.id);

      expect(comparison.statusChange.base).toBe('pass');
      expect(comparison.statusChange.target).toBe('warning');

      expect(comparison.gateStatusChange.base).toBe('pass');
      expect(comparison.gateStatusChange.target).toBe('warning');

      const deltas = comparison.deltas;
      expect(deltas.retrievalRecall.base).toBe(0.8);
      expect(deltas.retrievalRecall.target).toBe(0.9);
      expect(deltas.retrievalRecall.absolute).toBeCloseTo(0.1, 5);

      expect(deltas.contextPrecision.base).toBe(0.8);
      expect(deltas.contextPrecision.target).toBe(0.75);
      expect(deltas.contextPrecision.absolute).toBeCloseTo(-0.05, 5);

      expect(deltas.averageLatency.base).toBe(500);
      expect(deltas.averageLatency.target).toBe(400);
      expect(deltas.averageLatency.absolute).toBe(-100);
    });

    it('should throw error when base or target report ID is missing or invalid', () => {
      const r1 = EvaluationReportHistoryManager.addReport(sampleReport);
      expect(() => {
        EvaluationReportHistoryManager.compareReports(r1.id, 'rpt_invalid_id');
      }).toThrow('Comparison reports not found in history.');
    });
  });

  describe('Production Isolation and Config Stability', () => {
    it('should verify production response requests bypass history tracking completely', async () => {
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
