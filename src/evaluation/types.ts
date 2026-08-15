import { Memory } from '@/core/types';

export interface EvalScenario {
  scenarioId: string;
  name: string;
  userId: string;
  query: string;
  inputMemories: Memory[];
  expectedRelevantIds: string[];
  expectedExcludedIds?: string[];
  maxTokens: number;
  isPersonal: boolean;
  expectedResponsePattern?: string; // Substring check for grounded responses
}

export interface EvalScenarioMetrics {
  retrievalRecall: number;
  contextPrecision: number;
  userIsolation: number;
  deduplicationRate: number;
  tokenCompliance: number;
  relevance: number;
  faithfulness: number;
  citationCorrectness: number;
  contextUtilization: number;
}

export interface EvalScenarioResult {
  scenarioId: string;
  name: string;
  passed: boolean;
  metrics: EvalScenarioMetrics;
  latencyMs: number;
  failureReason?: string;
  evaluation?: {
    relevance: number;
    faithfulness: number;
    citationCorrectness: number;
    contextUtilization: number;
  };
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  retrievalRecall: number;
  contextPrecision: number;
  isolationRate: number;
  deduplicationRate: number;
  tokenCompliance: number;
  relevance: number;
  faithfulness: number;
  citationCorrectness: number;
  contextUtilization: number;
  averageLatency: number;
}
