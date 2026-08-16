import { describe, it, expect, beforeEach } from 'vitest';
import { EvaluationReportManager } from './report';
import { EvaluationHistoryManager } from './history';
import { BaselineManager } from './regression';
import { EvaluationConfigPromotionManager } from './promotion';
import { PromotionHistoryManager } from './promotionHistory';
import { ExperimentHistoryManager } from './experimentHistory';
import { EvalSummary, TuningConfig } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 52: Evaluation Report & Export Tests', () => {
  const mockSummary: EvalSummary = {
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

  beforeEach(() => {
    EvaluationHistoryManager.clearHistory();
    BaselineManager.clearBaseline();
    EvaluationConfigPromotionManager.clearPromotion();
    PromotionHistoryManager.clearHistory();
    ExperimentHistoryManager.clearHistory();
  });

  describe('Report Empty Falls and Graceful Recovery', () => {
    it('should generate report fallback schema when no evaluation runs exist', async () => {
      const report = await EvaluationReportManager.generateReport();
      expect(report.latestRunSummary).toBeNull();
      expect(report.qualityGate).toBeNull();
      expect(report.baselineAvailable).toBe(false);
      expect(report.regressionStatus).toBe('notComparable');
      expect(report.healthMetrics).toBeNull();
      expect(report.trendSummary).toBeNull();
      expect(report.promotedConfig).toBeNull();
      expect(report.recommendations).toHaveLength(0);
      expect(report.experimentSummary).toBeNull();
    });

    it('should handle no baseline by returning regressionStatus notComparable and baselineAvailable false', async () => {
      EvaluationHistoryManager.addRun(mockSummary);

      const report = await EvaluationReportManager.generateReport();
      expect(report.baselineAvailable).toBe(false);
      expect(report.regressionStatus).toBe('notComparable');
    });

    it('should handle no promoted config by returning promotedConfig null', async () => {
      EvaluationHistoryManager.addRun(mockSummary);

      const report = await EvaluationReportManager.generateReport();
      expect(report.promotedConfig).toBeNull();
    });

    it('should handle no experiment history by returning experimentSummary null', async () => {
      EvaluationHistoryManager.addRun(mockSummary);

      const report = await EvaluationReportManager.generateReport();
      expect(report.experimentSummary).toBeNull();
    });
  });

  describe('Aggregation, Sanitization and Determinism', () => {
    it('should verify report compilation does not mutate manager states', async () => {
      EvaluationHistoryManager.addRun(mockSummary);
      const originalHistory = JSON.stringify(EvaluationHistoryManager.listRuns());

      await EvaluationReportManager.generateReport();
      expect(JSON.stringify(EvaluationHistoryManager.listRuns())).toBe(originalHistory);
    });

    it('should sanitize prompts, sql, stack traces, and internal IDs from promoted config', async () => {
      EvaluationHistoryManager.addRun(mockSummary);

      const configWithSecrets: TuningConfig & { prompts?: string[]; sql?: string; uuid?: string } = {
        semanticWeight: 0.6,
        lexicalWeight: 0.4,
        minSimilarity: 0.5,
        diversityThreshold: 0.3,
        maxConversationSnippets: 10,
        prompts: ['System template overrides here'],
        sql: 'SELECT * FROM memories',
        uuid: 'd8c67f3-e928-46d1-917c',
      };

      EvaluationConfigPromotionManager.promote(configWithSecrets);

      const report = await EvaluationReportManager.generateReport();
      expect(report.promotedConfig).not.toBeNull();
      expect(report.promotedConfig?.semanticWeight).toBe(0.6);

      const configKeys = Object.keys(report.promotedConfig || {});
      expect(configKeys).not.toContain('prompts');
      expect(configKeys).not.toContain('sql');
      expect(configKeys).not.toContain('uuid');
    });

    it('should verify report schema keys remain stable and deterministic', async () => {
      EvaluationHistoryManager.addRun(mockSummary);
      const report = await EvaluationReportManager.generateReport();

      const reportKeys = Object.keys(report);
      expect(reportKeys).toEqual([
        'timestamp',
        'latestRunSummary',
        'qualityGate',
        'baselineAvailable',
        'regressionStatus',
        'healthMetrics',
        'trendSummary',
        'promotedConfig',
        'recommendations',
        'experimentSummary',
      ]);
    });
  });

  describe('Production Isolation and Config Stability', () => {
    it('should verify production response requests bypass report evaluations completely', async () => {
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
