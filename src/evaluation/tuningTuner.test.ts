import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateTuningMatrix, calculateBenchmarkScore, TuningRunner, resetTuningActiveLock, getIsTuningActive } from './tuner';
import { EvalScenario, EvalScenarioResult, TuningConfig } from './types';
import { EvaluationRunner } from './runner';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { POST } from '@/app/api/evaluation/tune/route';

vi.mock('@/db', () => ({
  getDbPool: vi.fn(() => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
  })),
}));

describe('Parameter Tuning & Matrix Optimization - Sprint 35', () => {
  beforeEach(() => {
    resetTuningActiveLock();
  });

  const mockScenario = (id: string): EvalScenario => ({
    scenarioId: id,
    name: `Scenario ${id}`,
    userId: 'user-1',
    query: 'What tea do I like?',
    inputMemories: [
      {
        id: 'mem-1',
        userId: 'user-1',
        type: 'FACT',
        content: 'You prefer Matcha tea.',
        metadata: { source: 'chat', status: 'active', confidence: 1.0, importance: 5, timestamp: new Date().toISOString() },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    expectedRelevantIds: ['mem-1'],
    maxTokens: 1000,
    isPersonal: true,
  });

  it('should generate bounded, explicit weight-normalized combinations without cartesian explosion', () => {
    const matrix = generateTuningMatrix();
    expect(matrix.length).toBeGreaterThan(0);
    expect(matrix.length).toBeLessThanOrEqual(30);

    for (const config of matrix) {
      // Validate bounds
      expect(config.semanticWeight).toBeGreaterThanOrEqual(0.0);
      expect(config.lexicalWeight).toBeGreaterThanOrEqual(0.0);
      expect(config.minSimilarity).toBeGreaterThanOrEqual(0.0);
      expect(config.diversityThreshold).toBeGreaterThanOrEqual(0.0);
      expect(config.maxConversationSnippets).toBeGreaterThan(0);

      // Validate weight normalization
      expect(config.semanticWeight + config.lexicalWeight).toBeCloseTo(1.0, 5);
    }
  });

  it('should calculate overall benchmark score deterministically based on weighted averages', () => {
    const metrics = {
      retrievalRecall: 1.0,
      contextPrecision: 0.8,
      userIsolation: 1.0,
      deduplicationRate: 1.0,
      tokenCompliance: 1.0,
      relevance: 0.9,
      faithfulness: 0.95,
      citationCorrectness: 0.85,
      contextUtilization: 0.75,
    };

    const score = calculateBenchmarkScore(metrics);
    // formula: relevance * 0.25 + faithfulness * 0.25 + citationCorrectness * 0.25 + contextUtilization * 0.15 + retrievalRecall * 0.10
    const expected = 0.9 * 0.25 + 0.95 * 0.25 + 0.85 * 0.25 + 0.75 * 0.15 + 1.0 * 0.10;
    expect(score).toBeCloseTo(expected, 5);
  });

  it('should isolate failed scenarios and prevent them from crashing the entire benchmark run', async () => {
    const failingRunner = {
      runScenario: vi.fn().mockRejectedValue(new Error('Retrieval simulated error')),
    } as unknown as EvaluationRunner;

    const tuner = new TuningRunner(failingRunner);
    const scenarios = [mockScenario('scen-1')];
    const matrix: TuningConfig[] = [
      { semanticWeight: 0.5, lexicalWeight: 0.5, minSimilarity: 0.1, diversityThreshold: 0.7, maxConversationSnippets: 3 },
    ];

    const result = await tuner.runTuning(scenarios, matrix);
    expect(result.matrixResults).toHaveLength(1);
    expect(result.matrixResults[0].passedCount).toBe(0);
    expect(result.matrixResults[0].failedCount).toBe(1);
    expect(result.matrixResults[0].averageMetrics.retrievalRecall).toBe(0);
  });

  it('should apply stable tie-breaker rules to ensure identical configuration results produce deterministic rankings', async () => {
    const mockMetrics = {
      retrievalRecall: 0.8,
      contextPrecision: 0.8,
      userIsolation: 1.0,
      deduplicationRate: 1.0,
      tokenCompliance: 1.0,
      relevance: 0.8,
      faithfulness: 0.8,
      citationCorrectness: 0.8,
      contextUtilization: 0.8,
    };

    const mockRunner = {
      runScenario: vi.fn().mockResolvedValue({
        passed: true,
        metrics: mockMetrics,
        latencyMs: 10,
      } as EvalScenarioResult),
    } as unknown as EvaluationRunner;

    const tuner = new TuningRunner(mockRunner);
    const scenarios = [mockScenario('scen-1')];

    // Create two configs that will yield exactly identical scores and passes
    // Tie-breaker rules: 
    // 1. Benchmark Score (Equal: 0.8)
    // 2. Passed count (Equal: 1)
    // 3. semanticWeight DESC -> configB (0.8) should rank before configA (0.2)
    const configA: TuningConfig = { semanticWeight: 0.2, lexicalWeight: 0.8, minSimilarity: 0.1, diversityThreshold: 0.7, maxConversationSnippets: 2 };
    const configB: TuningConfig = { semanticWeight: 0.8, lexicalWeight: 0.2, minSimilarity: 0.1, diversityThreshold: 0.7, maxConversationSnippets: 2 };

    const result = await tuner.runTuning(scenarios, [configA, configB]);
    expect(result.matrixResults[0].config.semanticWeight).toBe(0.8);
    expect(result.matrixResults[1].config.semanticWeight).toBe(0.2);
  });

  it('should reject matrix execution if configuration limits are exceeded', async () => {
    const tuner = new TuningRunner();
    const oversizedMatrix = Array(35).fill({
      semanticWeight: 0.5,
      lexicalWeight: 0.5,
      minSimilarity: 0.1,
      diversityThreshold: 0.7,
      maxConversationSnippets: 3,
    });

    await expect(tuner.runTuning([mockScenario('scen-1')], oversizedMatrix)).rejects.toThrow('exceeds the max limit of 30');
  });

  it('should enforce concurrency locks during active matrix execution requests', async () => {
    const slowRunner = {
      runScenario: () => new Promise((resolve) => setTimeout(() => resolve({ passed: true, metrics: {} } as unknown as EvalScenarioResult), 100)),
    } as unknown as EvaluationRunner;

    const tuner = new TuningRunner(slowRunner);
    const runPromise = tuner.runTuning([mockScenario('scen-1')], [{ semanticWeight: 0.5, lexicalWeight: 0.5, minSimilarity: 0.1, diversityThreshold: 0.7, maxConversationSnippets: 3 }]);

    expect(getIsTuningActive()).toBe(true);
    await expect(tuner.runTuning([mockScenario('scen-1')], [])).rejects.toThrow('Concurrent tuning execution blocked');

    await runPromise;
    expect(getIsTuningActive()).toBe(false);
  });

  it('should trigger execution timeout rejections if matrix runs exceed time limits', async () => {
    const eternalRunner = {
      runScenario: () => new Promise((resolve) => setTimeout(() => resolve({ passed: true, metrics: {} } as unknown as EvalScenarioResult), 10000)),
    } as unknown as EvaluationRunner;

    const tuner = new TuningRunner(eternalRunner, undefined, 50); // 50ms timeout limit
    await expect(tuner.runTuning([mockScenario('scen-1')], [{ semanticWeight: 0.5, lexicalWeight: 0.5, minSimilarity: 0.1, diversityThreshold: 0.7, maxConversationSnippets: 3 }])).rejects.toThrow('Tuning execution timeout exceeded.');
  });

  it('should restrict developer route authorization boundaries to development environments', async () => {
    // Simulate production environment
    vi.stubEnv('NODE_ENV', 'production');
    const response = await POST();
    const data = await response.json();
    expect(response.status).toBe(403);
    expect(data.error).toContain('only available in development environment');

    // Restore environment
    vi.unstubAllEnvs();
  });

  it('should keep active production defaults unchanged after tuning runs', async () => {
    const originalWeights = { ...RETRIEVAL_SETTINGS };
    const mockRunner = {
      runScenario: vi.fn().mockResolvedValue({
        passed: true,
        metrics: {
          retrievalRecall: 1.0,
          contextPrecision: 1.0,
          userIsolation: 1.0,
          deduplicationRate: 1.0,
          tokenCompliance: 1.0,
          relevance: 1.0,
          faithfulness: 1.0,
          citationCorrectness: 1.0,
          contextUtilization: 1.0,
        },
        latencyMs: 1,
      } as EvalScenarioResult),
    } as unknown as EvaluationRunner;

    const tuner = new TuningRunner(mockRunner);
    await tuner.runTuning([mockScenario('scen-1')], [{ semanticWeight: 0.1, lexicalWeight: 0.9, minSimilarity: 0.5, diversityThreshold: 0.9, maxConversationSnippets: 5 }]);

    // Confirm defaults did not change
    expect(RETRIEVAL_SETTINGS.semanticWeight).toBe(originalWeights.semanticWeight);
    expect(RETRIEVAL_SETTINGS.lexicalWeight).toBe(originalWeights.lexicalWeight);
    expect(RETRIEVAL_SETTINGS.minSimilarity).toBe(originalWeights.minSimilarity);
    expect(RETRIEVAL_SETTINGS.diversityThreshold).toBe(originalWeights.diversityThreshold);
    expect(RETRIEVAL_SETTINGS.maxConversationSnippets).toBe(originalWeights.maxConversationSnippets);
  });

  it('should exercise the real pipeline used by evaluation runs via runScenario', async () => {
    const runner = new EvaluationRunner();
    const scenario = mockScenario('scen-real');
    const config = { semanticWeight: 0.8, lexicalWeight: 0.2, minSimilarity: 0.2, diversityThreshold: 0.8, maxConversationSnippets: 4 };

    const result = await runner.runScenario(scenario, config);
    expect(result.scenarioId).toBe('scen-real');
    expect(result.metrics.retrievalRecall).toBeDefined();
    expect(result.metrics.faithfulness).toBeDefined();
  });
});
