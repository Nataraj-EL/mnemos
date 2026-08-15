export type MemoryType =
  | 'FACT'
  | 'PREFERENCE'
  | 'GOAL'
  | 'DECISION'
  | 'EVENT'
  | 'RELATIONSHIP';

export const MEMORY_TYPES: MemoryType[] = [
  'FACT',
  'PREFERENCE',
  'GOAL',
  'DECISION',
  'EVENT',
  'RELATIONSHIP',
];

export function isValidMemoryType(type: string): type is MemoryType {
  return MEMORY_TYPES.includes(type as MemoryType);
}

export interface MemoryMetadata {
  source: string;
  confidence: number;
  importance: number;
  timestamp: string;
  status?: 'active' | 'superseded';
  tags?: string[];
  validFrom?: string;
  validUntil?: string;
  supersededBy?: string;
  supersedes?: string;
  accessCount?: number;
  lastAccessedAt?: string;
  reinforcementCount?: number;
  lifecycleUpdatedAt?: string;
  consolidatedFrom?: string[];
  conversationId?: string;
  sourceType?: string;
  sourceTimestamp?: string;
  [key: string]: unknown;
}

export function normalizeMetadata(metadata?: Partial<MemoryMetadata>, createdAtFallback?: Date): MemoryMetadata {
  const timestamp = metadata?.timestamp || createdAtFallback?.toISOString() || new Date().toISOString();
  return {
    source: metadata?.source || 'chat',
    confidence: typeof metadata?.confidence === 'number' ? metadata.confidence : 0.9,
    importance: typeof metadata?.importance === 'number' ? metadata.importance : 5,
    timestamp,
    status: metadata?.status || 'active',
    tags: metadata?.tags || [],
    validFrom: metadata?.validFrom,
    validUntil: metadata?.validUntil,
    supersedes: metadata?.supersedes,
    supersededBy: metadata?.supersededBy,
    accessCount: typeof metadata?.accessCount === 'number' ? metadata.accessCount : 0,
    lastAccessedAt: typeof metadata?.lastAccessedAt === 'string' ? metadata.lastAccessedAt : timestamp,
    reinforcementCount: typeof metadata?.reinforcementCount === 'number' ? metadata.reinforcementCount : 0,
    lifecycleUpdatedAt: typeof metadata?.lifecycleUpdatedAt === 'string' ? metadata.lifecycleUpdatedAt : timestamp,
    consolidatedFrom: Array.isArray(metadata?.consolidatedFrom) ? (metadata.consolidatedFrom as string[]) : undefined,
    conversationId: metadata?.conversationId,
    sourceType: metadata?.sourceType,
    sourceTimestamp: metadata?.sourceTimestamp,
  };
}

export function deriveLifecycleState(memory: Memory, now: Date = new Date()): 'core' | 'stable' | 'fading' | 'historical' {
  const metadata = normalizeMetadata(memory.metadata, memory.createdAt);
  
  if (metadata.status === 'superseded' || metadata.validUntil) {
    return 'historical';
  }

  const lastAccessedStr = metadata.lastAccessedAt || metadata.timestamp;
  const lastAccessedDate = new Date(lastAccessedStr);
  const elapsedMs = Math.max(0, now.getTime() - lastAccessedDate.getTime());
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
  const decayFactor = 1 / (1 + elapsedDays / 90);

  const confidence = metadata.confidence;
  const importance = metadata.importance;
  const accessCount = metadata.accessCount || 0;

  if (importance >= 8 && confidence >= 0.8 && decayFactor >= 0.5) {
    return 'core';
  }

  if ((confidence >= 0.5 || accessCount >= 5) && decayFactor >= 0.5) {
    return 'stable';
  }

  return 'fading';
}

export interface User {
  id: string;
  email?: string;
  createdAt?: Date;
}

export interface Memory {
  id: string;
  userId: string;
  type: MemoryType;
  content: string;
  metadata: MemoryMetadata;
  embedding?: number[] | null;
  createdAt: Date;
  updatedAt: Date;
}
