import { describe, it, expect } from 'vitest';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { Memory, MemoryType } from '@/core/types';
import { PgMemoryRepository } from '@/memory/repository';

const mockMemory = (
  id: string,
  userId: string,
  content: string,
  status?: 'active' | 'superseded',
  supersedes?: string,
  supersededBy?: string
): Memory => ({
  id,
  userId,
  type: 'PREFERENCE' as MemoryType,
  content,
  metadata: {
    source: 'chat',
    confidence: 0.9,
    importance: 8,
    timestamp: new Date().toISOString(),
    status,
    supersedes,
    supersededBy,
    validFrom: status === 'active' ? new Date().toISOString() : undefined,
    validUntil: status === 'superseded' ? new Date().toISOString() : undefined,
  },
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('Sprint 7 Temporal Memory & Conflict Resolution', () => {
  it('should maintain backward compatibility when status is missing', async () => {
    const memory = mockMemory('mem-1', 'user-1', 'Use PostgreSQL');
    delete memory.metadata.status; // status is missing

    const assembler = new ContextAssembler();
    // Default search (includeHistorical=false) should keep it because missing status = active
    const res = assembler.assemble('database', [{ memory, similarity: 0.9 }], 1000, false);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].id).toBe('mem-1');
    expect(res.items[0].status).toBe('active');
  });

  it('should exclude superseded memories from normal queries and prefix status tags', async () => {
    const active = mockMemory('mem-active', 'user-1', 'Currently use MongoDB', 'active');
    const superseded = mockMemory('mem-old', 'user-1', 'Use PostgreSQL', 'superseded');

    const assembler = new ContextAssembler();

    // Normal query path
    const normalRes = assembler.assemble(
      'database',
      [
        { memory: active, similarity: 0.9 },
        { memory: superseded, similarity: 0.8 },
      ],
      1000,
      false
    );
    expect(normalRes.items).toHaveLength(1);
    expect(normalRes.items[0].id).toBe('mem-active');
    expect(normalRes.context).toContain('[CURRENT] Currently use MongoDB');
    expect(normalRes.context).not.toContain('Use PostgreSQL');

    // Historical query path
    const historicalRes = assembler.assemble(
      'database',
      [
        { memory: active, similarity: 0.9 },
        { memory: superseded, similarity: 0.8 },
      ],
      1000,
      true
    );
    expect(historicalRes.items).toHaveLength(2);
    expect(historicalRes.context).toContain('[CURRENT] Currently use MongoDB');
    expect(historicalRes.context).toContain('[HISTORICAL] Use PostgreSQL');
  });

  it('should traverse and fetch ancestors in multiple generations: PostgreSQL -> MongoDB -> SQLite', async () => {
    // SQLite (active) -> MongoDB (superseded) -> PostgreSQL (superseded)
    const sqlLite = mockMemory('sqlite', 'user-1', 'Currently SQLite', 'active', 'mongodb');
    const mongo = mockMemory('mongodb', 'user-1', 'Use MongoDB', 'superseded', 'postgres', 'sqlite');
    const postgres = mockMemory(
      'postgres',
      'user-1',
      'Use PostgreSQL',
      'superseded',
      undefined,
      'mongodb'
    );

    const repoMock = {
      async get(id: string) {
        if (id === 'mongodb') return mongo;
        if (id === 'postgres') return postgres;
        return null;
      },
    } as unknown as PgMemoryRepository;

    const mockRetriever = {
      async retrieve() {
        return [{ memory: sqlLite, similarity: 0.9 }];
      },
    } as unknown as MemoryRetriever;

    const mockGenerator = {
      async generateResponse(_q: string, context: string) {
        return { text: `Generated using: ${context}` };
      },
    };

    const assembler = new ContextAssembler();
    const service = new ResponseService(mockRetriever, assembler, mockGenerator, repoMock);

    const res = await service.respond('user-1', 'What database did I use before?', {
      includeHistorical: true,
    });

    expect(res.response).toContain('Currently SQLite');
    expect(res.response).toContain('Use MongoDB');
    expect(res.response).toContain('Use PostgreSQL');
  });

  it('should terminate traversal at depth 10 to prevent long chains', async () => {
    // Create a chain of 15 memories: mem-15 -> mem-14 -> ... -> mem-0
    const memoriesMap = new Map<string, Memory>();
    for (let i = 0; i <= 15; i++) {
      const activeState = i === 15 ? ('active' as const) : ('superseded' as const);
      const parentId = i > 0 ? `mem-${i - 1}` : undefined;
      const childId = i < 15 ? `mem-${i + 1}` : undefined;
      memoriesMap.set(
        `mem-${i}`,
        mockMemory(`mem-${i}`, 'user-1', `Content ${i}`, activeState, parentId, childId)
      );
    }

    const repoMock = {
      async get(id: string) {
        return memoriesMap.get(id) || null;
      },
    } as unknown as PgMemoryRepository;

    const mockRetriever = {
      async retrieve() {
        return [{ memory: memoriesMap.get('mem-15')!, similarity: 0.9 }];
      },
    } as unknown as MemoryRetriever;

    const mockGenerator = {
      async generateResponse(_q: string, context: string) {
        return { text: context };
      },
    };

    const assembler = new ContextAssembler();
    const service = new ResponseService(mockRetriever, assembler, mockGenerator, repoMock);

    const res = await service.respond('user-1', 'history query', { includeHistorical: true, limit: 20 });

    // Depth limit is 10, meaning active + 10 ancestors = 11 memories total
    const lines = res.response.split('\n');
    expect(lines.length).toBeLessThanOrEqual(11);
    expect(res.response).toContain('Content 15');
    expect(res.response).toContain('Content 5');
    expect(res.response).not.toContain('Content 4'); // should not be reached (depth 11)
  });

  it('should prevent infinite loops with cycle detection', async () => {
    // Circle: mem-a -> mem-b -> mem-a
    const memA = mockMemory('mem-a', 'user-1', 'Content A', 'active', 'mem-b');
    const memB = mockMemory('mem-b', 'user-1', 'Content B', 'superseded', 'mem-a', 'mem-a');

    const repoMock = {
      async get(id: string) {
        if (id === 'mem-a') return memA;
        if (id === 'mem-b') return memB;
        return null;
      },
    } as unknown as PgMemoryRepository;

    const mockRetriever = {
      async retrieve() {
        return [{ memory: memA, similarity: 0.9 }];
      },
    } as unknown as MemoryRetriever;

    const mockGenerator = {
      async generateResponse(_q: string, context: string) {
        return { text: context };
      },
    };

    const assembler = new ContextAssembler();
    const service = new ResponseService(mockRetriever, assembler, mockGenerator, repoMock);

    // Call should resolve successfully without freezing or crashing due to cycles
    const res = await service.respond('user-1', 'history query', { includeHistorical: true });
    expect(res.response).toContain('Content A');
    expect(res.response).toContain('Content B');
  });

  it('should respect user isolation boundaries during traversal', async () => {
    const child = mockMemory('child', 'user-1', 'User 1 active memory', 'active', 'parent-bad');
    const crossUserParent = mockMemory('parent-bad', 'user-2', 'User 2 superseded memory', 'superseded');

    const repoMock = {
      async get(id: string) {
        if (id === 'parent-bad') return crossUserParent;
        return null;
      },
    } as unknown as PgMemoryRepository;

    const mockRetriever = {
      async retrieve() {
        return [{ memory: child, similarity: 0.9 }];
      },
    } as unknown as MemoryRetriever;

    const mockGenerator = {
      async generateResponse(_q: string, context: string) {
        return { text: context };
      },
    };

    const assembler = new ContextAssembler();
    const service = new ResponseService(mockRetriever, assembler, mockGenerator, repoMock);

    const res = await service.respond('user-1', 'history query', { includeHistorical: true });

    // Cross-user parent must NOT be loaded or printed
    expect(res.response).toContain('User 1 active memory');
    expect(res.response).not.toContain('User 2 superseded memory');
  });

  it('should automatically enable includeHistorical on obvious temporal heuristic keywords', async () => {
    const active = mockMemory('active', 'user-1', 'Currently MongoDB', 'active');
    const superseded = mockMemory('old', 'user-1', 'Previously Postgres', 'superseded');

    const mockRetriever = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async retrieve(_userId: string, _query: string, options?: any) {
        // Retrieve should be called with includeHistorical=true because query contains "before"
        expect(options.includeHistorical).toBe(true);
        return [
          { memory: active, similarity: 0.9 },
          { memory: superseded, similarity: 0.8 },
        ];
      },
    } as unknown as MemoryRetriever;

    const mockGenerator = {
      async generateResponse(_q: string, context: string) {
        return { text: context };
      },
    };

    const assembler = new ContextAssembler();
    const service = new ResponseService(mockRetriever, assembler, mockGenerator);

    const res = await service.respond('user-1', 'What database did I use before MongoDB?');
    expect(res.response).toContain('Previously Postgres');
  });

  it('should keep actual semantic similarity for direct historical matches', async () => {
    const historicalMemory = mockMemory('hist-1', 'user-1', 'Old fact', 'superseded');

    const assembler = new ContextAssembler();
    const res = assembler.assemble(
      'query',
      [{ memory: historicalMemory, similarity: 0.77 }],
      1000,
      true
    );

    expect(res.items[0].similarity).toBe(0.77); // actual semantic similarity is kept intact
  });
});
