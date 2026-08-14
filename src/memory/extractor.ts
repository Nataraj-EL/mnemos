import { Memory, MemoryType } from '@/core/types';

export interface ExtractedAction {
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'NONE';
  id?: string; // ID of the existing memory to UPDATE/DELETE/NONE
  type?: MemoryType;
  content?: string;
  confidence?: number;
  importance?: number;
}

export interface MemoryExtractor {
  reconcile(text: string, candidates: Memory[]): Promise<ExtractedAction[]>;
}
