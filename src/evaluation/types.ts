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

export interface ExperimentInsights {
  insufficientHistory: boolean;
  totalExperiments: number;
  controlWins: number;
  candidateWins: number;
  draws: number;
  bestConfig: TuningConfig | null;
  bestConfigSource: 'candidate' | 'control' | null;
  averageDeltas: Record<string, number>;
  improvingMetrics: string[];
  degradingMetrics: string[];
}

export interface PromotedConfigStatus {
  hasPromotedConfig: boolean;
  currentConfig: TuningConfig | null;
  previousConfig: TuningConfig | null;
}

export interface PromotionHistoryRecord {
  id: string;
  timestamp: string;
  action: 'promote' | 'rollback';
  previousConfig: TuningConfig | null;
  newConfig: TuningConfig | null;
}

export interface ConfigSafetyResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface QualityGateResult {
  status: 'pass' | 'warning' | 'block';
  reasons: string[];
  checkedMetrics: Record<string, string | number>;
  timestamp: string;
  insufficientHistory?: boolean;
  baselineAvailable?: boolean;
}

export interface EvaluationReport {
  timestamp: string;
  latestRunSummary: EvalSummary | null;
  qualityGate: QualityGateResult | null;
  baselineAvailable: boolean;
  regressionStatus: 'pass' | 'warning' | 'fail' | 'notComparable';
  healthMetrics: {
    timeoutCount?: number;
    retryRate?: number;
    fallbackRate?: number;
    cacheHitRate?: number;
    successRate?: number;
  } | null;
  trendSummary: {
    improving: string[];
    degrading: string[];
  } | null;
  promotedConfig: TuningConfig | null;
  recommendations: string[];
  experimentSummary: {
    recommendation?: 'control' | 'candidate' | 'draw';
    explanation?: string;
  } | null;
}

export interface EvaluationReportRecord {
  id: string;
  timestamp: string;
  report: EvaluationReport;
}

export interface ReportComparisonResult {
  baseReportId: string;
  targetReportId: string;
  statusChange: {
    base: string;
    target: string;
  };
  gateStatusChange: {
    base: string;
    target: string;
  };
  deltas: Record<string, { base: number | string; target: number | string; absolute?: number }>;
}

export interface HistoricalMetricTrend {
  delta?: number;
  type: 'improving' | 'stable' | 'degrading' | 'notComparable';
}

export interface EvaluationReportInsights {
  insufficientHistory: boolean;
  timestamp: string;
  latestReportId?: string;
  previousReportId?: string;
  status: 'improving' | 'stable' | 'degrading';
  trends: Record<string, HistoricalMetricTrend>;
  recurringDegradations: string[];
  gateHistorySummary: {
    total: number;
    passed: number;
    warned: number;
    blocked: number;
  };
}

export interface EvaluationAlert {
  id: string;
  metric?: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  currentValue?: string | number;
  delta?: number;
  timestamp: string;
}

export interface EvaluationAlertsSummary {
  alerts: EvaluationAlert[];
  timestamp: string;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
}

export type EvaluationAlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface EvaluationAlertRecord {
  id: string;
  alert: EvaluationAlert;
  status: EvaluationAlertStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationAlertHistorySummary {
  records: EvaluationAlertRecord[];
  timestamp: string;
  openCount: number;
  acknowledgedCount: number;
  resolvedCount: number;
}

export interface AlertCorrelation {
  alertId: string;
  metric?: string;
  likelyCause: 'configuration' | 'experiment' | 'evaluation' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  relatedRecordIds: string[];
}

export interface AlertCorrelationSummary {
  correlations: AlertCorrelation[];
  timestamp: string;
}

export interface EvaluationRemediation {
  alertId: string;
  priority: 'high' | 'medium' | 'low';
  action: string;
  reason: string;
  evidenceIds: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface EvaluationRemediationSummary {
  remediations: EvaluationRemediation[];
  timestamp: string;
}

export type RemediationProposalStatus = 'pending' | 'approved' | 'rejected' | 'executed';

export interface EvaluationRemediationProposal {
  id: string;
  remediationId: string;
  status: RemediationProposalStatus;
  proposedConfig: TuningConfig | null;
  rationale: string;
  evidenceIds: string[];
  confidence: 'high' | 'medium' | 'low';
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationRemediationProposalSummary {
  proposals: EvaluationRemediationProposal[];
  timestamp: string;
}
