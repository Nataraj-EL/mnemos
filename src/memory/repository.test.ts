import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgMemoryRepository } from './repository';
import { getDbPool } from '@/db';

// Mock the db module
vi.mock('@/db', () => {
  const mockQuery = vi.fn();
  return {
    getDbPool: vi.fn(() => ({
      query: mockQuery,
    })),
  };
});

describe('PgMemoryRepository', () => {
  let repository: PgMemoryRepository;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockQuery: any;

  beforeEach(() => {
    repository = new PgMemoryRepository();
    mockQuery = getDbPool().query;
    mockQuery.mockReset();
  });

  it('should successfully create a memory', async () => {
    const mockMemory = {
      id: 'uuid-1',
      userId: 'user-1',
      type: 'FACT' as const,
      content: 'Likes coffee',
      metadata: { source: 'chat' },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockQuery.mockResolvedValueOnce({
      rows: [mockMemory],
    });

    const result = await repository.create({
      userId: 'user-1',
      type: 'FACT',
      content: 'Likes coffee',
      metadata: { source: 'chat' },
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result).toEqual(mockMemory);
  });

  it('should get a memory by ID', async () => {
    const mockMemory = {
      id: 'uuid-1',
      userId: 'user-1',
      type: 'PREFERENCE' as const,
      content: 'Dark mode',
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockQuery.mockResolvedValueOnce({
      rows: [mockMemory],
    });

    const result = await repository.get('uuid-1');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result).toEqual(mockMemory);
  });

  it('should return null if memory not found', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [],
    });

    const result = await repository.get('non-existent');

    expect(result).toBeNull();
  });

  it('should update a memory by ID with dynamic SQL generator', async () => {
    const mockMemory = {
      id: 'uuid-1',
      userId: 'user-1',
      type: 'FACT' as const,
      content: 'Likes espresso',
      metadata: { source: 'chat' },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockQuery.mockResolvedValueOnce({
      rows: [mockMemory],
    });

    const result = await repository.update('uuid-1', {
      content: 'Likes espresso',
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result).toEqual(mockMemory);
  });

  it('should delete a memory by ID', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
    });

    const result = await repository.delete('uuid-1');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('should return false if deleting non-existent memory', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 0,
    });

    const result = await repository.delete('uuid-2');

    expect(result).toBe(false);
  });

  it('should list memories with filters', async () => {
    const mockMemories = [
      { id: '1', userId: 'user-1', type: 'GOAL', content: 'Learn Next.js', metadata: {} },
    ];

    mockQuery.mockResolvedValueOnce({
      rows: mockMemories,
    });

    const result = await repository.list({ userId: 'user-1', type: 'GOAL' });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result).toEqual(mockMemories);
  });
});
