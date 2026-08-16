import { MemoryType } from '@/core/types';

export interface ContextItem {
  id: string;
  type: MemoryType;
  content: string;
  similarity: number;
  importance: number;
  score: number;
  reason: string;
  status?: 'active' | 'superseded';
  governanceDecision?: 'ALLOW' | 'DOWNRANK' | 'EXCLUDE';
  governanceReasons?: string[];
  confidence?: number;
  lifecycleState?: 'core' | 'stable' | 'fading' | 'historical';
  conversationId?: string;
  sourceType?: string;
  sourceTimestamp?: string;
  createdAt?: Date;
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
  governance?: {
    allowedCount: number;
    downrankedCount: number;
    excludedCount: number;
    conflictsDetectedCount: number;
    lowConfidenceCount: number;
    injectionBlockedCount: number;
    details: Record<string, {
      decision: 'ALLOW' | 'DOWNRANK' | 'EXCLUDE';
      reasons: string[];
    }>;
  };
  diagnostics?: {
    retrievedCandidates: { id: string; content: string; similarity: number }[];
    acceptedSources: { id: string; content: string }[];
    filteredSources: { id: string; content: string; reason: string }[];
    finalContextCount: number;
  };
}
