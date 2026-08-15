import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgConversationRepository } from './repository';
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

describe('PgConversationRepository', () => {
  let repository: PgConversationRepository;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockQuery: any;

  beforeEach(() => {
    repository = new PgConversationRepository();
    mockQuery = getDbPool().query;
    mockQuery.mockReset();
  });

  it('should successfully create a conversation record', async () => {
    const mockConv = {
      id: 'uuid-conv-1',
      userId: 'user-1',
      startedAt: new Date(),
      endedAt: new Date(),
      durationSeconds: 15,
      transcript: 'Hello this is test',
      createdAt: new Date(),
    };

    mockQuery.mockResolvedValueOnce({
      rows: [mockConv],
    });

    const result = await repository.create({
      userId: 'user-1',
      startedAt: mockConv.startedAt,
      endedAt: mockConv.endedAt,
      durationSeconds: mockConv.durationSeconds,
      transcript: mockConv.transcript,
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result).toEqual(mockConv);
  });

  it('should get a conversation by ID', async () => {
    const mockConv = {
      id: 'uuid-conv-1',
      userId: 'user-1',
      startedAt: new Date(),
      endedAt: new Date(),
      durationSeconds: 15,
      transcript: 'Hello this is test',
      createdAt: new Date(),
    };

    mockQuery.mockResolvedValueOnce({
      rows: [mockConv],
    });

    const result = await repository.getById('uuid-conv-1');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result).toEqual(mockConv);
  });

  it('should return null if conversation is not found', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [],
    });

    const result = await repository.getById('non-existent-uuid');
    expect(result).toBeNull();
  });

  it('should list conversations by user with limit', async () => {
    const mockConvs = [
      {
        id: 'uuid-conv-1',
        userId: 'user-1',
        startedAt: new Date(),
        endedAt: new Date(),
        durationSeconds: 10,
        transcript: 'Hello first',
        createdAt: new Date(),
      },
    ];

    mockQuery.mockResolvedValueOnce({
      rows: mockConvs,
    });

    const result = await repository.listByUser('user-1', 10);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result).toEqual(mockConvs);
  });

  it('should delete a conversation record', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
    });

    const result = await repository.delete('uuid-conv-1');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('should return false if deleting non-existent conversation', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 0,
    });

    const result = await repository.delete('uuid-conv-2');
    expect(result).toBe(false);
  });
});
