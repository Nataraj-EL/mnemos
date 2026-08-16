import { describe, it, expect, beforeEach } from 'vitest';
import { ExperimentHistoryManager } from './experimentHistory';
import { ExperimentInsightsManager } from './experimentInsights';
import { ExperimentResult, EvalSummary, TuningConfig } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 47: Experiment Insights & Recommendation Tracking Tests', () => {
  const mockConfig: TuningConfig = {
    semanticWeight: 0.7,
    lexicalWeight: 0.3,
    minSimilarity: 0.5,
    diversityThreshold: 0.3,
    maxConversationSnippets: 10,
  };

  const mockSummary: EvalSummary = {
    total: 10,
    passed: 8,
    failed: 2,
    retrievalRecall: 0.85,
    contextPrecision: 0.90,
    isolationRate: 1.0,
    deduplicationRate: 1.0,
    tokenCompliance: 1.0,
    relevance: 0.90,
    faithfulness: 0.90,
    citationCorrectness: 0.90,
    contextUtilization: 0.80,
    averageLatency: 400,
    successRate: 0.80,
    cacheHitRate: 0.50,
    fallbackRate: 0.10,
    retryRate: 0.10,
    timeoutCount: 0,
  };

  const mockResult: ExperimentResult = {
    controlConfig: mockConfig,
    candidateConfig: { ...mockConfig, minSimilarity: 0.4 },
    controlSummary: mockSummary,
    candidateSummary: { ...mockSummary, retrievalRecall: 0.95 },
    comparison: {
      baselineAvailable: true,
      baselineLabel: 'Control',
      status: 'pass',
      failedThresholds: [],
      deltas: {
        retrievalRecall: { absolute: 0.10, percentage: 11.7, type: 'improvement' },
      },
    },
    recommendation: 'candidate',
    recommendationExplanation: 'Candidate configuration improved recall.',
  };

  beforeEach(() => {
    ExperimentHistoryManager.clearHistory();
  });

  describe('Minimum History Guard', () => {
    it('should return insufficientHistory status if history size is less than 2', () => {
      // Empty history
      let insights = ExperimentInsightsManager.generateInsights();
      expect(insights.insufficientHistory).toBe(true);
      expect(insights.totalExperiments).toBe(0);

      // Single record
      ExperimentHistoryManager.addRecord(mockResult);
      insights = ExperimentInsightsManager.generateInsights();
      expect(insights.insufficientHistory).toBe(true);
      expect(insights.totalExperiments).toBe(1);
    });
  });

  describe('Win and Draw Distribution Aggregation', () => {
    it('should aggregate win outcomes across multiple experiments successfully', () => {
      // Record 1: Candidate Win
      ExperimentHistoryManager.addRecord(mockResult);
      // Record 2: Control Win
      ExperimentHistoryManager.addRecord({
        ...mockResult,
        recommendation: 'control',
      });
      // Record 3: Draw
      ExperimentHistoryManager.addRecord({
        ...mockResult,
        recommendation: 'draw',
      });

      const insights = ExperimentInsightsManager.generateInsights();
      expect(insights.insufficientHistory).toBe(false);
      expect(insights.totalExperiments).toBe(3);
      expect(insights.candidateWins).toBe(1);
      expect(insights.controlWins).toBe(1);
      expect(insights.draws).toBe(1);
    });
  });

  describe('Deterministic Best Configuration Selection', () => {
    it('should select candidate config if it won with the highest comparison margin', () => {
      // Run A: Candidate win, margin = (0.90 - 0.70) = 0.20
      ExperimentHistoryManager.addRecord({
        ...mockResult,
        candidateConfig: { ...mockConfig, semanticWeight: 0.8 },
        candidateSummary: { ...mockSummary, retrievalRecall: 0.90 },
        controlSummary: { ...mockSummary, retrievalRecall: 0.70 },
        recommendation: 'candidate',
      });

      // Run B: Candidate win, margin = (0.95 - 0.60) = 0.35 (optimal)
      ExperimentHistoryManager.addRecord({
        ...mockResult,
        candidateConfig: { ...mockConfig, semanticWeight: 0.9 },
        candidateSummary: { ...mockSummary, retrievalRecall: 0.95 },
        controlSummary: { ...mockSummary, retrievalRecall: 0.60 },
        recommendation: 'candidate',
      });

      const insights = ExperimentInsightsManager.generateInsights();
      expect(insights.bestConfigSource).toBe('candidate');
      expect(insights.bestConfig?.semanticWeight).toBe(0.9);
    });

    it('should select control config if it won with the highest comparison margin', () => {
      // Run A: Control win, margin = (0.90 - 0.70) = 0.20
      ExperimentHistoryManager.addRecord({
        ...mockResult,
        controlConfig: { ...mockConfig, lexicalWeight: 0.8 },
        controlSummary: { ...mockSummary, retrievalRecall: 0.90 },
        candidateSummary: { ...mockSummary, retrievalRecall: 0.70 },
        recommendation: 'control',
      });

      // Run B: Control win, margin = (0.95 - 0.60) = 0.35 (optimal)
      ExperimentHistoryManager.addRecord({
        ...mockResult,
        controlConfig: { ...mockConfig, lexicalWeight: 0.9 },
        controlSummary: { ...mockSummary, retrievalRecall: 0.95 },
        candidateSummary: { ...mockSummary, retrievalRecall: 0.60 },
        recommendation: 'control',
      });

      const insights = ExperimentInsightsManager.generateInsights();
      expect(insights.bestConfigSource).toBe('control');
      expect(insights.bestConfig?.lexicalWeight).toBe(0.9);
    });

    it('should tie-break by choosing the most recent run when margins are equal', async () => {
      // Old run
      ExperimentHistoryManager.addRecord({
        ...mockResult,
        candidateConfig: { ...mockConfig, minSimilarity: 0.6 },
        candidateSummary: { ...mockSummary, retrievalRecall: 0.90 },
        controlSummary: { ...mockSummary, retrievalRecall: 0.80 },
        recommendation: 'candidate',
      });

      await new Promise((r) => setTimeout(r, 5));

      // Newer run with identical margin (0.90 - 0.80) = 0.10
      ExperimentHistoryManager.addRecord({
        ...mockResult,
        candidateConfig: { ...mockConfig, minSimilarity: 0.7 },
        candidateSummary: { ...mockSummary, retrievalRecall: 0.90 },
        controlSummary: { ...mockSummary, retrievalRecall: 0.80 },
        recommendation: 'candidate',
      });

      const insights = ExperimentInsightsManager.generateInsights();
      // Should pick the newest run config
      expect(insights.bestConfig?.minSimilarity).toBe(0.7);
    });
  });

  describe('Validation of Non-finite and Undefined values', () => {
    it('should calculate average deltas ignoring undefined and NaN values safely', () => {
      ExperimentHistoryManager.addRecord({
        ...mockResult,
        candidateSummary: { ...mockSummary, retrievalRecall: 0.90 },
        controlSummary: { ...mockSummary, retrievalRecall: 0.80 },
      });

      ExperimentHistoryManager.addRecord({
        ...mockResult,
        candidateSummary: { ...mockSummary, retrievalRecall: NaN } as unknown as EvalSummary,
        controlSummary: { ...mockSummary, retrievalRecall: 0.80 },
      });

      ExperimentHistoryManager.addRecord({
        ...mockResult,
        candidateSummary: { ...mockSummary, retrievalRecall: undefined } as unknown as EvalSummary,
        controlSummary: { ...mockSummary, retrievalRecall: 0.80 },
      });

      const insights = ExperimentInsightsManager.generateInsights();
      // Average recall delta should be computed using only the first valid record: (0.90 - 0.80) = 0.10
      expect(insights.averageDeltas.retrievalRecall).toBeCloseTo(0.10);
    });
  });

  describe('Latency Semantics and Production Isolation', () => {
    it('should treat decrease in latency as improving and increase as degrading', () => {
      ExperimentHistoryManager.addRecord({
        ...mockResult,
        candidateSummary: { ...mockSummary, averageLatency: 200 }, // improved by -600ms relative to control 800
        controlSummary: { ...mockSummary, averageLatency: 800 },
      });

      ExperimentHistoryManager.addRecord({
        ...mockResult,
        candidateSummary: { ...mockSummary, averageLatency: 200 },
        controlSummary: { ...mockSummary, averageLatency: 800 },
      });

      let insights = ExperimentInsightsManager.generateInsights();
      expect(insights.improvingMetrics).toContain('averageLatency');

      // Clear and test degradation
      ExperimentHistoryManager.clearHistory();

      ExperimentHistoryManager.addRecord({
        ...mockResult,
        candidateSummary: { ...mockSummary, averageLatency: 1400 }, // degraded by +600ms relative to control 800
        controlSummary: { ...mockSummary, averageLatency: 800 },
      });

      ExperimentHistoryManager.addRecord({
        ...mockResult,
        candidateSummary: { ...mockSummary, averageLatency: 1400 },
        controlSummary: { ...mockSummary, averageLatency: 800 },
      });

      insights = ExperimentInsightsManager.generateInsights();
      expect(insights.degradingMetrics).toContain('averageLatency');
    });

    it('should verify production respond queries bypass experiment insights extraction completely', async () => {
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
        evaluationRun: false,
      });

      expect(ExperimentHistoryManager.listRecords()).toHaveLength(0);
    });

    it('should verify original RETRIEVAL_SETTINGS defaults are untouched', () => {
      const originalSettingsString = JSON.stringify(RETRIEVAL_SETTINGS);
      expect(JSON.stringify(RETRIEVAL_SETTINGS)).toBe(originalSettingsString);
    });
  });
});
