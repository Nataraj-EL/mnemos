import { Memory, MemoryType } from '@/core/types';

export interface ContextRequest {
  userId: string;
  query: string;
  limit?: number;
  minConfidence?: number;
  types?: MemoryType[];
}

export interface ContextResult {
  memories: Memory[];
  relevanceScore?: number;
  extractedContext?: string;
}
