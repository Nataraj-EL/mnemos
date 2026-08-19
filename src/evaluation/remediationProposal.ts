import {
  EvaluationRemediationProposal,
  RemediationProposalStatus,
  EvaluationRemediation,
  TuningConfig,
} from './types';
import { ConfigSafetyGuard } from './configGuard';
import { EvaluationConfigPromotionManager } from './promotion';
import { EvaluationRemediationExecutionManager } from './remediationExecution';
import { ExperimentHistoryManager } from './experimentHistory';
import { RETRIEVAL_SETTINGS } from '@/core/config';

export interface ApprovalResult {
  success: boolean;
  status: RemediationProposalStatus;
  message?: string;
  code?: 'APPROVED' | 'NEEDS_EXPERIMENT' | 'CONFIRMATION_REQUIRED' | 'REJECTED' | 'INSUFFICIENT_DATA';
}

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

  public static configMatches(c1: TuningConfig | null, c2: TuningConfig | null): boolean {
    if (!c1 && !c2) return true;
    if (!c1 || !c2) return false;
    return (
      c1.semanticWeight === c2.semanticWeight &&
      c1.lexicalWeight === c2.lexicalWeight &&
      c1.minSimilarity === c2.minSimilarity &&
      c1.diversityThreshold === c2.diversityThreshold &&
      c1.maxConversationSnippets === c2.maxConversationSnippets
    );
  }

  public static attachEvidence(proposalId: string, experimentId: string): boolean {
    const proposal = this.proposals.find((p) => p.id === proposalId);
    if (!proposal) {
      throw new Error('Proposal not found.');
    }

    const experiment = ExperimentHistoryManager.getControlledRecord(experimentId);
    if (!experiment) {
      throw new Error('Experiment not found.');
    }

    if (!this.configMatches(proposal.proposedConfig, experiment.candidateConfig)) {
      throw new Error('Mismatched configuration: Experiment candidate config does not match the proposal proposed config.');
    }

    let evidenceStatus = 'Experiment Inconclusive';
    if (experiment.decision === 'candidateBetter') {
      evidenceStatus = 'Experiment Validated';
    } else if (experiment.decision === 'baselineBetter') {
      evidenceStatus = 'Experiment Rejects Proposal';
    } else if (experiment.decision === 'noSignificantDifference' || experiment.decision === 'insufficientData') {
      evidenceStatus = 'Experiment Inconclusive';
    }

    const metricDeltas: Record<string, number> = {};
    for (const [m, comp] of Object.entries(experiment.metricsComparison)) {
      metricDeltas[m] = comp.delta;
    }

    proposal.experimentEvidence = {
      experimentId,
      decision: experiment.decision,
      evidenceStatus,
      metricDeltas: this.sanitizeData(metricDeltas),
    };

    proposal.updatedAt = new Date().toISOString();
    return true;
  }

  public static approve(id: string, developerConfirmed?: boolean): ApprovalResult {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal) {
      return { success: false, status: 'pending', message: 'Proposal not found.', code: 'INSUFFICIENT_DATA' };
    }
    if (proposal.status !== 'pending' && proposal.status !== 'needsExperiment') {
      return { success: false, status: proposal.status, message: 'Invalid proposal status for approval.', code: 'INSUFFICIENT_DATA' };
    }

    // Revalidate config safety if proposing a change
    if (proposal.proposedConfig) {
      const safetyCheck = ConfigSafetyGuard.validate(proposal.proposedConfig);
      if (!safetyCheck.valid) {
        proposal.status = 'rejected';
        proposal.updatedAt = new Date().toISOString();
        return { success: true, status: 'rejected', message: `Rejected: Unsafe configuration: ${safetyCheck.errors.join(', ')}`, code: 'REJECTED' };
      }
    }

    if (!proposal.experimentEvidence) {
      proposal.status = 'needsExperiment';
      proposal.updatedAt = new Date().toISOString();
      return { success: true, status: 'needsExperiment', message: 'Proposal requires experiment evidence before approval.', code: 'NEEDS_EXPERIMENT' };
    }

    const { decision } = proposal.experimentEvidence;
    if (decision === 'candidateBetter') {
      proposal.status = 'approved';
      proposal.updatedAt = new Date().toISOString();
      return { success: true, status: 'approved', message: 'Proposal approved based on positive experiment evidence.', code: 'APPROVED' };
    } else if (decision === 'noSignificantDifference') {
      if (developerConfirmed) {
        proposal.status = 'approved';
        proposal.updatedAt = new Date().toISOString();
        return { success: true, status: 'approved', message: 'Proposal approved with developer override.', code: 'APPROVED' };
      }
      return { success: false, status: proposal.status, message: 'Inconclusive experiment results. Developer confirmation required.', code: 'CONFIRMATION_REQUIRED' };
    } else if (decision === 'baselineBetter') {
      proposal.status = 'rejected';
      proposal.updatedAt = new Date().toISOString();
      return { success: true, status: 'rejected', message: 'Proposal rejected: Baseline performed better in controlled experiment.', code: 'REJECTED' };
    } else if (decision === 'insufficientData') {
      return { success: false, status: proposal.status, message: 'Insufficient experiment data to approve.', code: 'INSUFFICIENT_DATA' };
    }

    return { success: false, status: proposal.status, message: 'Unknown decision outcome.', code: 'INSUFFICIENT_DATA' };
  }

  public static reject(id: string): boolean {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal || (proposal.status !== 'pending' && proposal.status !== 'needsExperiment')) {
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
