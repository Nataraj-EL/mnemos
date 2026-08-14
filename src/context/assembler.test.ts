import { describe, it, expect, beforeEach } from 'vitest';
import { ContextAssembler, getJaccardSimilarity, estimateTokens } from './assembler';

describe('ContextAssembler Heuristics', () => {
  it('should correctly estimate tokens (1 token per 4 characters)', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });

  it('should calculate correct Jaccard similarity', () => {
    expect(getJaccardSimilarity('hello world', 'hello world')).toBe(1.0);
    expect(getJaccardSimilarity('hello world', 'world hello')).toBe(1.0);
    expect(getJaccardSimilarity('apple orange', 'apple orange banana')).toBe(2 / 3);
    expect(getJaccardSimilarity('apple!', 'apple?')).toBe(1.0); // punctuation removed
  });
});

describe('ContextAssembler', () => {
  let assembler: ContextAssembler;

  beforeEach(() => {
    assembler = new ContextAssembler();
  });

  it('should rank, deduplicate, filter, and assemble memories under a token budget', () => {
    const nowStr = new Date().toISOString();
    const sixtyDaysAgoStr = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

    const retrieved = [
      {
        memory: {
          id: 'mem-1',
          userId: 'user-1',
          type: 'PREFERENCE' as const,
          content: 'User prefers PostgreSQL for their projects',
          metadata: {
            source: 'chat',
            status: 'active' as const,
            confidence: 0.9,
            importance: 9,
            timestamp: nowStr,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        similarity: 0.9,
      },
      {
        // Near-duplicate of mem-1 (Jaccard similarity > 0.70)
        memory: {
          id: 'mem-2',
          userId: 'user-1',
          type: 'PREFERENCE' as const,
          content: 'User prefers PostgreSQL',
          metadata: {
            source: 'chat',
            status: 'active' as const,
            confidence: 0.9,
            importance: 8,
            timestamp: nowStr,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        similarity: 0.88,
      },
      {
        // Older memory, decayed recency
        memory: {
          id: 'mem-3',
          userId: 'user-1',
          type: 'FACT' as const,
          content: 'User completed their Python course',
          metadata: {
            source: 'chat',
            status: 'active' as const,
            confidence: 0.8,
            importance: 5,
            timestamp: sixtyDaysAgoStr,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        similarity: 0.7,
      },
    ];

    const result = assembler.assemble('database choices', retrieved, 500);

    // Assert duplicates are removed: mem-2 is duplicate of mem-1. Only mem-1 and mem-3 should remain.
    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe('mem-1');
    expect(result.items[1].id).toBe('mem-3');

    // Assert deterministic scores are calculated and sorted
    expect(result.items[0].score).toBeGreaterThan(result.items[1].score);

    // Verify traceability of parameters is preserved
    expect(result.items[0].id).toBe('mem-1');
    expect(result.items[0].type).toBe('PREFERENCE');
    expect(result.items[0].similarity).toBe(0.9);
    expect(result.items[0].importance).toBe(9);

    // Verify context text compiles
    expect(result.context).toContain('[PREFERENCE] User prefers PostgreSQL for their projects');
    expect(result.context).toContain('[FACT] User completed their Python course');
    expect(result.tokenCount).toBe(estimateTokens(result.context));
  });

  it('should defensively exclude superseded memories', () => {
    const retrieved = [
      {
        memory: {
          id: 'mem-1',
          userId: 'user-1',
          type: 'FACT' as const,
          content: 'This memory is active',
          metadata: {
            source: 'chat',
            status: 'active' as const,
            confidence: 0.9,
            importance: 5,
            timestamp: new Date().toISOString(),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        similarity: 0.85,
      },
      {
        memory: {
          id: 'mem-2',
          userId: 'user-1',
          type: 'FACT' as const,
          content: 'This memory is superseded',
          metadata: {
            source: 'chat',
            status: 'superseded' as const,
            confidence: 0.9,
            importance: 5,
            timestamp: new Date().toISOString(),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        similarity: 0.9,
      },
    ];

    const result = assembler.assemble('query', retrieved, 1000);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('mem-1');
  });

  it('should enforce token budget and drop items that exceed the limit', () => {
    const retrieved = [
      {
        memory: {
          id: 'mem-1',
          userId: 'user-1',
          type: 'FACT' as const,
          content: 'First item content is quite long',
          metadata: {
            source: 'chat',
            status: 'active' as const,
            confidence: 0.9,
            importance: 8,
            timestamp: new Date().toISOString(),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        similarity: 0.9,
      },
      {
        memory: {
          id: 'mem-2',
          userId: 'user-1',
          type: 'FACT' as const,
          content: 'Second item content is also long',
          metadata: {
            source: 'chat',
            status: 'active' as const,
            confidence: 0.9,
            importance: 8,
            timestamp: new Date().toISOString(),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        similarity: 0.85,
      },
    ];

    // Total characters for line 1 is "[FACT] First item content is quite long" (39 chars -> 10 tokens)
    // Max tokens set to 12. Line 1 fits. Line 2 adds 40 chars, exceeding 12 tokens. So only line 1 is selected.
    const result = assembler.assemble('query', retrieved, 12);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('mem-1');
  });

  it('should return empty context if first item exceeds token budget', () => {
    const retrieved = [
      {
        memory: {
          id: 'mem-1',
          userId: 'user-1',
          type: 'FACT' as const,
          content: 'First item is quite large',
          metadata: {
            source: 'chat',
            status: 'active' as const,
            confidence: 0.9,
            importance: 8,
            timestamp: new Date().toISOString(),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        similarity: 0.9,
      },
    ];

    // First line is 31 characters -> 8 tokens. Budget is 3. Exceeds budget. Returns empty.
    const result = assembler.assemble('query', retrieved, 3);
    expect(result.items).toHaveLength(0);
    expect(result.context).toBe('');
    expect(result.tokenCount).toBe(0);
  });
});
