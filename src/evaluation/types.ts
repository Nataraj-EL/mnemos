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
    timings?: {
      prepLatencyMs: number;
      memoryRetrievalLatencyMs: number;
      conversationRetrievalLatencyMs: number;
      assemblyLatencyMs: number;
      generationLatencyMs: number;
      guardrailLatencyMs: number;
      totalLatencyMs: number;
    };
    cache?: {
      memoryRetrievalHit: boolean;
      conversationRetrievalHit: boolean;
    };
    resilience?: {
      retryCount: number;
      finalOutcome: 'success' | 'failure';
      failureCategory?: string;
    };
    health?: {
      memoryRetrievalSuccess?: boolean;
      conversationRetrievalSuccess?: boolean;
      memoryCacheHit?: boolean;
      conversationCacheHit?: boolean;
      memoryFallbackUsed?: boolean;
      conversationFallbackUsed?: boolean;
      retryOccurred: boolean;
      timeoutOccurred: boolean;
      latencyAvailable: boolean;
    };
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
  // health rates
  successRate?: number;
  cacheHitRate?: number;
  fallbackRate?: number;
  retryRate?: number;
  timeoutCount?: number;
  regression?: import('./regression').RegressionSummary;
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

export interface EvaluationRunRecord {
  id: string;
  timestamp: string;
  summary: EvalSummary;
}

export interface EvaluationRecommendation {
  id: string;
  metric: string;
  value: string;
  severity: 'info' | 'warning' | 'critical';
  action: string;
  trend?: string;
}

export interface EvaluationRecommendationsSummary {
  recommendations: EvaluationRecommendation[];
}

export interface ExperimentResult {
  controlConfig: TuningConfig;
  candidateConfig: TuningConfig;
  controlSummary: EvalSummary;
  candidateSummary: EvalSummary;
  comparison: import('./regression').RegressionSummary;
  recommendation: 'control' | 'candidate' | 'draw';
  recommendationExplanation: string;
}

export interface ExperimentRunRecord {
  id: string;
  timestamp: string;
  controlConfig: TuningConfig;
  candidateConfig: TuningConfig;
  controlSummary: EvalSummary;
  candidateSummary: EvalSummary;
  comparison: import('./regression').RegressionSummary;
  recommendation: 'control' | 'candidate' | 'draw';
  recommendationExplanation: string;
}
