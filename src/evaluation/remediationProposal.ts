import {
  EvaluationRemediationProposal,
  RemediationProposalStatus,
  EvaluationRemediation,
  TuningConfig,
} from './types';
import { ConfigSafetyGuard } from './configGuard';
import { EvaluationConfigPromotionManager } from './promotion';
import { EvaluationRemediationExecutionManager } from './remediationExecution';
import { RETRIEVAL_SETTINGS } from '@/core/config';

export class EvaluationRemediationProposalManager {
  private static proposals: EvaluationRemediationProposal[] = [];

  private static deepClone<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    return JSON.parse(JSON.stringify(obj));
  }

  private static sanitizeData<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    const cloned = this.deepClone(obj);
    const keysToStrip = ['diagnostics', 'prompts', 'sql', 'uuid', 'apiKey', 'provider', 'secrets'];

    const traverseAndStrip = (current: unknown) => {
      if (typeof current !== 'object' || current === null) return;
      const obj = current as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (keysToStrip.includes(key)) {
          delete obj[key];
        } else {
          traverseAndStrip(obj[key]);
        }
      }
    };

    traverseAndStrip(cloned);
    return cloned;
  }

  public static listProposals(): EvaluationRemediationProposal[] {
    return this.sanitizeData(this.proposals);
  }

  public static getProposal(id: string): EvaluationRemediationProposal | null {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal) return null;
    return this.sanitizeData(proposal);
  }

  public static clearProposals(): void {
    this.proposals = [];
  }

  public static createProposal(remediation: EvaluationRemediation): EvaluationRemediationProposal {
    const id = `prp-${Math.random().toString(36).substring(2, 11)}`;
    const timestamp = new Date().toISOString();

    // Fetch active dev configuration
    const currentConfig: TuningConfig = EvaluationConfigPromotionManager.getCurrentConfig() || {
      semanticWeight: RETRIEVAL_SETTINGS.semanticWeight,
      lexicalWeight: RETRIEVAL_SETTINGS.lexicalWeight,
      minSimilarity: RETRIEVAL_SETTINGS.minSimilarity,
      diversityThreshold: RETRIEVAL_SETTINGS.diversityThreshold,
      maxConversationSnippets: RETRIEVAL_SETTINGS.maxConversationSnippets,
    };

    let proposedConfig: TuningConfig | null = null;
    let rationale = remediation.reason;

    // Derive a conservative configuration change from remediation action
    if (remediation.action.includes('semantic/lexical weighting')) {
      proposedConfig = { ...currentConfig };
      proposedConfig.semanticWeight = Math.min(0.95, parseFloat((currentConfig.semanticWeight + 0.1).toFixed(2)));
      proposedConfig.lexicalWeight = parseFloat((1.0 - proposedConfig.semanticWeight).toFixed(2));
      rationale = `${remediation.reason} Conservative change: semanticWeight adjusted upwards to increase relevance.`;
    } else if (remediation.action.includes('similarity threshold')) {
      proposedConfig = { ...currentConfig };
      proposedConfig.minSimilarity = Math.min(0.9, parseFloat((currentConfig.minSimilarity + 0.1).toFixed(2)));
      rationale = `${remediation.reason} Conservative change: minSimilarity threshold adjusted upwards to filter weak matches.`;
    } else if (remediation.action.includes('Reduce conversation snippets count')) {
      proposedConfig = { ...currentConfig };
      proposedConfig.maxConversationSnippets = Math.max(2, currentConfig.maxConversationSnippets - 1);
      rationale = `${remediation.reason} Conservative change: maxConversationSnippets count reduced to lower latencies.`;
    }

    let status: RemediationProposalStatus = 'pending';

    // Validate proposed configuration if applicable
    if (proposedConfig) {
      const safetyCheck = ConfigSafetyGuard.validate(proposedConfig);
      if (!safetyCheck.valid) {
        status = 'rejected';
        rationale = `Rejected: Unsafe configuration validation errors: ${safetyCheck.errors.join(', ')}`;
      }
    }

    const proposal: EvaluationRemediationProposal = {
      id,
      remediationId: remediation.alertId,
      status,
      proposedConfig,
      rationale,
      evidenceIds: [...remediation.evidenceIds],
      confidence: remediation.confidence,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // FIFO eviction max 20, newest first (unshifted at index 0)
    this.proposals.unshift(proposal);
    if (this.proposals.length > 20) {
      this.proposals.pop();
    }

    return this.sanitizeData(proposal);
  }

  public static approve(id: string): boolean {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal || proposal.status !== 'pending') {
      return false;
    }

    // Revalidate config safety if proposing a change
    if (proposal.proposedConfig) {
      const safetyCheck = ConfigSafetyGuard.validate(proposal.proposedConfig);
      if (!safetyCheck.valid) {
        proposal.status = 'rejected';
        proposal.updatedAt = new Date().toISOString();
        return false;
      }
    }

    proposal.status = 'approved';
    proposal.updatedAt = new Date().toISOString();
    return true;
  }

  public static reject(id: string): boolean {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal || proposal.status !== 'pending') {
      return false;
    }
    proposal.status = 'rejected';
    proposal.updatedAt = new Date().toISOString();
    return true;
  }

  public static execute(id: string): boolean {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal || proposal.status !== 'approved') {
      return false;
    }

    const previousConfig: TuningConfig = EvaluationConfigPromotionManager.getCurrentConfig() || {
      semanticWeight: RETRIEVAL_SETTINGS.semanticWeight,
      lexicalWeight: RETRIEVAL_SETTINGS.lexicalWeight,
      minSimilarity: RETRIEVAL_SETTINGS.minSimilarity,
      diversityThreshold: RETRIEVAL_SETTINGS.diversityThreshold,
      maxConversationSnippets: RETRIEVAL_SETTINGS.maxConversationSnippets,
    };

    if (!proposal.proposedConfig) {
      // Non-config proposal (e.g. controlled A/B experiment or generic inspection)
      // Transition directly to executed
      proposal.status = 'executed';
      proposal.updatedAt = new Date().toISOString();

      // Record non-config execution log
      EvaluationRemediationExecutionManager.recordExecution({
        proposalId: proposal.id,
        previousConfig: null,
        appliedConfig: null,
        status: 'success',
      });
      return true;
    }

    // Revalidate config safety
    const safetyCheck = ConfigSafetyGuard.validate(proposal.proposedConfig);
    if (!safetyCheck.valid) {
      proposal.status = 'rejected';
      proposal.updatedAt = new Date().toISOString();
      return false;
    }

    try {
      // Execution must NOT mutate global RETRIEVAL_SETTINGS constants.
      // Instead, promote to active developer evaluation promotion state
      const auditRecord = EvaluationConfigPromotionManager.promote(proposal.proposedConfig);

      proposal.status = 'executed';
      proposal.updatedAt = new Date().toISOString();

      EvaluationRemediationExecutionManager.recordExecution({
        proposalId: proposal.id,
        previousConfig,
        appliedConfig: proposal.proposedConfig,
        status: 'success',
        auditId: auditRecord.id,
      });

      return true;
    } catch {
      proposal.status = 'rejected';
      proposal.updatedAt = new Date().toISOString();

      EvaluationRemediationExecutionManager.recordExecution({
        proposalId: proposal.id,
        previousConfig,
        appliedConfig: null,
        status: 'failed',
      });

      return false;
    }
  }
}
