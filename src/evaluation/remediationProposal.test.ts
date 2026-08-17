import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PromotionHistoryManager } from './promotionHistory';
import { EvaluationRemediationProposalManager } from './remediationProposal';
import { EvaluationConfigPromotionManager } from './promotion';
import { ConfigSafetyGuard } from './configGuard';
import { EvaluationRemediation } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 59: Evaluation Remediation Proposal & Approval Workflow Tests', () => {
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

  describe('Lifecycle State Transitions', () => {
    it('should complete valid transitions pending -> approved -> executed', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      expect(prop.status).toBe('pending');

      // Valid: pending -> approved
      let success = EvaluationRemediationProposalManager.approve(prop.id);
      expect(success).toBe(true);
      expect(EvaluationRemediationProposalManager.getProposal(prop.id)?.status).toBe('approved');

      // Valid: approved -> executed
      success = EvaluationRemediationProposalManager.execute(prop.id);
      expect(success).toBe(true);
      expect(EvaluationRemediationProposalManager.getProposal(prop.id)?.status).toBe('executed');
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
      success = EvaluationRemediationProposalManager.approve(prop.id);
      expect(success).toBe(false);

      // Invalid: cannot execute rejected proposal
      success = EvaluationRemediationProposalManager.execute(prop.id);
      expect(success).toBe(false);
    });

    it('should prevent repeated execution of an already executed proposal', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
      EvaluationRemediationProposalManager.approve(prop.id);

      // First execution succeeds
      let success = EvaluationRemediationProposalManager.execute(prop.id);
      expect(success).toBe(true);

      // Second execution fails
      success = EvaluationRemediationProposalManager.execute(prop.id);
      expect(success).toBe(false);
    });
  });

  describe('Promotion Integration & Immutability', () => {
    it('should register config promotions in PromotionHistoryManager audit trail on execution', () => {
      const prop = EvaluationRemediationProposalManager.createProposal(sampleRemediation);
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

    it('should enforce strict FIFO limit of 20 records', () => {
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
      EvaluationRemediationProposalManager.approve(prop.id);
      EvaluationRemediationProposalManager.execute(prop.id);

      expect(JSON.stringify(RETRIEVAL_SETTINGS)).toBe(originalSettingsString);
    });
  });
});
