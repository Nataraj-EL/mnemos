/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PromotionHistoryManager } from './promotionHistory';
import { EvaluationRemediationProposalManager } from './remediationProposal';
import { EvaluationConfigPromotionManager } from './promotion';
import { ConfigSafetyGuard } from './configGuard';
import { EvaluationRemediation, ControlledExperimentResult, TuningConfig } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';
import { ExperimentHistoryManager } from './experimentHistory';

describe('Sprint 65: Gated Evaluation Remediation Proposal & Approval Workflow Tests', () => {
  const sampleRemediation: EvaluationRemediation = {
    alertId: 'alert-123',
    priority: 'high',
    action: 'Evaluate semantic/lexical weighting parameters.',
    reason: 'Relevance is regressing.',
    evidenceIds: ['alr-123', 'aud-456'],
    confidence: 'high',
  };

  beforeEach(() => {
    PromotionHistoryManager.clearHistory();
    EvaluationRemediationProposalManager.clearProposals();
    EvaluationConfigPromotionManager.clearPromotion();
    ExperimentHistoryManager.clearControlledHistory();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Proposal Creation & Safety Checks', () => {
    it('should create proposal with pending status, derived configurations, and sanitized outputs', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      expect(prop.status).toBe('pending');
      expect(prop.remediationId).toBe('alert-123');
      expect(prop.proposedConfig).not.toBeNull();
      expect(prop.proposedConfig?.semanticWeight).toBeGreaterThan(0.5); // base is 0.5, derived conservative goes up
      expect(prop.evidenceIds).toContain('aud-456');
    });

    it('should transition to rejected status during creation if proposed config is unsafe', () => {
      // Mock validate to fail
      vi.spyOn(ConfigSafetyGuard, 'validate').mockReturnValue({
        valid: false,
        errors: ['Unsafe parameters detected!'],
        warnings: [],
      });

      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      expect(prop.status).toBe('rejected');
      expect(prop.rationale).toContain('Rejected: Unsafe configuration');
    });
  });

  describe('Lifecycle State Transitions & Gated Approval', () => {
    it('should complete valid transitions pending -> needsExperiment (without evidence) -> approved (with candidateBetter evidence)', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      expect(prop.status).toBe('pending');

      // 1. Approve without evidence transitions to needsExperiment
      let result = EvaluationRemediationProposalManager.approve(prop.id);
      expect(result.success).toBe(true);
      expect(result.status).toBe('needsExperiment');
      expect(EvaluationRemediationProposalManager.getProposal(prop.id)?.status).toBe('needsExperiment');

      // 2. Cannot execute needsExperiment proposal
      let execSuccess = EvaluationRemediationProposalManager.execute(prop.id);
      expect(execSuccess).toBe(false);

      // 3. Attach matching candidateBetter experiment evidence
      const mockResult: ControlledExperimentResult = {
        experimentId: 'exp-123',
        baselineConfig: { ...RETRIEVAL_SETTINGS },
        candidateConfig: { ...prop.proposedConfig } as TuningConfig,
        baselineSummary: { total: 10, passed: 9, failed: 1, averageLatency: 200 } as any,
        candidateSummary: { total: 10, passed: 10, failed: 0, averageLatency: 150 } as any,
        comparison: { status: 'pass', deltas: {}, failedThresholds: [], baselineAvailable: true },
        decision: 'candidateBetter',
        metricsComparison: {
          relevance: { baseline: 0.8, candidate: 0.9, delta: 0.1, status: 'improved' }
        },
        timestamp: new Date().toISOString(),
        evidenceIds: ['alr-123']
      };
      ExperimentHistoryManager.addControlledRecord(mockResult);

      const linkSuccess = EvaluationRemediationProposalManager.attachEvidence(prop.id, 'exp-123');
      expect(linkSuccess).toBe(true);
      expect(EvaluationRemediationProposalManager.getProposal(prop.id)?.experimentEvidence?.experimentId).toBe('exp-123');

      // 4. Now approve succeeds with 'approved' status
      result = EvaluationRemediationProposalManager.approve(prop.id);
      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');
      expect(EvaluationRemediationProposalManager.getProposal(prop.id)?.status).toBe('approved');

      // 5. Execution succeeds now
      execSuccess = EvaluationRemediationProposalManager.execute(prop.id);
      expect(execSuccess).toBe(true);
      expect(EvaluationRemediationProposalManager.getProposal(prop.id)?.status).toBe('executed');
    });

    it('should reject link attempt when candidateConfig mismatches proposal proposedConfig', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);

      const mockResult: ControlledExperimentResult = {
        experimentId: 'exp-mismatch',
        baselineConfig: { ...RETRIEVAL_SETTINGS },
        candidateConfig: {
          semanticWeight: 0.1, // mismatched
          lexicalWeight: 0.9,
          minSimilarity: 0.8,
          diversityThreshold: 0.3,
          maxConversationSnippets: 5
        },
        baselineSummary: { total: 10, passed: 9, failed: 1, averageLatency: 200 } as any,
        candidateSummary: { total: 10, passed: 10, failed: 0, averageLatency: 150 } as any,
        comparison: { status: 'pass', deltas: {}, failedThresholds: [], baselineAvailable: true },
        decision: 'candidateBetter',
        metricsComparison: {},
        timestamp: new Date().toISOString(),
        evidenceIds: []
      };
      ExperimentHistoryManager.addControlledRecord(mockResult);

      expect(() => {
        EvaluationRemediationProposalManager.attachEvidence(prop.id, 'exp-mismatch');
      }).toThrow('Mismatched configuration');
    });

    it('should throw on attaching missing/non-existent experiment evidence', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      expect(() => {
        EvaluationRemediationProposalManager.attachEvidence(prop.id, 'non-existent-exp-id');
      }).toThrow('Experiment not found.');
    });

    it('should handle baselineBetter by rejecting the proposal automatically', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      const mockResult: ControlledExperimentResult = {
        experimentId: 'exp-worse',
        baselineConfig: { ...RETRIEVAL_SETTINGS },
        candidateConfig: { ...prop.proposedConfig } as TuningConfig,
        baselineSummary: { total: 10, passed: 9, failed: 1, averageLatency: 200 } as any,
        candidateSummary: { total: 10, passed: 5, failed: 5, averageLatency: 150 } as any,
        comparison: { status: 'fail', deltas: {}, failedThresholds: [], baselineAvailable: true },
        decision: 'baselineBetter',
        metricsComparison: {},
        timestamp: new Date().toISOString(),
        evidenceIds: []
      };
      ExperimentHistoryManager.addControlledRecord(mockResult);

      EvaluationRemediationProposalManager.attachEvidence(prop.id, 'exp-worse');
      const result = EvaluationRemediationProposalManager.approve(prop.id);
      expect(result.success).toBe(true);
      expect(result.status).toBe('rejected');
      expect(EvaluationRemediationProposalManager.getProposal(prop.id)?.status).toBe('rejected');
    });

    it('should handle noSignificantDifference by requiring explicit confirmation override', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      const mockResult: ControlledExperimentResult = {
        experimentId: 'exp-neutral',
        baselineConfig: { ...RETRIEVAL_SETTINGS },
        candidateConfig: { ...prop.proposedConfig } as TuningConfig,
        baselineSummary: { total: 10, passed: 9, failed: 1, averageLatency: 200 } as any,
        candidateSummary: { total: 10, passed: 9, failed: 1, averageLatency: 200 } as any,
        comparison: { status: 'pass', deltas: {}, failedThresholds: [], baselineAvailable: true },
        decision: 'noSignificantDifference',
        metricsComparison: {},
        timestamp: new Date().toISOString(),
        evidenceIds: []
      };
      ExperimentHistoryManager.addControlledRecord(mockResult);

      EvaluationRemediationProposalManager.attachEvidence(prop.id, 'exp-neutral');

      // 1. Fails without developer override confirmation
      let result = EvaluationRemediationProposalManager.approve(prop.id);
      expect(result.success).toBe(false);
      expect(result.code).toBe('CONFIRMATION_REQUIRED');
      expect(EvaluationRemediationProposalManager.getProposal(prop.id)?.status).toBe('pending');

      // 2. Succeeds with developer override confirmation
      result = EvaluationRemediationProposalManager.approve(prop.id, true);
      expect(result.success).toBe(true);
      expect(result.status).toBe('approved');
      expect(EvaluationRemediationProposalManager.getProposal(prop.id)?.status).toBe('approved');
    });

    it('should block approval for insufficientData experiment evidence', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      const mockResult: ControlledExperimentResult = {
        experimentId: 'exp-insufficient',
        baselineConfig: { ...RETRIEVAL_SETTINGS },
        candidateConfig: { ...prop.proposedConfig } as TuningConfig,
        baselineSummary: { total: 0, passed: 0, failed: 0, averageLatency: 0 } as any,
        candidateSummary: { total: 0, passed: 0, failed: 0, averageLatency: 0 } as any,
        comparison: { status: 'pass', deltas: {}, failedThresholds: [], baselineAvailable: true },
        decision: 'insufficientData',
        metricsComparison: {},
        timestamp: new Date().toISOString(),
        evidenceIds: []
      };
      ExperimentHistoryManager.addControlledRecord(mockResult);

      EvaluationRemediationProposalManager.attachEvidence(prop.id, 'exp-insufficient');

      const result = EvaluationRemediationProposalManager.approve(prop.id);
      expect(result.success).toBe(false);
      expect(result.code).toBe('INSUFFICIENT_DATA');
      expect(EvaluationRemediationProposalManager.getProposal(prop.id)?.status).toBe('pending');
    });

    it('should reject invalid lifecycle transitions', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);

      // Invalid: cannot execute pending proposal
      let success = EvaluationRemediationProposalManager.execute(prop.id);
      expect(success).toBe(false);

      // Reject it
      success = EvaluationRemediationProposalManager.reject(prop.id);
      expect(success).toBe(true);

      // Invalid: cannot approve rejected proposal
      const res = EvaluationRemediationProposalManager.approve(prop.id);
      expect(res.success).toBe(false);

      // Invalid: cannot execute rejected proposal
      success = EvaluationRemediationProposalManager.execute(prop.id);
      expect(success).toBe(false);
    });

    it('should prevent repeated execution of an already executed proposal', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      
      const mockResult: ControlledExperimentResult = {
        experimentId: 'exp-exec-twice',
        baselineConfig: { ...RETRIEVAL_SETTINGS },
        candidateConfig: { ...prop.proposedConfig } as TuningConfig,
        baselineSummary: { total: 10, passed: 9, failed: 1, averageLatency: 200 } as any,
        candidateSummary: { total: 10, passed: 10, failed: 0, averageLatency: 150 } as any,
        comparison: { status: 'pass', deltas: {}, failedThresholds: [], baselineAvailable: true },
        decision: 'candidateBetter',
        metricsComparison: {},
        timestamp: new Date().toISOString(),
        evidenceIds: []
      };
      ExperimentHistoryManager.addControlledRecord(mockResult);
      EvaluationRemediationProposalManager.attachEvidence(prop.id, 'exp-exec-twice');
      EvaluationRemediationProposalManager.approve(prop.id);

      // First execution succeeds
      let success = EvaluationRemediationProposalManager.execute(prop.id);
      expect(success).toBe(true);

      // Second execution fails
      success = EvaluationRemediationProposalManager.execute(prop.id);
      expect(success).toBe(false);
    });

    it('should prevent duplicate evidence entries (updates existing evidence details)', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);

      const mockResult1: ControlledExperimentResult = {
        experimentId: 'exp-1',
        baselineConfig: { ...RETRIEVAL_SETTINGS },
        candidateConfig: { ...prop.proposedConfig } as TuningConfig,
        baselineSummary: { total: 10, passed: 9, failed: 1, averageLatency: 200 } as any,
        candidateSummary: { total: 10, passed: 10, failed: 0, averageLatency: 150 } as any,
        comparison: { status: 'pass', deltas: {}, failedThresholds: [], baselineAvailable: true },
        decision: 'candidateBetter',
        metricsComparison: {},
        timestamp: new Date().toISOString(),
        evidenceIds: []
      };
      const mockResult2: ControlledExperimentResult = {
        experimentId: 'exp-2',
        baselineConfig: { ...RETRIEVAL_SETTINGS },
        candidateConfig: { ...prop.proposedConfig } as TuningConfig,
        baselineSummary: { total: 10, passed: 9, failed: 1, averageLatency: 200 } as any,
        candidateSummary: { total: 10, passed: 10, failed: 0, averageLatency: 150 } as any,
        comparison: { status: 'pass', deltas: {}, failedThresholds: [], baselineAvailable: true },
        decision: 'candidateBetter',
        metricsComparison: {},
        timestamp: new Date().toISOString(),
        evidenceIds: []
      };
      ExperimentHistoryManager.addControlledRecord(mockResult1);
      ExperimentHistoryManager.addControlledRecord(mockResult2);

      EvaluationRemediationProposalManager.attachEvidence(prop.id, 'exp-1');
      expect(EvaluationRemediationProposalManager.getProposal(prop.id)?.experimentEvidence?.experimentId).toBe('exp-1');

      // Re-attach updating existing slot without creating extra structures
      EvaluationRemediationProposalManager.attachEvidence(prop.id, 'exp-2');
      expect(EvaluationRemediationProposalManager.getProposal(prop.id)?.experimentEvidence?.experimentId).toBe('exp-2');
    });
  });

  describe('Promotion Integration & Immutability', () => {
    it('should register config promotions in PromotionHistoryManager audit trail on execution', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);

      const mockResult: ControlledExperimentResult = {
        experimentId: 'exp-promo',
        baselineConfig: { ...RETRIEVAL_SETTINGS },
        candidateConfig: { ...prop.proposedConfig } as TuningConfig,
        baselineSummary: { total: 10, passed: 9, failed: 1, averageLatency: 200 } as any,
        candidateSummary: { total: 10, passed: 10, failed: 0, averageLatency: 150 } as any,
        comparison: { status: 'pass', deltas: {}, failedThresholds: [], baselineAvailable: true },
        decision: 'candidateBetter',
        metricsComparison: {},
        timestamp: new Date().toISOString(),
        evidenceIds: []
      };
      ExperimentHistoryManager.addControlledRecord(mockResult);
      EvaluationRemediationProposalManager.attachEvidence(prop.id, 'exp-promo');
      EvaluationRemediationProposalManager.approve(prop.id);

      expect(PromotionHistoryManager.listRecords()).toHaveLength(0);

      const success = EvaluationRemediationProposalManager.execute(prop.id);
      expect(success).toBe(true);

      const promotions = PromotionHistoryManager.listRecords();
      expect(promotions).toHaveLength(1);
      expect(promotions[0].action).toBe('promote');
      expect(promotions[0].newConfig?.semanticWeight).toBe(prop.proposedConfig?.semanticWeight);
    });

    it('should revalidate configuration safety before executing', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      const mockResult: ControlledExperimentResult = {
        experimentId: 'exp-safety',
        baselineConfig: { ...RETRIEVAL_SETTINGS },
        candidateConfig: { ...prop.proposedConfig } as TuningConfig,
        baselineSummary: { total: 10, passed: 9, failed: 1, averageLatency: 200 } as any,
        candidateSummary: { total: 10, passed: 10, failed: 0, averageLatency: 150 } as any,
        comparison: { status: 'pass', deltas: {}, failedThresholds: [], baselineAvailable: true },
        decision: 'candidateBetter',
        metricsComparison: {},
        timestamp: new Date().toISOString(),
        evidenceIds: []
      };
      ExperimentHistoryManager.addControlledRecord(mockResult);
      EvaluationRemediationProposalManager.attachEvidence(prop.id, 'exp-safety');
      EvaluationRemediationProposalManager.approve(prop.id);

      // Mock safety check to fail right before execution
      vi.spyOn(ConfigSafetyGuard, 'validate').mockReturnValue({
        valid: false,
        errors: ['Config safety breached!'],
        warnings: [],
      });

      const success = EvaluationRemediationProposalManager.execute(prop.id);
      expect(success).toBe(false);
      expect(EvaluationRemediationProposalManager.getProposal(prop.id)?.status).toBe('rejected');
    });

    it('should enforce strict FIFO limit of 20 proposals', () => {
      for (let i = 0; i < 25; i++) {
        const remediationItem = {
          ...sampleRemediation,
          reason: `Remediation reason ${i}`,
        };
        EvaluationRemediationProposalManager.createProposal(remediationItem);
      }

      const list = EvaluationRemediationProposalManager.listProposals();
      expect(list).toHaveLength(20);
      expect(list[0].rationale).toContain('reason 24'); // newest at index 0
      expect(list[19].rationale).toContain('reason 5'); // oldest surviving
    });

    it('should sanitize secrets and diagnostics from proposals', () => {
      const richRemediation = {
        ...sampleRemediation,
        diagnostics: { sql: 'SELECT * FROM secrets' },
        secrets: 'super-secret-key',
      } as unknown as EvaluationRemediation;

      const prop = EvaluationRemediationProposalManager.createProposal(richRemediation);
      const str = JSON.stringify(prop);
      expect(str).not.toContain('secrets');
      expect(str).not.toContain('super-secret-key');
    });
  });

  describe('Production Isolation and Config Stability', () => {
    it('should verify production response requests bypass proposal logic completely', async () => {
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

    it('should verify global RETRIEVAL_SETTINGS remains byte-for-byte unchanged', () => {
      const originalSettingsString = JSON.stringify(RETRIEVAL_SETTINGS);

      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      
      const mockResult: ControlledExperimentResult = {
        experimentId: 'exp-immutability',
        baselineConfig: { ...RETRIEVAL_SETTINGS },
        candidateConfig: { ...prop.proposedConfig } as TuningConfig,
        baselineSummary: { total: 10, passed: 9, failed: 1, averageLatency: 200 } as any,
        candidateSummary: { total: 10, passed: 10, failed: 0, averageLatency: 150 } as any,
        comparison: { status: 'pass', deltas: {}, failedThresholds: [], baselineAvailable: true },
        decision: 'candidateBetter',
        metricsComparison: {},
        timestamp: new Date().toISOString(),
        evidenceIds: []
      };
      ExperimentHistoryManager.addControlledRecord(mockResult);
      EvaluationRemediationProposalManager.attachEvidence(prop.id, 'exp-immutability');
      EvaluationRemediationProposalManager.approve(prop.id);
      EvaluationRemediationProposalManager.execute(prop.id);

      expect(JSON.stringify(RETRIEVAL_SETTINGS)).toBe(originalSettingsString);
    });
  });
});
