import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateTuningMatrix, calculateBenchmarkScore, TuningRunner, resetTuningActiveLock, getIsTuningActive } from './tuner';
import { EvalScenario, EvalScenarioResult, TuningConfig } from './types';
import { EvaluationRunner } from './runner';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { POST } from '@/app/api/evaluation/tune/route';
import { getDbPool } from '@/db';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';
import { NextRequest } from 'next/server';

const { mockQuery } = vi.hoisted(() => {
  return {
    mockQuery: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
});

vi.mock('@/db', () => {
  return {
    getDbPool: vi.fn(() => ({
      query: mockQuery,
    })),
  };
});

vi.mock('@/memory/geminiEmbedding', () => {
  return {
    GeminiEmbeddingProvider: class {
      generateEmbedding(): Promise<number[]> {
        return Promise.resolve(Array(768).fill(0.1));
      }
    },
  };
});

describe('Parameter Tuning & Matrix Optimization - Sprint 36', () => {
  beforeEach(() => {
    resetTuningActiveLock();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
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
      expect(config.semanticWeight).toBeGreaterThanOrEqual(0.0);
      expect(config.lexicalWeight).toBeGreaterThanOrEqual(0.0);
      expect(config.minSimilarity).toBeGreaterThanOrEqual(0.0);
      expect(config.diversityThreshold).toBeGreaterThanOrEqual(0.0);
      expect(config.maxConversationSnippets).toBeGreaterThan(0);
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

    const result = await tuner.runTuning(scenarios, matrix, 'mock');
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

    const configA: TuningConfig = { semanticWeight: 0.2, lexicalWeight: 0.8, minSimilarity: 0.1, diversityThreshold: 0.7, maxConversationSnippets: 2 };
    const configB: TuningConfig = { semanticWeight: 0.8, lexicalWeight: 0.2, minSimilarity: 0.1, diversityThreshold: 0.7, maxConversationSnippets: 2 };

    const result = await tuner.runTuning(scenarios, [configA, configB], 'mock');
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
    const runPromise = tuner.runTuning([mockScenario('scen-1')], [{ semanticWeight: 0.5, lexicalWeight: 0.5, minSimilarity: 0.1, diversityThreshold: 0.7, maxConversationSnippets: 3 }], 'mock');

    expect(getIsTuningActive()).toBe(true);
    await expect(tuner.runTuning([mockScenario('scen-1')], [], 'mock')).rejects.toThrow('Concurrent tuning execution blocked');

    await runPromise;
    expect(getIsTuningActive()).toBe(false);
  });

  it('should trigger execution timeout rejections if matrix runs exceed time limits', async () => {
    const eternalRunner = {
      runScenario: () => new Promise((resolve) => setTimeout(() => resolve({ passed: true, metrics: {} } as unknown as EvalScenarioResult), 10000)),
    } as unknown as EvaluationRunner;

    const tuner = new TuningRunner(eternalRunner, undefined, 50); // 50ms timeout limit
    await expect(tuner.runTuning([mockScenario('scen-1')], [{ semanticWeight: 0.5, lexicalWeight: 0.5, minSimilarity: 0.1, diversityThreshold: 0.7, maxConversationSnippets: 3 }], 'mock')).rejects.toThrow('Tuning execution timeout exceeded.');
  });

  it('should restrict developer route authorization boundaries to development environments', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = await POST({
      json: async () => ({ benchmarkMode: 'mock' }),
    } as unknown as NextRequest);
    const data = await response.json();
    expect(response.status).toBe(403);
    expect(data.error).toContain('only available in development environment');
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
    await tuner.runTuning([mockScenario('scen-1')], [{ semanticWeight: 0.1, lexicalWeight: 0.9, minSimilarity: 0.5, diversityThreshold: 0.9, maxConversationSnippets: 5 }], 'mock');

    expect(RETRIEVAL_SETTINGS.semanticWeight).toBe(originalWeights.semanticWeight);
    expect(RETRIEVAL_SETTINGS.lexicalWeight).toBe(originalWeights.lexicalWeight);
    expect(RETRIEVAL_SETTINGS.minSimilarity).toBe(originalWeights.minSimilarity);
    expect(RETRIEVAL_SETTINGS.diversityThreshold).toBe(originalWeights.diversityThreshold);
    expect(RETRIEVAL_SETTINGS.maxConversationSnippets).toBe(originalWeights.maxConversationSnippets);
  });

  it('should execute real mode successfully, reaching real database queries', async () => {
    const db = getDbPool();
    const querySpy = vi.spyOn(db, 'query');

    const tuner = new TuningRunner(undefined, undefined, 5000);
    const result = await tuner.runTuning(
      [mockScenario('scen-1')],
      [{ semanticWeight: 0.5, lexicalWeight: 0.5, minSimilarity: 0.1, diversityThreshold: 0.7, maxConversationSnippets: 2 }],
      'real'
    );

    expect(result.realPipelineExecuted).toBe(true);
    expect(querySpy).toHaveBeenCalled();

    // Verify insertion queries staged synthetic eval records
    const insertCalls = querySpy.mock.calls.filter(c => c[0].includes('INSERT INTO memories'));
    expect(insertCalls.length).toBeGreaterThan(0);
    expect(insertCalls[0][1]?.[1]).toBe('eval-user-sprint36-dedicated');
  });

  it('should fail closed in real mode if database query throws', async () => {
    const db = getDbPool();
    vi.spyOn(db, 'query').mockRejectedValue(new Error('PostgreSQL Connection Failure'));

    const tuner = new TuningRunner(undefined, undefined, 5000);
    await expect(tuner.runTuning(
      [mockScenario('scen-1')],
      [{ semanticWeight: 0.5, lexicalWeight: 0.5, minSimilarity: 0.1, diversityThreshold: 0.7, maxConversationSnippets: 2 }],
      'real'
    )).rejects.toThrow('PostgreSQL Connection Failure');
  });

  it('should reuse cached embeddings instead of invoking embedding provider repeatedly', async () => {
    const embeddingSpy = vi.spyOn(GeminiEmbeddingProvider.prototype, 'generateEmbedding');

    const tuner = new TuningRunner(undefined, undefined, 5000);
    // Ingest data for scenario containing same content twice
    const scenario = mockScenario('scen-cache');
    scenario.inputMemories.push({
      ...scenario.inputMemories[0],
      id: 'mem-dup',
    });

    await tuner.runTuning([scenario], [{ semanticWeight: 0.5, lexicalWeight: 0.5, minSimilarity: 0.1, diversityThreshold: 0.7, maxConversationSnippets: 2 }], 'real');

    // Due to embedding caching, generateEmbedding is called only once for the content "You prefer Matcha tea."
    const matchaCalls = embeddingSpy.mock.calls.filter(c => c[0] === 'You prefer Matcha tea.');
    expect(matchaCalls.length).toBe(1);
  });

  it('should clean up unique-run database entries properly, isolating cleanup to current evalRunId', async () => {
    const db = getDbPool();
    const querySpy = vi.spyOn(db, 'query');

    const tuner = new TuningRunner(undefined, undefined, 5000);
    await tuner.runTuning(
      [mockScenario('scen-1')],
      [{ semanticWeight: 0.5, lexicalWeight: 0.5, minSimilarity: 0.1, diversityThreshold: 0.7, maxConversationSnippets: 2 }],
      'real'
    );

    const deleteMemoriesCall = querySpy.mock.calls.find(c => c[0].includes('DELETE FROM memories'));
    expect(deleteMemoriesCall).toBeDefined();
    // Verify evalRunId parameter is passed to the deletion query
    expect(deleteMemoriesCall?.[1]?.[0]).toMatch(/^run-[a-z0-9]+$/);
  });
});
