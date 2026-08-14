import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryIngestionService } from './ingestionService';
import { Memory } from '@/core/types';

describe('MemoryIngestionService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRepo: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockExtractor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockEmbeddingProvider: any;
  let service: MemoryIngestionService;

  const mockMetadata = {
    source: 'chat',
    confidence: 0.9,
    importance: 5,
    timestamp: new Date().toISOString(),
    status: 'active' as const,
  };

  beforeEach(() => {
    mockRepo = {
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    };

    mockExtractor = {
      reconcile: vi.fn(),
    };

    mockEmbeddingProvider = {
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
    };

    service = new MemoryIngestionService(mockRepo, mockExtractor, mockEmbeddingProvider);
  });

  it('should successfully handle a CREATE action', async () => {
    mockRepo.list.mockResolvedValueOnce([]);
    mockExtractor.reconcile.mockResolvedValueOnce([
      {
        action: 'CREATE',
        type: 'FACT',
        content: 'User likes green tea',
        confidence: 0.9,
        importance: 4,
      },
    ]);

    const createdMemory = {
      id: 'uuid-new',
      userId: 'user-1',
      type: 'FACT',
      content: 'User likes green tea',
      metadata: {
        source: 'user_input',
        confidence: 0.9,
        importance: 4,
        timestamp: new Date().toISOString(),
        status: 'active',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockRepo.create.mockResolvedValueOnce(createdMemory);
    mockRepo.update.mockResolvedValueOnce({
      ...createdMemory,
      embedding: [0.1, 0.2],
    });

    const result = await service.ingest('user-1', 'I like green tea');

    expect(mockRepo.list).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(mockExtractor.reconcile).toHaveBeenCalled();
    expect(mockRepo.create).toHaveBeenCalledWith({
      userId: 'user-1',
      type: 'FACT',
      content: 'User likes green tea',
      metadata: {
        source: 'user_input',
        confidence: 0.9,
        importance: 4,
        timestamp: expect.any(String),
        status: 'active',
      },
    });
    expect(mockEmbeddingProvider.generateEmbedding).toHaveBeenCalledWith('User likes green tea');
    expect(mockRepo.update).toHaveBeenCalledWith('uuid-new', { embedding: [0.1, 0.2] });
    expect(result).toEqual([{ ...createdMemory, embedding: [0.1, 0.2] }]);
  });

  it('should successfully handle an UPDATE action with safety verification', async () => {
    const existingMemory: Memory = {
      id: 'mem-update-id',
      userId: 'user-1',
      type: 'PREFERENCE',
      content: 'User prefers Python',
      metadata: mockMetadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockRepo.list.mockResolvedValueOnce([existingMemory]);
    mockExtractor.reconcile.mockResolvedValueOnce([
      {
        action: 'UPDATE',
        id: 'mem-update-id',
        content: 'User prefers TypeScript',
        confidence: 0.95,
        importance: 6,
        type: 'PREFERENCE',
      },
    ]);

    mockRepo.get.mockResolvedValueOnce(existingMemory);

    const newMemory: Memory = {
      id: 'uuid-new',
      userId: 'user-1',
      type: 'PREFERENCE',
      content: 'User prefers TypeScript',
      metadata: {
        source: 'user_input',
        confidence: 0.95,
        importance: 6,
        timestamp: new Date().toISOString(),
        status: 'active',
        validFrom: new Date().toISOString(),
        supersedes: 'mem-update-id',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockRepo.create.mockResolvedValueOnce(newMemory);

    const supersededOldMemory = {
      ...existingMemory,
      metadata: {
        ...mockMetadata,
        status: 'superseded' as const,
        validUntil: new Date().toISOString(),
        supersededBy: 'uuid-new',
      },
    };

    mockRepo.update.mockResolvedValueOnce(supersededOldMemory); // First save call (marks old memory superseded)
    mockRepo.update.mockResolvedValueOnce({
      ...newMemory,
      embedding: [0.1, 0.2],
    }); // Second embedding save call (saves new memory embedding)

    const result = await service.ingest('user-1', 'I prefer TypeScript now');

    expect(mockRepo.get).toHaveBeenCalledWith('mem-update-id');
    expect(mockRepo.create).toHaveBeenCalledWith({
      userId: 'user-1',
      type: 'PREFERENCE',
      content: 'User prefers TypeScript',
      metadata: {
        source: 'user_input',
        confidence: 0.95,
        importance: 6,
        timestamp: expect.any(String),
        status: 'active',
        validFrom: expect.any(String),
        supersedes: 'mem-update-id',
      },
    });
    expect(mockRepo.update).toHaveBeenCalledWith('mem-update-id', {
      metadata: {
        ...mockMetadata,
        status: 'superseded',
        validUntil: expect.any(String),
        supersededBy: 'uuid-new',
        timestamp: expect.any(String),
      },
    });
    expect(mockEmbeddingProvider.generateEmbedding).toHaveBeenCalledWith('User prefers TypeScript');
    expect(result).toEqual([{ ...newMemory, embedding: [0.1, 0.2] }]);
  });

  it('should successfully soft-supersede a memory on DELETE action with safety verification', async () => {
    const existingMemory: Memory = {
      id: 'mem-delete-id',
      userId: 'user-1',
      type: 'GOAL',
      content: 'Learn COBOL',
      metadata: mockMetadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockRepo.list.mockResolvedValueOnce([existingMemory]);
    mockExtractor.reconcile.mockResolvedValueOnce([
      {
        action: 'DELETE',
        id: 'mem-delete-id',
      },
    ]);

    mockRepo.get.mockResolvedValueOnce(existingMemory);

    const deletedMemory = {
      ...existingMemory,
      embedding: undefined,
      metadata: {
        ...mockMetadata,
        status: 'superseded' as const,
        validUntil: new Date().toISOString(),
        supersededAt: new Date().toISOString(),
      },
    };
    mockRepo.update.mockResolvedValueOnce(deletedMemory);

    const result = await service.ingest('user-1', 'I no longer want to learn COBOL');

    expect(mockRepo.get).toHaveBeenCalledWith('mem-delete-id');
    expect(mockRepo.update).toHaveBeenCalledWith('mem-delete-id', {
      embedding: null,
      metadata: {
        ...mockMetadata,
        status: 'superseded',
        timestamp: expect.any(String),
        supersededAt: expect.any(String),
        validUntil: expect.any(String),
      },
    });
    expect(result).toEqual([deletedMemory]);
  });

  it('should reject UPDATE / DELETE if memory does not belong to the user', async () => {
    const foreignMemory: Memory = {
      id: 'mem-foreign-id',
      userId: 'attacker-user', // Different owner
      type: 'FACT',
      content: 'Secret facts',
      metadata: mockMetadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockRepo.list.mockResolvedValueOnce([]); // Empty local list for our user
    mockExtractor.reconcile.mockResolvedValueOnce([
      {
        action: 'UPDATE',
        id: 'mem-foreign-id',
        content: 'Malicious modification attempts',
      },
    ]);

    mockRepo.get.mockResolvedValueOnce(foreignMemory);

    const result = await service.ingest('user-1', 'Attempt to hijack');

    expect(mockRepo.get).toHaveBeenCalledWith('mem-foreign-id');
    expect(mockRepo.update).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('should reject UPDATE / DELETE if memory ID does not exist', async () => {
    mockRepo.list.mockResolvedValueOnce([]);
    mockExtractor.reconcile.mockResolvedValueOnce([
      {
        action: 'UPDATE',
        id: 'non-existent-id',
        content: 'Reconcile non-existent',
      },
    ]);

    mockRepo.get.mockResolvedValueOnce(null);

    const result = await service.ingest('user-1', 'Update nonexistent');

    expect(mockRepo.get).toHaveBeenCalledWith('non-existent-id');
    expect(mockRepo.update).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('should skip operation on NONE action', async () => {
    const existingMemory: Memory = {
      id: 'mem-none-id',
      userId: 'user-1',
      type: 'PREFERENCE',
      content: 'Likes dark mode',
      metadata: mockMetadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockRepo.list.mockResolvedValueOnce([existingMemory]);
    mockExtractor.reconcile.mockResolvedValueOnce([
      {
        action: 'NONE',
        id: 'mem-none-id',
      },
    ]);

    mockRepo.get.mockResolvedValueOnce(existingMemory);

    const result = await service.ingest('user-1', 'I still prefer dark mode');

    expect(mockRepo.update).not.toHaveBeenCalled();
    expect(mockRepo.create).not.toHaveBeenCalled();
    expect(result).toEqual([existingMemory]);
  });

  it('should propagate repository errors gracefully', async () => {
    mockRepo.list.mockRejectedValueOnce(new Error('Database breakdown'));

    await expect(service.ingest('user-1', 'Fail repo')).rejects.toThrow('Database breakdown');
  });

  it('should successfully ingest even if embedding generation fails (resilience check)', async () => {
    mockRepo.list.mockResolvedValueOnce([]);
    mockExtractor.reconcile.mockResolvedValueOnce([
      {
        action: 'CREATE',
        type: 'FACT',
        content: 'Resilient memory content',
        confidence: 0.8,
        importance: 5,
      },
    ]);

    const createdMemory = {
      id: 'uuid-new-resilient',
      userId: 'user-1',
      type: 'FACT',
      content: 'Resilient memory content',
      metadata: {
        source: 'user_input',
        confidence: 0.8,
        importance: 5,
        timestamp: new Date().toISOString(),
        status: 'active',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockRepo.create.mockResolvedValueOnce(createdMemory);
    // Mock generateEmbedding to fail
    mockEmbeddingProvider.generateEmbedding.mockRejectedValueOnce(new Error('Rate Limit exceeded'));

    const result = await service.ingest('user-1', 'Testing resilient database saves');

    expect(mockRepo.create).toHaveBeenCalled();
    expect(mockEmbeddingProvider.generateEmbedding).toHaveBeenCalled();
    // Repository update to store embedding should NOT have been called due to error
    expect(mockRepo.update).not.toHaveBeenCalled();
    // Ingestion succeeds and returns the base memory without embedding
    expect(result).toEqual([createdMemory]);
  });
});
