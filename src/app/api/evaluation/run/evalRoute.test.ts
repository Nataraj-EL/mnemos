import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';

const mockRunAll = vi.fn();

vi.mock('@/evaluation/runner', () => {
  return {
    EvaluationRunner: vi.fn().mockImplementation(function () {
      return {
        runAll: mockRunAll,
      };
    }),
  };
});

describe('POST /api/evaluation/run API Route', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    mockRunAll.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: originalEnv,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  });

  it('should return 403 when NODE_ENV is not development', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'production',
      configurable: true,
      writable: true,
      enumerable: true,
    });
    const response = await POST();
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('Evaluation endpoint is only available in development environment.');
  });

  it('should return 200 and evaluation results when NODE_ENV is development', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'development',
      configurable: true,
      writable: true,
      enumerable: true,
    });
    const mockSummary = {
      total: 1,
      passed: 1,
      failed: 0,
      retrievalRecall: 1.0,
      contextPrecision: 1.0,
      isolationRate: 1.0,
      deduplicationRate: 1.0,
      tokenCompliance: 1.0,
      averageLatency: 50,
    };
    mockRunAll.mockResolvedValueOnce({
      results: [{ scenarioId: 's-1', name: 'Test', passed: true, metrics: {}, latencyMs: 50 }],
      summary: mockSummary,
    });

    const response = await POST();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.summary.passed).toBe(1);
    expect(data.results).toHaveLength(1);
  });
});
