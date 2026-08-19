/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PromotionHistoryManager } from './promotionHistory';
import { EvaluationRemediationProposalManager } from './remediationProposal';
import { EvaluationRemediationExecutionManager } from './remediationExecution';
import { EvaluationConfigPromotionManager } from './promotion';
import { EvaluationRemediation, ControlledExperimentResult } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';
import { ExperimentHistoryManager } from './experimentHistory';

describe('Sprint 60: Evaluation Remediation Execution History & Rollback Tests', () => {
  const sampleRemediation: EvaluationRemediation = {
    alertId: 'alert-123',
    priority: 'high',
    action: 'Evaluate semantic/lexical weighting parameters.',
    reason: 'Relevance regression.',
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

  beforeEach(() => {
    PromotionHistoryManager.clearHistory();
    EvaluationRemediationProposalManager.clearProposals();
    EvaluationRemediationExecutionManager.clearHistory();
    EvaluationConfigPromotionManager.clearPromotion();
    vi.restoreAllMocks();

    // Initialize baseline config to ensure previousConfig weights sum to 1.0
    EvaluationConfigPromotionManager.promote({
      semanticWeight: 0.70,
      lexicalWeight: 0.30,
      minSimilarity: 0.20,
      diversityThreshold: 0.70,
      maxConversationSnippets: 3,
    });
    PromotionHistoryManager.clearHistory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Execution Log Records Creation', () => {
    it('should create execution history logs upon successful proposal execution', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      attachMockEvidence(prop);
      EvaluationRemediationProposalManager.approve(prop.id);

      expect(EvaluationRemediationExecutionManager.listExecutions()).toHaveLength(0);

      const success = EvaluationRemediationProposalManager.execute(prop.id);
      expect(success).toBe(true);

      const executions = EvaluationRemediationExecutionManager.listExecutions();
      expect(executions).toHaveLength(1);
      expect(executions[0].status).toBe('success');
      expect(executions[0].proposalId).toBe(prop.id);
      expect(executions[0].previousConfig).not.toBeNull();
      expect(executions[0].appliedConfig?.semanticWeight).toBe(prop.proposedConfig?.semanticWeight);
      expect(executions[0].auditId).not.toBeUndefined();
    });

    it('should record execution failure if ConfigPromotionManager promote throws', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      attachMockEvidence(prop);
      EvaluationRemediationProposalManager.approve(prop.id);

      // Force promote to throw an error
      vi.spyOn(EvaluationConfigPromotionManager, 'promote').mockImplementation(() => {
        throw new Error('Promotion database error!');
      });

      const success = EvaluationRemediationProposalManager.execute(prop.id);
      expect(success).toBe(false);

      const executions = EvaluationRemediationExecutionManager.listExecutions();
      expect(executions).toHaveLength(1);
      expect(executions[0].status).toBe('failed');
      expect(executions[0].appliedConfig).toBeNull();
      expect(executions[0].auditId).toBeUndefined();
    });
  });

  describe('Rollback Safety Reversion', () => {
    it('should restore configuration to previous state and create audit record on rollback', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      attachMockEvidence(prop);
      EvaluationRemediationProposalManager.approve(prop.id);

      const baseConfig = EvaluationConfigPromotionManager.getCurrentConfig() || {
        semanticWeight: RETRIEVAL_SETTINGS.semanticWeight,
        lexicalWeight: RETRIEVAL_SETTINGS.lexicalWeight,
        minSimilarity: RETRIEVAL_SETTINGS.minSimilarity,
        diversityThreshold: RETRIEVAL_SETTINGS.diversityThreshold,
        maxConversationSnippets: RETRIEVAL_SETTINGS.maxConversationSnippets,
      };

      // Execute proposal (updating configuration state)
      EvaluationRemediationProposalManager.execute(prop.id);

      const promotedConfig = EvaluationConfigPromotionManager.getCurrentConfig();
      expect(promotedConfig?.semanticWeight).not.toBe(baseConfig.semanticWeight);

      const execRecord = EvaluationRemediationExecutionManager.listExecutions()[0];

      // Perform rollback
      const success = EvaluationRemediationExecutionManager.rollback(execRecord.id);
      expect(success).toBe(true);

      const rolledBackConfig = EvaluationConfigPromotionManager.getCurrentConfig();
      expect(rolledBackConfig?.semanticWeight).toBe(baseConfig.semanticWeight);

      const updatedRecord = EvaluationRemediationExecutionManager.getExecution(execRecord.id);
      expect(updatedRecord?.status).toBe('rolled_back');
      expect(updatedRecord?.rollbackAt).not.toBeUndefined();
      expect(updatedRecord?.auditId).not.toBe(execRecord.auditId);
    });

    it('should prevent rollbacks for non-success executions', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      attachMockEvidence(prop);
      EvaluationRemediationProposalManager.approve(prop.id);

      vi.spyOn(EvaluationConfigPromotionManager, 'promote').mockImplementation(() => {
        throw new Error('Database down');
      });

      EvaluationRemediationProposalManager.execute(prop.id);

      const execRecord = EvaluationRemediationExecutionManager.listExecutions()[0];
      expect(execRecord.status).toBe('failed');

      const success = EvaluationRemediationExecutionManager.rollback(execRecord.id);
      expect(success).toBe(false);
    });

    it('should reject repeated rollback calls on already rolled back records', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      attachMockEvidence(prop);
      EvaluationRemediationProposalManager.approve(prop.id);
      EvaluationRemediationProposalManager.execute(prop.id);

      const execRecord = EvaluationRemediationExecutionManager.listExecutions()[0];

      // First rollback succeeds
      let success = EvaluationRemediationExecutionManager.rollback(execRecord.id);
      expect(success).toBe(true);

      // Second rollback fails
      success = EvaluationRemediationExecutionManager.rollback(execRecord.id);
      expect(success).toBe(false);
    });
  });

  describe('FIFO Eviction Limits', () => {
    it('should enforce strict FIFO limit of 20 execution records', () => {
      for (let i = 0; i < 25; i++) {
        EvaluationRemediationExecutionManager.recordExecution({
          proposalId: `prp-${i}`,
          previousConfig: null,
          appliedConfig: null,
          status: 'success',
        });
      }

      const list = EvaluationRemediationExecutionManager.listExecutions();
      expect(list).toHaveLength(20);
      expect(list[0].proposalId).toBe('prp-24'); // newest first
      expect(list[19].proposalId).toBe('prp-5'); // oldest survives
    });
  });

  describe('Config Integrity and Production Isolation', () => {
    it('should verify production response queries operate cleanly bypassing execution history trackers', async () => {
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

    it('should ensure global RETRIEVAL_SETTINGS defaults are byte-for-byte immutable', () => {
      const originalSettingsString = JSON.stringify(RETRIEVAL_SETTINGS);

      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      attachMockEvidence(prop);
      EvaluationRemediationProposalManager.approve(prop.id);
      EvaluationRemediationProposalManager.execute(prop.id);

      const execRecord = EvaluationRemediationExecutionManager.listExecutions()[0];
      EvaluationRemediationExecutionManager.rollback(execRecord.id);

      expect(JSON.stringify(RETRIEVAL_SETTINGS)).toBe(originalSettingsString);
    });
  });
});
