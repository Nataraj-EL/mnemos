import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EvaluationExperimentRunner } from './experiment';
import { TuningConfig } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { EvaluationRunner } from './runner';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 45: Evaluation Experimentation & A/B Configuration Tests', () => {
  const controlConfig: TuningConfig = {
    semanticWeight: 0.7,
    lexicalWeight: 0.3,
    minSimilarity: 0.5,
    diversityThreshold: 0.3,
    maxConversationSnippets: 10,
  };

  const candidateConfig: TuningConfig = {
    semanticWeight: 0.5,
    lexicalWeight: 0.5,
    minSimilarity: 0.4,
    diversityThreshold: 0.3,
    maxConversationSnippets: 12,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Configuration Validation', () => {
    it('should reject configs with negative values, NaN, or Infinity', () => {
      expect(() => EvaluationExperimentRunner.validateConfig({
        ...controlConfig,
        semanticWeight: -0.1,
      })).toThrow();

      expect(() => EvaluationExperimentRunner.validateConfig({
        ...controlConfig,
        minSimilarity: NaN,
      })).toThrow();

      expect(() => EvaluationExperimentRunner.validateConfig({
        ...controlConfig,
        lexicalWeight: Infinity,
      })).toThrow();
    });

    it('should reject configs exceeding safe bounds', () => {
      expect(() => EvaluationExperimentRunner.validateConfig({
        ...controlConfig,
        semanticWeight: 1.5,
      })).toThrow();

      expect(() => EvaluationExperimentRunner.validateConfig({
        ...controlConfig,
        maxConversationSnippets: 150,
      })).toThrow();
    });
  });

  describe('Concurrency Safety & Lock Release', () => {
    it('should prevent overlapping executions and release lock on failure or success', async () => {
      // Mock runAll to delay
      vi.spyOn(EvaluationRunner.prototype, 'runAll').mockImplementation(async () => {
        return {
          results: [],
          summary: {
            total: 10, passed: 10, failed: 0,
            retrievalRecall: 1, contextPrecision: 1, isolationRate: 1, deduplicationRate: 1, tokenCompliance: 1,
            relevance: 1, faithfulness: 1, citationCorrectness: 1, contextUtilization: 1, averageLatency: 200,
          },
        };
      });

      // Start first run
      const p1 = EvaluationExperimentRunner.runExperiment(controlConfig, candidateConfig);

      // Start concurrent run which should immediately fail
      await expect(EvaluationExperimentRunner.runExperiment(controlConfig, candidateConfig))
        .rejects.toThrow('An experiment is already in progress');

      // Await success
      const result = await p1;
      expect(result).toBeDefined();

      // Lock must be released, so next execution starts successfully
      const p2 = EvaluationExperimentRunner.runExperiment(controlConfig, candidateConfig);
      await expect(p2).resolves.toBeDefined();
    });

    it('should release lock when a validation exception occurs', async () => {
      const invalidConfig = { ...candidateConfig, minSimilarity: 10.0 };

      await expect(EvaluationExperimentRunner.runExperiment(controlConfig, invalidConfig))
        .rejects.toThrow();

      // Expect lock to be false now, so a valid run can execute
      vi.spyOn(EvaluationRunner.prototype, 'runAll').mockImplementation(async () => {
        return {
          results: [],
          summary: {
            total: 10, passed: 10, failed: 0,
            retrievalRecall: 1, contextPrecision: 1, isolationRate: 1, deduplicationRate: 1, tokenCompliance: 1,
            relevance: 1, faithfulness: 1, citationCorrectness: 1, contextUtilization: 1, averageLatency: 200,
          },
        };
      });

      await expect(EvaluationExperimentRunner.runExperiment(controlConfig, candidateConfig))
        .resolves.toBeDefined();
    });
  });

  describe('Global Parameter Isolation & Stability', () => {
    it('should execute experiments without modifying the global RETRIEVAL_SETTINGS constants', async () => {
      // Capture byte-for-byte values of settings prior to runs
      const originalSettingsString = JSON.stringify(RETRIEVAL_SETTINGS);

      vi.spyOn(EvaluationRunner.prototype, 'runAll').mockImplementation(async () => {
        return {
          results: [],
          summary: {
            total: 10, passed: 10, failed: 0,
            retrievalRecall: 1, contextPrecision: 1, isolationRate: 1, deduplicationRate: 1, tokenCompliance: 1,
            relevance: 1, faithfulness: 1, citationCorrectness: 1, contextUtilization: 1, averageLatency: 200,
          },
        };
      });

      await EvaluationExperimentRunner.runExperiment(controlConfig, candidateConfig);

      // Asserts unchanged
      expect(JSON.stringify(RETRIEVAL_SETTINGS)).toBe(originalSettingsString);
    });
  });

  describe('Real Pipeline Enforcement & Execution Errors', () => {
    it('should enforce benchmarkMode is real and crash cleanly if runs fail', async () => {
      const runAllSpy = vi.spyOn(EvaluationRunner.prototype, 'runAll').mockImplementation(async (_scenarios, _config, options) => {
        expect(options?.benchmarkMode).toBe('real');
        return {
          results: [
            {
              scenarioId: 'sc-1',
              name: 'Failed scenario',
              passed: false,
              metrics: {
                retrievalRecall: 0, contextPrecision: 0, userIsolation: 0, deduplicationRate: 0, tokenCompliance: 0,
                relevance: 0, faithfulness: 0, citationCorrectness: 0, contextUtilization: 0,
              },
              latencyMs: 100,
              failureReason: 'GEMINI_API_KEY environment variable is not defined.',
            },
          ],
          summary: {
            total: 1, passed: 0, failed: 1,
            retrievalRecall: 0, contextPrecision: 0, isolationRate: 0, deduplicationRate: 0, tokenCompliance: 0,
            relevance: 0, faithfulness: 0, citationCorrectness: 0, contextUtilization: 0, averageLatency: 100,
          },
        };
      });

      await expect(EvaluationExperimentRunner.runExperiment(controlConfig, candidateConfig))
        .rejects.toThrow('Control run failed');

      expect(runAllSpy).toHaveBeenCalledTimes(1); // Control execution failed, Candidate did not execute
    });
  });

  describe('Deterministic Winner Resolution', () => {
    it('should select Candidate if it has superior recall metric votes', async () => {
      let callCount = 0;
      vi.spyOn(EvaluationRunner.prototype, 'runAll').mockImplementation(async () => {
        callCount++;
        const isControl = callCount === 1;
        return {
          results: [],
          summary: {
            total: 10, passed: isControl ? 5 : 8, failed: isControl ? 5 : 2,
            retrievalRecall: isControl ? 0.70 : 0.90, // Candidate has +0.20 recall (> 0.05 tolerance)
            contextPrecision: 0.90,
            isolationRate: 1, deduplicationRate: 1, tokenCompliance: 1,
            relevance: 0.90, faithfulness: 0.90, citationCorrectness: 0.90,
            contextUtilization: 0.90, averageLatency: 500,
          },
        };
      });

      const res = await EvaluationExperimentRunner.runExperiment(controlConfig, candidateConfig);
      expect(res.recommendation).toBe('candidate');
      expect(res.recommendationExplanation).toContain('Candidate is recommended');
    });

    it('should select Control if Candidate introduces critical regressions', async () => {
      let callCount = 0;
      vi.spyOn(EvaluationRunner.prototype, 'runAll').mockImplementation(async () => {
        callCount++;
        const isControl = callCount === 1;
        return {
          results: [],
          summary: {
            total: 10, passed: isControl ? 8 : 4, failed: isControl ? 2 : 6,
            retrievalRecall: isControl ? 0.90 : 0.82, // Candidate drops by 0.08 (> 0.05 tolerance) -> regression
            contextPrecision: 0.90,
            isolationRate: 1, deduplicationRate: 1, tokenCompliance: 1,
            relevance: 0.90, faithfulness: 0.90, citationCorrectness: 0.90,
            contextUtilization: 0.90, averageLatency: 500,
          },
        };
      });

      const res = await EvaluationExperimentRunner.runExperiment(controlConfig, candidateConfig);
      expect(res.recommendation).toBe('control');
      expect(res.recommendationExplanation).toContain('Candidate configuration introduced critical quality regressions');
    });

    it('should select draw if metrics lie within standard tolerances', async () => {
      let callCount = 0;
      vi.spyOn(EvaluationRunner.prototype, 'runAll').mockImplementation(async () => {
        callCount++;
        const isControl = callCount === 1;
        return {
          results: [],
          summary: {
            total: 10, passed: 9, failed: 1,
            retrievalRecall: isControl ? 0.88 : 0.91, // change of +0.03 <= 0.05 -> stable
            contextPrecision: 0.90,
            isolationRate: 1, deduplicationRate: 1, tokenCompliance: 1,
            relevance: 0.90, faithfulness: 0.90, citationCorrectness: 0.90,
            contextUtilization: 0.90, averageLatency: 500,
          },
        };
      });

      const res = await EvaluationExperimentRunner.runExperiment(controlConfig, candidateConfig);
      expect(res.recommendation).toBe('draw');
    });
  });

  describe('Production Isolation', () => {
    it('should verify production respond queries bypass baseline/history/experiment tracking completely', async () => {
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
    });
  });
});
