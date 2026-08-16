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
  diagnostics?: {
    retrievedCandidates: { id: string; content: string; similarity: number }[];
    acceptedSources: { id: string; content: string }[];
    filteredSources: { id: string; content: string; reason: string }[];
    finalContextCount: number;
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

export interface TuningConfig {
  semanticWeight: number;
  lexicalWeight: number;
  minSimilarity: number;
  diversityThreshold: number;
  maxConversationSnippets: number;
}

export interface TuningResult {
  config: TuningConfig;
  passedCount: number;
  failedCount: number;
  averageMetrics: EvalScenarioMetrics;
  overallBenchmarkScore: number;
}

export interface TuningBenchmarkSummary {
  matrixResults: TuningResult[];
  bestConfig: TuningConfig;
  recommendationExplanation: string;
  realPipelineExecuted: boolean;
}

