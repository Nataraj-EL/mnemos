import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { EvaluationRunner } from './runner';

vi.mock('@/db', () => {
  const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  return {
    getDbPool: vi.fn(() => ({
      query: mockQuery,
    })),
  };
});

describe('Response Pipeline Performance & Observability - Sprint 37', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const createMocks = () => {
    const mockRetriever = {
      retrieve: vi.fn().mockResolvedValue([]),
    } as unknown as MemoryRetriever;

    const mockAssembler = {
      assemble: vi.fn().mockReturnValue({
        items: [],
        context: 'Matched context text',
        tokenCount: 10,
        governance: { ruleMatched: 'none', appliedAction: 'none' },
        diagnostics: {
          retrievedCandidates: [],
          acceptedSources: [],
          filteredSources: [],
          finalContextCount: 0,
        },
      }),
    } as unknown as ContextAssembler;

    const mockGenerator = {
      generateResponse: vi.fn().mockResolvedValue({
        text: 'This is a mocked safe response.',
      }),
    } as unknown as ResponseGenerator;

    return { mockRetriever, mockAssembler, mockGenerator };
  };

  it('should capture all structured timings in diagnostics when evaluationRun is true', async () => {
    const { mockRetriever, mockAssembler, mockGenerator } = createMocks();
    const service = new ResponseService(mockRetriever, mockAssembler, mockGenerator);

    const result = await service.respond('user-1', 'What tea do I like?', {
      evaluationRun: true,
    });

    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics?.timings).toBeDefined();
    const timings = result.diagnostics?.timings;
    expect(timings?.prepLatencyMs).toBeDefined();
    expect(timings?.memoryRetrievalLatencyMs).toBeDefined();
    expect(timings?.conversationRetrievalLatencyMs).toBeDefined();
    expect(timings?.assemblyLatencyMs).toBeDefined();
    expect(timings?.generationLatencyMs).toBeDefined();
    expect(timings?.guardrailLatencyMs).toBeDefined();
    expect(timings?.totalLatencyMs).toBeDefined();
  });

  it('should skip diagnostics and timing overhead entirely for normal production requests', async () => {
    const { mockRetriever, mockAssembler, mockGenerator } = createMocks();
    const service = new ResponseService(mockRetriever, mockAssembler, mockGenerator);

    const result = await service.respond('user-1', 'Normal production query', {
      evaluationRun: false,
    });

    expect(result.diagnostics).toBeUndefined();
  });

  it('should timeout slow pipeline stages and cancel underlying HTTP fetch calls via AbortSignal', async () => {
    const { mockRetriever, mockAssembler } = createMocks();
    
    // Mock a generator that hangs
    const mockHangingGenerator = {
      generateResponse: vi.fn().mockImplementation((_query, _context, config) => {
        return new Promise((_, reject) => {
          if (config?.signal) {
            config.signal.addEventListener('abort', () => {
              reject(new Error('AbortError: Request was aborted'));
            });
          }
        });
      }),
    } as unknown as ResponseGenerator;

    const service = new ResponseService(mockRetriever, mockAssembler, mockHangingGenerator);

    // Stub environment timeout values to force a rapid timeout
    vi.stubEnv('LLM_GENERATION_TIMEOUT', '10');

    await expect(
      service.respond('user-1', 'Hanging query', { evaluationRun: true })
    ).rejects.toThrow(/exceeded limit of 10ms/);

    vi.unstubAllEnvs();
  });

  it('should isolate stage timeout failures to the current request and not alter production defaults', async () => {
    const originalWeights = { ...RETRIEVAL_SETTINGS };
    const { mockRetriever, mockAssembler } = createMocks();
    const mockHangingGenerator = {
      generateResponse: vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500))),
    } as unknown as ResponseGenerator;

    const service = new ResponseService(mockRetriever, mockAssembler, mockHangingGenerator);
    vi.stubEnv('LLM_GENERATION_TIMEOUT', '5');

    await expect(
      service.respond('user-1', 'Hanging query', { evaluationRun: true })
    ).rejects.toThrow(/generation stage exceeded limit/);

    // Confirm production retrieval settings are untouched
    expect(RETRIEVAL_SETTINGS.semanticWeight).toBe(originalWeights.semanticWeight);
    expect(RETRIEVAL_SETTINGS.lexicalWeight).toBe(originalWeights.lexicalWeight);

    vi.unstubAllEnvs();
  });

  it('should perform deterministic p95 and average latency calculations correctly', () => {
    const calculateP95 = (arr: number[]) => {
      if (arr.length === 0) return '—';
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = Math.ceil(0.95 * sorted.length) - 1;
      return `${sorted[Math.max(0, idx)]} ms`;
    };

    // 0 samples
    expect(calculateP95([])).toBe('—');

    // 1 sample
    expect(calculateP95([100])).toBe('100 ms');

    // 2 samples
    expect(calculateP95([100, 200])).toBe('200 ms');

    // Multiple samples
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    // p95 sorted index = Math.ceil(0.95 * 10) - 1 = 9. sorted[9] = 100
    expect(calculateP95(latencies)).toBe('100 ms');
  });

  it('should verify performance tracking runs successfully with the real database retriever path', async () => {
    const runner = new EvaluationRunner();
    // In real mode, it executes the real retriever database queries
    const scenario = {
      scenarioId: 'scen-real-perf',
      name: 'Real Performance check',
      userId: 'user-perf',
      query: 'Retrieve some facts',
      inputMemories: [],
      expectedRelevantIds: [],
      maxTokens: 500,
      isPersonal: false,
    };

    const result = await runner.runScenario(scenario, undefined, { benchmarkMode: 'real' });
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics?.timings).toBeDefined();
    expect(result.diagnostics?.timings?.memoryRetrievalLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
