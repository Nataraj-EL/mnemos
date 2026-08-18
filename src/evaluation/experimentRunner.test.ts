import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EvaluationExperimentRunner } from '@/evaluation/experiment';
import { ExperimentHistoryManager } from '@/evaluation/experimentHistory';
import { ConfigSafetyGuard } from '@/evaluation/configGuard';
import { EvaluationRunner } from './runner';
import { POST as RunPOST } from '@/app/api/evaluation/experiments/run/route';
import { GET as ResultsGET } from '@/app/api/evaluation/experiments/results/route';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { TuningConfig } from './types';

describe('Sprint 64: Controlled A/B Evaluation Experiments', () => {
  const defaultBaseline: TuningConfig = {
    semanticWeight: 0.7,
    lexicalWeight: 0.3,
    minSimilarity: 0.5,
    diversityThreshold: 0.3,
    maxConversationSnippets: 10,
  };

  const defaultCandidate: TuningConfig = {
    semanticWeight: 0.6,
    lexicalWeight: 0.4,
    minSimilarity: 0.5,
    diversityThreshold: 0.3,
    maxConversationSnippets: 10,
  };

  beforeEach(() => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    ExperimentHistoryManager.clearControlledHistory();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    (process.env as Record<string, string>).NODE_ENV = 'test';
  });

  it('should verify original RETRIEVAL_SETTINGS defaults are untouched (Immutability)', () => {
    const originalSettingsString = JSON.stringify(RETRIEVAL_SETTINGS);
    ConfigSafetyGuard.validate(defaultCandidate);
    expect(JSON.stringify(RETRIEVAL_SETTINGS)).toBe(originalSettingsString);
  });

  it('should reject candidate config with invalid weight sum (Safety Validation)', () => {
    const invalidConfig: TuningConfig = {
      semanticWeight: 0.8,
      lexicalWeight: 0.8, // sum is 1.6, invalid
      minSimilarity: 0.5,
      diversityThreshold: 0.3,
      maxConversationSnippets: 10,
    };

    const safetyResult = ConfigSafetyGuard.validate(invalidConfig);
    expect(safetyResult.valid).toBe(false);
    expect(safetyResult.errors.length).toBeGreaterThan(0);
  });

  it('should block api routes in non-development/testing environments (Production Isolation)', async () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';

    const runResponse = await RunPOST(new Request('http://localhost/api/evaluation/experiments/run', {
      method: 'POST',
      body: JSON.stringify({ candidateConfig: defaultCandidate }),
    }));
    expect(runResponse.status).toBe(403);

    const resultsResponse = await ResultsGET();
    expect(resultsResponse.status).toBe(403);
  });

  it('should run a controlled experiment and return candidateBetter if candidate metrics improve significantly', async () => {
    let runCount = 0;
    vi.spyOn(EvaluationRunner.prototype, 'runAll').mockImplementation(async () => {
      runCount++;
      const isControl = runCount === 1;
      return {
        results: [],
        summary: {
          total: 10,
          passed: isControl ? 7 : 9,
          failed: isControl ? 3 : 1,
          retrievalRecall: isControl ? 0.7 : 0.9, // Candidate recall improved by 0.20 (> 0.05 tolerance)
          contextPrecision: 0.8,
          isolationRate: 1.0,
          deduplicationRate: 1.0,
          tokenCompliance: 1.0,
          relevance: 0.8,
          faithfulness: 0.8,
          citationCorrectness: 0.8,
          contextUtilization: 0.8,
          averageLatency: 200,
        },
      };
    });

    const result = await EvaluationExperimentRunner.runControlledExperiment(
      defaultBaseline,
      defaultCandidate
    );

    expect(result.experimentId).toBeDefined();
    expect(result.baselineConfig).toEqual(defaultBaseline);
    expect(result.candidateConfig).toEqual(defaultCandidate);
    expect(result.decision).toBe('candidateBetter');
    expect(result.metricsComparison.retrievalRecall.status).toBe('improved');

    expect(result.baselineConfig).not.toBe(defaultBaseline);
    expect(result.candidateConfig).not.toBe(defaultCandidate);
  });

  it('should return baselineBetter if candidate degrades metrics beyond tolerance', async () => {
    let runCount = 0;
    vi.spyOn(EvaluationRunner.prototype, 'runAll').mockImplementation(async () => {
      runCount++;
      const isControl = runCount === 1;
      return {
        results: [],
        summary: {
          total: 10,
          passed: isControl ? 9 : 7,
          failed: isControl ? 1 : 3,
          retrievalRecall: isControl ? 0.9 : 0.7, // Candidate degraded recall by 0.20 (> 0.05 tolerance)
          contextPrecision: 0.8,
          isolationRate: 1.0,
          deduplicationRate: 1.0,
          tokenCompliance: 1.0,
          relevance: 0.8,
          faithfulness: 0.8,
          citationCorrectness: 0.8,
          contextUtilization: 0.8,
          averageLatency: 200,
        },
      };
    });

    const result = await EvaluationExperimentRunner.runControlledExperiment(
      defaultBaseline,
      defaultCandidate
    );

    expect(result.decision).toBe('baselineBetter');
    expect(result.metricsComparison.retrievalRecall.status).toBe('degraded');
  });

  it('should return candidateBetter if candidate latency improves beyond tolerance', async () => {
    let runCount = 0;
    vi.spyOn(EvaluationRunner.prototype, 'runAll').mockImplementation(async () => {
      runCount++;
      const isControl = runCount === 1;
      return {
        results: [],
        summary: {
          total: 10,
          passed: 10,
          failed: 0,
          retrievalRecall: 0.8,
          contextPrecision: 0.8,
          isolationRate: 1.0,
          deduplicationRate: 1.0,
          tokenCompliance: 1.0,
          relevance: 0.8,
          faithfulness: 0.8,
          citationCorrectness: 0.8,
          contextUtilization: 0.8,
          averageLatency: isControl ? 1200 : 500, // Candidate latency improved by 700ms (> 500ms tolerance)
        },
      };
    });

    const result = await EvaluationExperimentRunner.runControlledExperiment(
      defaultBaseline,
      defaultCandidate
    );

    expect(result.decision).toBe('candidateBetter');
    expect(result.metricsComparison.averageLatency.status).toBe('improved');
  });

  it('should return baselineBetter if candidate latency regresses beyond tolerance', async () => {
    let runCount = 0;
    vi.spyOn(EvaluationRunner.prototype, 'runAll').mockImplementation(async () => {
      runCount++;
      const isControl = runCount === 1;
      return {
        results: [],
        summary: {
          total: 10,
          passed: 10,
          failed: 0,
          retrievalRecall: 0.8,
          contextPrecision: 0.8,
          isolationRate: 1.0,
          deduplicationRate: 1.0,
          tokenCompliance: 1.0,
          relevance: 0.8,
          faithfulness: 0.8,
          citationCorrectness: 0.8,
          contextUtilization: 0.8,
          averageLatency: isControl ? 500 : 1200, // Candidate latency regressed by 700ms (> 500ms tolerance)
        },
      };
    });

    const result = await EvaluationExperimentRunner.runControlledExperiment(
      defaultBaseline,
      defaultCandidate
    );

    expect(result.decision).toBe('baselineBetter');
    expect(result.metricsComparison.averageLatency.status).toBe('degraded');
  });

  it('should return insufficientData if total runs is 0', async () => {
    vi.spyOn(EvaluationRunner.prototype, 'runAll').mockImplementation(async () => {
      return {
        results: [],
        summary: {
          total: 0,
          passed: 0,
          failed: 0,
          retrievalRecall: 0,
          contextPrecision: 0,
          isolationRate: 0,
          deduplicationRate: 0,
          tokenCompliance: 0,
          relevance: 0,
          faithfulness: 0,
          citationCorrectness: 0,
          contextUtilization: 0,
          averageLatency: 0,
        },
      };
    });

    const result = await EvaluationExperimentRunner.runControlledExperiment(
      defaultBaseline,
      defaultCandidate
    );

    expect(result.decision).toBe('insufficientData');
    expect(result.metricsComparison.retrievalRecall.status).toBe('insufficientData');
  });

  it('should persist result in controlled history and support listing/deletion', async () => {
    vi.spyOn(EvaluationRunner.prototype, 'runAll').mockImplementation(async () => {
      return {
        results: [],
        summary: {
          total: 10,
          passed: 8,
          failed: 2,
          retrievalRecall: 0.8,
          contextPrecision: 0.8,
          isolationRate: 1.0,
          deduplicationRate: 1.0,
          tokenCompliance: 1.0,
          relevance: 0.8,
          faithfulness: 0.8,
          citationCorrectness: 0.8,
          contextUtilization: 0.8,
          averageLatency: 200,
        },
      };
    });

    const result = await EvaluationExperimentRunner.runControlledExperiment(
      defaultBaseline,
      defaultCandidate
    );

    ExperimentHistoryManager.addControlledRecord(result);

    const history = ExperimentHistoryManager.listControlledRecords();
    expect(history.length).toBe(1);
    expect(history[0].experimentId).toBe(result.experimentId);

    const retrieved = ExperimentHistoryManager.getControlledRecord(result.experimentId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.experimentId).toBe(result.experimentId);

    const deleted = ExperimentHistoryManager.deleteControlledRecord(result.experimentId);
    expect(deleted).toBe(true);
    expect(ExperimentHistoryManager.listControlledRecords().length).toBe(0);
  });

  it('should reject invalid POST requests to /api/evaluation/experiments/run with status 400', async () => {
    const badRequest = new Request('http://localhost/api/evaluation/experiments/run', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await RunPOST(badRequest);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain('Missing candidateConfig');
  });

  it('should return error 400 when candidateConfig is invalid via ConfigSafetyGuard', async () => {
    const invalidCandidate = {
      semanticWeight: 0.9,
      lexicalWeight: 0.9,
      minSimilarity: 0.5,
      diversityThreshold: 0.3,
      maxConversationSnippets: 10,
    };

    const badRequest = new Request('http://localhost/api/evaluation/experiments/run', {
      method: 'POST',
      body: JSON.stringify({ candidateConfig: invalidCandidate }),
    });

    const response = await RunPOST(badRequest);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain('Invalid candidate configuration');
  });
});
