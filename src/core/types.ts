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
  [key: string]: unknown;
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
