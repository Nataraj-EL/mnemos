import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EvaluationHistoryManager } from './history';
import { compareSummaries } from './regression';
import { EvalSummary } from './types';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 42: Evaluation History & Run Comparison Tests', () => {
  beforeEach(() => {
    EvaluationHistoryManager.clearHistory();
  });

  const dummySummary: EvalSummary = {
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

  describe('Bounded History Limit (Max 20 Runs FIFO)', () => {
    it('should evict oldest runs to cap memory usage at 20 records', () => {
      // Add 22 runs
      for (let i = 1; i <= 22; i++) {
        EvaluationHistoryManager.addRun({
          ...dummySummary,
          averageLatency: 100 + i, // Unique latency to track run
        });
      }

      const runs = EvaluationHistoryManager.listRuns();

      expect(runs).toHaveLength(20);
      // Newest-first sorting means index 0 is run 22, index 19 is run 3. Run 1 and 2 should be evicted.
      expect(runs[0].summary.averageLatency).toBe(122);
      expect(runs[19].summary.averageLatency).toBe(103);
    });
  });

  describe('Newest-First Ordering', () => {
    it('should return runs sorted in descending timestamp order', () => {
      EvaluationHistoryManager.addRun({ ...dummySummary, averageLatency: 100 });
      EvaluationHistoryManager.addRun({ ...dummySummary, averageLatency: 200 });

      const runs = EvaluationHistoryManager.listRuns();
      expect(runs).toHaveLength(2);
      expect(runs[0].summary.averageLatency).toBe(200); // Newest
      expect(runs[1].summary.averageLatency).toBe(100); // Oldest
    });
  });

  describe('Sanitization & Security compliance', () => {
    it('should strip raw prompts, transcripts, error stacks, API keys, or SQL from history runs', () => {
      const dirty = {
        ...dummySummary,
        scenarios: [{ id: 'sc-1' }],
        apiKey: 'secret-key',
        sql: 'DROP TABLE memories',
      };

      const record = EvaluationHistoryManager.addRun(dirty as unknown as EvalSummary);
      const cleanRecord = record.summary as unknown as Record<string, unknown>;

      expect(cleanRecord.scenarios).toBeUndefined();
      expect(cleanRecord.apiKey).toBeUndefined();
      expect(cleanRecord.sql).toBeUndefined();
      expect(record.summary.averageLatency).toBe(200);
    });
  });

  describe('Delete and Clear operations', () => {
    it('should support deleting specific run and clearing all run history', () => {
      const r1 = EvaluationHistoryManager.addRun(dummySummary);
      const r2 = EvaluationHistoryManager.addRun(dummySummary);

      expect(EvaluationHistoryManager.listRuns()).toHaveLength(2);

      const deleted = EvaluationHistoryManager.deleteRun(r1.id);
      expect(deleted).toBe(true);

      const runsAfterDelete = EvaluationHistoryManager.listRuns();
      expect(runsAfterDelete).toHaveLength(1);
      expect(runsAfterDelete[0].id).toBe(r2.id);

      EvaluationHistoryManager.clearHistory();
      expect(EvaluationHistoryManager.listRuns()).toHaveLength(0);
    });
  });

  describe('Run-to-Run Comparison Deltas', () => {
    it('should compare any two history records correctly', () => {
      const baseRun = EvaluationHistoryManager.addRun({
        ...dummySummary,
        retrievalRecall: 0.90,
        averageLatency: 1000,
      });

      const targetRun = EvaluationHistoryManager.addRun({
        ...dummySummary,
        retrievalRecall: 0.85, // Regressed: 0.85 < 0.90
        averageLatency: 800,   // Improved (lower latency): 800 < 1000
      });

      const regression = compareSummaries(targetRun.summary, baseRun.summary);

      expect(regression.baselineAvailable).toBe(true);
      expect(regression.deltas.retrievalRecall.type).toBe('regression');
      expect(regression.deltas.retrievalRecall.absolute).toBeCloseTo(-0.05);

      expect(regression.deltas.averageLatency.type).toBe('improvement');
      expect(regression.deltas.averageLatency.absolute).toBe(-200);
    });
  });

  describe('Production Isolation & Failed-Run Isolation', () => {
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
        evaluationRun: false, // Production path
      });

      expect(result.diagnostics).toBeUndefined();
      // Confirm no runs were inserted in in-memory history
      expect(EvaluationHistoryManager.listRuns()).toHaveLength(0);
    });
  });
});
