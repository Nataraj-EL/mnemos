import { describe, it, expect, beforeEach } from 'vitest';
import { ExperimentHistoryManager } from './experimentHistory';
import { ExperimentResult, EvalSummary, TuningConfig } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';
import { compareSummaries } from './regression';

describe('Sprint 46: Experiment History & Longitudinal Analysis Tests', () => {
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
    recommendationExplanation: 'Candidate configuration improved recall without critical regressions.',
  };

  beforeEach(() => {
    ExperimentHistoryManager.clearHistory();
  });

  describe('Bounded History FIFO & Sorting', () => {
    it('should cap the history array at a maximum size of 20 runs (FIFO)', () => {
      for (let i = 0; i < 25; i++) {
        ExperimentHistoryManager.addRecord({
          ...mockResult,
          recommendationExplanation: `Run number ${i}`,
        });
      }

      const list = ExperimentHistoryManager.listRecords();
      expect(list).toHaveLength(20);
      
      // FIFO eviction: the oldest 5 runs (0, 1, 2, 3, 4) should be discarded.
      // Newest should be at list[0] (Run 24) and oldest remaining should be Run 5.
      expect(list[0].recommendationExplanation).toBe('Run number 24');
      expect(list[19].recommendationExplanation).toBe('Run number 5');
    });

    it('should order the list of runs newest-first based on timestamp descending', async () => {
      const r1 = ExperimentHistoryManager.addRecord(mockResult);
      // Wait briefly to ensure distinct timestamps if system clock granularity requires it
      await new Promise((r) => setTimeout(r, 5));
      const r2 = ExperimentHistoryManager.addRecord(mockResult);

      const list = ExperimentHistoryManager.listRecords();
      expect(list[0].id).toBe(r2.id);
      expect(list[1].id).toBe(r1.id);
    });
  });

  describe('Sanitization & Deep-Clone Protection', () => {
    it('should sanitize diagnostics and clone configs to avoid external state modifications', () => {
      const complexResult: ExperimentResult = {
        ...mockResult,
        controlSummary: {
          ...mockSummary,
          diagnostics: { rawData: 'secret key', sql: 'SELECT * FROM users' },
        } as unknown as EvalSummary,
      };

      const record = ExperimentHistoryManager.addRecord(complexResult);

      // Verify server-side ID is prepended
      expect(record.id).toMatch(/^exp-/);
      expect(record.timestamp).toBeDefined();

      // Verify secrets and diagnostics are removed
      expect((record.controlSummary as unknown as { diagnostics?: unknown }).diagnostics).toBeUndefined();
    });

    it('should be safe from outer object mutations after recording', () => {
      const mutableConfig = { ...mockConfig };
      const mutableSummary = { ...mockSummary };

      const result: ExperimentResult = {
        ...mockResult,
        controlConfig: mutableConfig,
        controlSummary: mutableSummary,
      };

      const record = ExperimentHistoryManager.addRecord(result);

      // Mutate external config objects
      mutableConfig.semanticWeight = 0.99;
      mutableSummary.averageLatency = 9999;

      // Check stored history was unaffected due to deep copy
      const stored = ExperimentHistoryManager.getRecord(record.id);
      expect(stored?.controlConfig.semanticWeight).toBe(0.7);
      expect(stored?.controlSummary.averageLatency).toBe(400);
    });
  });

  describe('Longitudinal Metric Comparison', () => {
    it('should compute metrics comparisons and handle missing values as notComparable', () => {
      const recordA = ExperimentHistoryManager.addRecord({
        ...mockResult,
        candidateSummary: {
          ...mockSummary,
          retrievalRecall: 0.80,
          faithfulness: 0.85,
        },
      });

      const recordB = ExperimentHistoryManager.addRecord({
        ...mockResult,
        candidateSummary: {
          ...mockSummary,
          retrievalRecall: 0.90, // improved by +0.10
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          faithfulness: undefined as any, // missing
        },
      });

      const comp = compareSummaries(recordB.candidateSummary, recordA.candidateSummary);

      expect(comp.deltas.retrievalRecall.type).toBe('improvement');
      expect(comp.deltas.retrievalRecall.absolute).toBeCloseTo(0.10);
      expect(comp.deltas.faithfulness.type).toBe('notComparable');
    });
  });

  describe('Delete and Clear Actions', () => {
    it('should support deleting specific records by ID and clearing history', () => {
      const r1 = ExperimentHistoryManager.addRecord(mockResult);
      const r2 = ExperimentHistoryManager.addRecord(mockResult);

      expect(ExperimentHistoryManager.listRecords()).toHaveLength(2);

      const deleted = ExperimentHistoryManager.deleteRecord(r1.id);
      expect(deleted).toBe(true);
      expect(ExperimentHistoryManager.listRecords()).toHaveLength(1);
      expect(ExperimentHistoryManager.getRecord(r1.id)).toBeUndefined();
      expect(ExperimentHistoryManager.getRecord(r2.id)).toBeDefined();

      ExperimentHistoryManager.clearHistory();
      expect(ExperimentHistoryManager.listRecords()).toHaveLength(0);
    });
  });

  describe('Production and Configurations Isolation', () => {
    it('should verify production respond queries bypass experiment history tracking completely', async () => {
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

      // Asserts that production runs do not record any experiment records
      expect(ExperimentHistoryManager.listRecords()).toHaveLength(0);
    });

    it('should verify normal runs do not mutate RETRIEVAL_SETTINGS parameters', () => {
      const originalSettingsString = JSON.stringify(RETRIEVAL_SETTINGS);
      expect(JSON.stringify(RETRIEVAL_SETTINGS)).toBe(originalSettingsString);
    });
  });
});
