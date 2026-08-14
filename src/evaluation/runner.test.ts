import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvaluationRunner } from './runner';
import { EvalScenario } from './types';
import { logTelemetry } from '@/core/logger';
import { Memory } from '@/core/types';

describe('EvaluationRunner Metrics & Grounding', () => {
  let runner: EvaluationRunner;

  beforeEach(() => {
    runner = new EvaluationRunner();
  });

  const mockMemory = (
    id: string,
    userId: string,
    content: string,
    status: 'active' | 'superseded' = 'active'
  ): Memory => ({
    id,
    userId,
    type: 'FACT' as const,
    content,
    metadata: {
      source: 'chat',
      confidence: 0.9,
      importance: 8,
      timestamp: new Date().toISOString(),
      status,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it('should compute 1.0 recall and precision on perfect matching scenario', async () => {
    const scenario: EvalScenario = {
      scenarioId: 'scen-test-1',
      name: 'Perfect Recall & Precision',
      userId: 'user-1',
      query: 'Query matching mem-1',
      inputMemories: [mockMemory('mem-1', 'user-1', 'Fact content one')],
      expectedRelevantIds: ['mem-1'],
      maxTokens: 1000,
      isPersonal: true,
    };

    const res = await runner.runScenario(scenario);
    expect(res.passed).toBe(true);
    expect(res.metrics.retrievalRecall).toBe(1.0);
    expect(res.metrics.contextPrecision).toBe(1.0);
    expect(res.metrics.userIsolation).toBe(1.0);
    expect(res.metrics.deduplicationRate).toBe(1.0);
    expect(res.metrics.tokenCompliance).toBe(1.0);
  });

  it('should compute 0.0 recall when expected memory is missing from retrieval', async () => {
    const scenario: EvalScenario = {
      scenarioId: 'scen-test-2',
      name: 'Missing Memory Recall',
      userId: 'user-1',
      query: 'Query',
      inputMemories: [], // empty retrieved pool
      expectedRelevantIds: ['mem-1'],
      maxTokens: 1000,
      isPersonal: true,
    };

    const res = await runner.runScenario(scenario);
    expect(res.passed).toBe(false);
    expect(res.metrics.retrievalRecall).toBe(0.0);
  });

  it('should compute 1.0 userIsolation when cross-user memory is retrieved or selected', async () => {
    const scenario: EvalScenario = {
      scenarioId: 'scen-test-3',
      name: 'Isolation verification',
      userId: 'user-1',
      query: 'Query',
      inputMemories: [
        mockMemory('mem-1', 'user-1', 'User 1 memory'),
        mockMemory('mem-2', 'user-2', 'User 2 memory'), // cross-user
      ],
      expectedRelevantIds: ['mem-1', 'mem-2'],
      maxTokens: 1000,
      isPersonal: true,
    };

    // Runner mock db retriever filters out user-2's memory. Isolation is preserved.
    const res = await runner.runScenario(scenario);
    expect(res.metrics.userIsolation).toBe(1.0);
    expect(res.metrics.retrievalRecall).toBe(0.5); // Recall is 0.5 because mem-2 was ignored
  });

  it('should compute 1.0 deduplicationRate if duplicates are correctly excluded', async () => {
    const scenario: EvalScenario = {
      scenarioId: 'scen-test-4',
      name: 'Deduplication success',
      userId: 'user-1',
      query: 'Query',
      inputMemories: [
        mockMemory('mem-4a', 'user-1', 'Relational database Postgres'),
        mockMemory('mem-4b', 'user-1', 'Postgres relational database'), // duplicate
      ],
      expectedRelevantIds: ['mem-4a'],
      expectedExcludedIds: ['mem-4b'],
      maxTokens: 1000,
      isPersonal: true,
    };

    const res = await runner.runScenario(scenario);
    expect(res.metrics.deduplicationRate).toBe(1.0);
  });

  it('should mock provider failures correctly', async () => {
    const scenario: EvalScenario = {
      scenarioId: 'scen-test-5',
      name: 'Generator error',
      userId: 'user-1',
      query: 'Query',
      inputMemories: [mockMemory('mem-1', 'user-1', 'Content')],
      expectedRelevantIds: ['mem-1'],
      maxTokens: 1000,
      isPersonal: true,
    };

    const failingGenerator = {
      async generateResponse() {
        throw new Error('Gemini API quota exceeded');
      },
    };

    const failingRunner = new EvaluationRunner(undefined, failingGenerator);
    const res = await failingRunner.runScenario(scenario);
    expect(res.passed).toBe(false);
    expect(res.failureReason).toContain('Gemini API quota exceeded');
  });

  it('should print the full benchmark result', async () => {
    const report = await runner.runAll();
    console.log('BENCHMARK_REPORT_START');
    console.log(JSON.stringify(report, null, 2));
    console.log('BENCHMARK_REPORT_END');
  });
});

describe('Telemetry Logging Privacy Redaction', () => {
  it('should print structured JSON output and exclude sensitive queries or content', () => {
    const consoleSpy = vi.spyOn(console, 'log');

    logTelemetry({
      correlationId: 'uuid-1234',
      retrievalLatencyMs: 15,
      candidateCount: 5,
      selectedCount: 2,
      estimatedContextTokens: 45,
      generationLatencyMs: 150,
      totalLatencyMs: 165,
      model: 'gemini-3.5-flash',
      status: 'success',
    });

    expect(consoleSpy).toHaveBeenCalled();
    const printedString = consoleSpy.mock.calls[0][0];
    const logPayload = JSON.parse(printedString);

    expect(logPayload.correlationId).toBe('uuid-1234');
    expect(logPayload.retrievalLatencyMs).toBe(15);
    expect(logPayload.estimatedContextTokens).toBe(45);
    expect(logPayload.status).toBe('success');

    // Telemetry privacy tests: verify sensitive fields are redacted
    expect(logPayload.query).toBeUndefined();
    expect(logPayload.prompt).toBeUndefined();
    expect(logPayload.context).toBeUndefined();
    expect(logPayload.response).toBeUndefined();
    expect(logPayload.content).toBeUndefined();

    consoleSpy.mockRestore();
  });
});
