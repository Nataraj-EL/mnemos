/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { EvaluationRemediationProposalManager } from '@/evaluation/remediationProposal';
import { ExperimentHistoryManager } from '@/evaluation/experimentHistory';
import { ControlledExperimentResult } from '@/evaluation/types';
import { RETRIEVAL_SETTINGS } from '@/core/config';

describe('POST /api/evaluation/remediation/proposals/[id]/evidence API Route', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    EvaluationRemediationProposalManager.clearProposals();
    ExperimentHistoryManager.clearControlledHistory();
  });

  afterEach(() => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: originalEnv,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  });

  it('should return 403 when NODE_ENV is production', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'production',
      configurable: true,
      writable: true,
      enumerable: true,
    });

    const request = new NextRequest('http://localhost:3000/api/evaluation/remediation/proposals/prp-1/evidence', {
      method: 'POST',
      body: JSON.stringify({ experimentId: 'exp-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'prp-1' }) });
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toContain('development environment');
  });

  it('should return 404 when proposal does not exist', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'development',
      configurable: true,
      writable: true,
      enumerable: true,
    });

    const request = new NextRequest('http://localhost:3000/api/evaluation/remediation/proposals/prp-missing/evidence', {
      method: 'POST',
      body: JSON.stringify({ experimentId: 'exp-1' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'prp-missing' }) });
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Proposal not found.');
  });

  it('should return 404 when experiment does not exist', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'development',
      configurable: true,
      writable: true,
      enumerable: true,
    });

    const prop = EvaluationRemediationProposalManager.createProposal({
      alertId: 'alert-1',
      priority: 'high',
      action: 'Evaluate similarity threshold.',
      reason: 'Relevance degraded.',
      evidenceIds: [],
      confidence: 'high'
    });

    const request = new NextRequest(`http://localhost:3000/api/evaluation/remediation/proposals/${prop.id}/evidence`, {
      method: 'POST',
      body: JSON.stringify({ experimentId: 'exp-missing' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: prop.id }) });
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Experiment not found.');
  });

  it('should return 400 on configuration mismatch', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'development',
      configurable: true,
      writable: true,
      enumerable: true,
    });

    const prop = EvaluationRemediationProposalManager.createProposal({
      alertId: 'alert-1',
      priority: 'high',
      action: 'Evaluate similarity threshold.',
      reason: 'Relevance degraded.',
      evidenceIds: [],
      confidence: 'high'
    });

    const mockResult: ControlledExperimentResult = {
      experimentId: 'exp-mismatch',
      baselineConfig: { ...RETRIEVAL_SETTINGS },
      candidateConfig: {
        semanticWeight: 0.1, // mismatch
        lexicalWeight: 0.9,
        minSimilarity: 0.9,
        diversityThreshold: 0.3,
        maxConversationSnippets: 5
      },
      baselineSummary: { total: 10 } as any,
      candidateSummary: { total: 10 } as any,
      comparison: { status: 'pass', deltas: {}, failedThresholds: [], baselineAvailable: true },
      decision: 'candidateBetter',
      metricsComparison: {},
      timestamp: new Date().toISOString(),
      evidenceIds: []
    };
    ExperimentHistoryManager.addControlledRecord(mockResult);

    const request = new NextRequest(`http://localhost:3000/api/evaluation/remediation/proposals/${prop.id}/evidence`, {
      method: 'POST',
      body: JSON.stringify({ experimentId: 'exp-mismatch' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: prop.id }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Mismatched configuration');
  });

  it('should link evidence successfully and return 200 with proposal', async () => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: 'development',
      configurable: true,
      writable: true,
      enumerable: true,
    });

    const prop = EvaluationRemediationProposalManager.createProposal({
      alertId: 'alert-1',
      priority: 'high',
      action: 'Evaluate similarity threshold.',
      reason: 'Relevance degraded.',
      evidenceIds: [],
      confidence: 'high'
    });

    const mockResult: ControlledExperimentResult = {
      experimentId: 'exp-match',
      baselineConfig: { ...RETRIEVAL_SETTINGS },
      candidateConfig: { ...prop.proposedConfig } as any,
      baselineSummary: { total: 10 } as any,
      candidateSummary: { total: 10 } as any,
      comparison: { status: 'pass', deltas: {}, failedThresholds: [], baselineAvailable: true },
      decision: 'candidateBetter',
      metricsComparison: {
        relevance: { baseline: 0.8, candidate: 0.9, delta: 0.1, status: 'improved' }
      },
      timestamp: new Date().toISOString(),
      evidenceIds: []
    };
    ExperimentHistoryManager.addControlledRecord(mockResult);

    const request = new NextRequest(`http://localhost:3000/api/evaluation/remediation/proposals/${prop.id}/evidence`, {
      method: 'POST',
      body: JSON.stringify({ experimentId: 'exp-match' }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: prop.id }) });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.experimentEvidence.experimentId).toBe('exp-match');
    expect(data.experimentEvidence.evidenceStatus).toBe('Experiment Validated');
  });
});
