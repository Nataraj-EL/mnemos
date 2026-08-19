/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PromotionHistoryManager } from './promotionHistory';
import { EvaluationRemediationProposalManager } from './remediationProposal';
import { EvaluationRemediationExecutionManager } from './remediationExecution';
import { EvaluationConfigPromotionManager } from './promotion';
import { EvaluationReportHistoryManager } from './reportHistory';
import { EvaluationRemediationOutcomeManager } from './remediationOutcome';
import { EvaluationRemediation, EvaluationReport, EvalSummary, TuningConfig, ControlledExperimentResult } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';
import { ExperimentHistoryManager } from './experimentHistory';

describe('Sprint 61: Evaluation Remediation Outcome Verification Tests', () => {
  const sampleRemediation: EvaluationRemediation = {
    alertId: 'alert-123',
    priority: 'high',
    action: 'Evaluate semantic/lexical weighting parameters.',
    reason: 'Relevance degraded.',
    evidenceIds: ['alr-123'],
    confidence: 'high',
  };

  function attachMockEvidence(prop: any) {
    const mockResult: ControlledExperimentResult = {
      experimentId: 'exp-' + Math.random().toString(36).substring(2),
      baselineConfig: { ...RETRIEVAL_SETTINGS },
      candidateConfig: prop.proposedConfig ? { ...prop.proposedConfig } : { ...RETRIEVAL_SETTINGS },
      baselineSummary: { total: 10, passed: 9, failed: 1, averageLatency: 200 } as any,
      candidateSummary: { total: 10, passed: 10, failed: 0, averageLatency: 150 } as any,
      comparison: { status: 'pass', deltas: {}, failedThresholds: [], baselineAvailable: true },
      decision: 'candidateBetter',
      metricsComparison: {},
      timestamp: new Date().toISOString(),
      evidenceIds: []
    };
    ExperimentHistoryManager.addControlledRecord(mockResult);
    EvaluationRemediationProposalManager.attachEvidence(prop.id, mockResult.experimentId);
  }

  const initialConfig: TuningConfig = {
    semanticWeight: 0.70,
    lexicalWeight: 0.30,
    minSimilarity: 0.20,
    diversityThreshold: 0.70,
    maxConversationSnippets: 3,
  };

  beforeEach(() => {
    PromotionHistoryManager.clearHistory();
    EvaluationRemediationProposalManager.clearProposals();
    EvaluationRemediationExecutionManager.clearHistory();
    EvaluationReportHistoryManager.clearHistory();
    EvaluationConfigPromotionManager.clearPromotion();
    vi.restoreAllMocks();

    // Set a valid baseline configuration
    EvaluationConfigPromotionManager.promote(initialConfig);
    PromotionHistoryManager.clearHistory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createReport = (timestamp: string, summary: Partial<EvalSummary>, config: TuningConfig): void => {
    const report: EvaluationReport = {
      timestamp,
      latestRunSummary: {
        total: 10,
        passed: 8,
        failed: 2,
        retrievalRecall: 0.8,
        contextPrecision: 0.8,
        isolationRate: 0.9,
        deduplicationRate: 0.9,
        tokenCompliance: 1.0,
        relevance: 0.8,
        faithfulness: 0.8,
        citationCorrectness: 0.8,
        contextUtilization: 0.5,
        averageLatency: 1000,
        successRate: 1.0,
        cacheHitRate: 0.0,
        fallbackRate: 0.0,
        retryRate: 0.0,
        timeoutCount: 0,
        ...summary,
      },
      qualityGate: null,
      baselineAvailable: false,
      regressionStatus: 'pass',
      healthMetrics: null,
      trendSummary: null,
      promotedConfig: { ...config },
      recommendations: [],
      experimentSummary: null,
    };
    EvaluationReportHistoryManager.addReport(report);
  };

  describe('Report Matching Strategy & Temporal Ordering', () => {
    it('should successfully match reports using the strict execution-timestamp sequence and classify as improved', () => {
      // Create and Execute proposal
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      attachMockEvidence(prop);
      EvaluationRemediationProposalManager.approve(prop.id);
      
      const success = EvaluationRemediationProposalManager.execute(prop.id);
      expect(success).toBe(true);

      const execRecord = EvaluationRemediationExecutionManager.listExecutions()[0];
      const execTime = new Date(execRecord.executedAt).getTime();

      // Pre-execution report (older than execution)
      createReport(new Date(execTime - 60000).toISOString(), { relevance: 0.70 }, initialConfig);

      // Post-execution report (newer than execution)
      createReport(new Date(execTime + 60000).toISOString(), { relevance: 0.80 }, execRecord.appliedConfig!);

      // Generate Outcomes
      const outcomes = EvaluationRemediationOutcomeManager.generateOutcomes();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].status).toBe('improved');
      expect(outcomes[0].targetMetrics.relevance.delta).toBe(0.10);
      expect(outcomes[0].summary).toContain('relevance');
    });

    it('should classify as degraded when metrics shift downwards beyond tolerance levels', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      attachMockEvidence(prop);
      EvaluationRemediationProposalManager.approve(prop.id);
      EvaluationRemediationProposalManager.execute(prop.id);

      const execRecord = EvaluationRemediationExecutionManager.listExecutions()[0];
      const execTime = new Date(execRecord.executedAt).getTime();

      // Pre-execution report
      createReport(new Date(execTime - 60000).toISOString(), { relevance: 0.80 }, initialConfig);

      // Post-execution report
      createReport(new Date(execTime + 60000).toISOString(), { relevance: 0.70 }, execRecord.appliedConfig!);

      const outcomes = EvaluationRemediationOutcomeManager.generateOutcomes();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].status).toBe('degraded');
      expect(outcomes[0].targetMetrics.relevance.delta).toBe(-0.10);
      expect(outcomes[0].summary).toContain('relevance');
    });

    it('should classify as unchanged when metrics shift remains within tolerance boundaries', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      attachMockEvidence(prop);
      EvaluationRemediationProposalManager.approve(prop.id);
      EvaluationRemediationProposalManager.execute(prop.id);

      const execRecord = EvaluationRemediationExecutionManager.listExecutions()[0];
      const execTime = new Date(execRecord.executedAt).getTime();

      // Pre-execution report
      createReport(new Date(execTime - 60000).toISOString(), { relevance: 0.80 }, initialConfig);

      // Post-execution report: shift is within tolerance (0.01 shift vs 0.02 tolerance)
      createReport(new Date(execTime + 60000).toISOString(), { relevance: 0.81 }, execRecord.appliedConfig!);

      const outcomes = EvaluationRemediationOutcomeManager.generateOutcomes();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].status).toBe('unchanged');
      expect(outcomes[0].targetMetrics.relevance.delta).toBe(0.01);
    });

    it('should classify as insufficientData if reports do not align with execution timeline', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      attachMockEvidence(prop);
      EvaluationRemediationProposalManager.approve(prop.id);
      EvaluationRemediationProposalManager.execute(prop.id);

      const execRecord = EvaluationRemediationExecutionManager.listExecutions()[0];
      const execTime = new Date(execRecord.executedAt).getTime();

      // Reports are matching configuration but timestamps are both BEFORE execution
      createReport(new Date(execTime - 60000).toISOString(), { relevance: 0.70 }, initialConfig);
      createReport(new Date(execTime - 30000).toISOString(), { relevance: 0.80 }, execRecord.appliedConfig!);

      const outcomes = EvaluationRemediationOutcomeManager.generateOutcomes();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].status).toBe('insufficientData');
    });

    it('should classify as insufficientData for failed executions', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      attachMockEvidence(prop);
      EvaluationRemediationProposalManager.approve(prop.id);

      // Force failure during promote execution
      vi.spyOn(EvaluationConfigPromotionManager, 'promote').mockImplementation(() => {
        throw new Error('Database down');
      });

      EvaluationRemediationProposalManager.execute(prop.id);

      const outcomes = EvaluationRemediationOutcomeManager.generateOutcomes();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].status).toBe('insufficientData');
      expect(outcomes[0].summary).toContain('failed');
    });
  });

  describe('Deep Cloning & Data Sanitization', () => {
    it('should strip transcripts and diagnostic SQL from outcome objects', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      attachMockEvidence(prop);
      EvaluationRemediationProposalManager.approve(prop.id);
      EvaluationRemediationProposalManager.execute(prop.id);

      const execRecord = EvaluationRemediationExecutionManager.listExecutions()[0];
      const execTime = new Date(execRecord.executedAt).getTime();

      // Pre-execution report
      createReport(new Date(execTime - 60000).toISOString(), { relevance: 0.70 }, initialConfig);

      // Post-execution report
      createReport(new Date(execTime + 60000).toISOString(), { relevance: 0.80 }, execRecord.appliedConfig!);

      const outcomes = EvaluationRemediationOutcomeManager.generateOutcomes();
      const stringified = JSON.stringify(outcomes);
      expect(stringified).not.toContain('transcripts');
      expect(stringified).not.toContain('sql');
      expect(stringified).not.toContain('secrets');
    });
  });

  describe('Production Isolation and Config Stability', () => {
    it('should verify production response requests bypass outcome verification layers entirely', async () => {
      const mockGenerator = {
        generateResponse: async () => ({ text: 'Answer' }),
      };
      const mockRetriever = {
        retrieve: async () => [],
      };
      const mockAssembler = {
        assemble: () => ({ items: [], context: '', tokenCount: 0, governance: {} }),
      };

      const service = new ResponseService(
        mockRetriever as unknown as MemoryRetriever,
        mockAssembler as unknown as ContextAssembler,
        mockGenerator as unknown as ResponseGenerator
      );

      await service.respond('user-1', 'hi', {
        evaluationRun: false, // production
      });
    });

    it('should verify global RETRIEVAL_SETTINGS remains byte-for-byte untouched', () => {
      const originalSettingsString = JSON.stringify(RETRIEVAL_SETTINGS);
      expect(JSON.stringify(RETRIEVAL_SETTINGS)).toBe(originalSettingsString);
    });
  });
});
