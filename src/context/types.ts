import { MemoryType } from '@/core/types';

export interface ContextItem {
  id: string;
  type: MemoryType;
  content: string;
  similarity: number;
  importance: number;
  score: number;
  reason: string;
}

export interface ContextRequest {
  userId: string;
  query: string;
  limit?: number;
  maxTokens?: number;
}

export interface ContextResult {
  query: string;
  items: ContextItem[];
  context: string;
  tokenCount: number;
}
