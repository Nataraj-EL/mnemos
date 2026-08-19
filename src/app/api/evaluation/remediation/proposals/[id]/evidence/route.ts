import { NextRequest, NextResponse } from 'next/server';
import { EvaluationRemediationProposalManager } from '@/evaluation/remediationProposal';
import { ExperimentHistoryManager } from '@/evaluation/experimentHistory';

export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    return NextResponse.json(
      { error: 'Remediation proposals endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const { id: proposalId } = await params;
    const body = await req.json();
    const { experimentId } = body || {};

    if (!proposalId || !experimentId) {
      return NextResponse.json({ error: 'Missing proposal ID or experiment ID.' }, { status: 400 });
    }

    const proposal = EvaluationRemediationProposalManager.getProposal(proposalId);
    if (!proposal) {
      return NextResponse.json({ error: 'Proposal not found.' }, { status: 404 });
    }

    const experiment = ExperimentHistoryManager.getControlledRecord(experimentId);
    if (!experiment) {
      return NextResponse.json({ error: 'Experiment not found.' }, { status: 404 });
    }

    try {
      EvaluationRemediationProposalManager.attachEvidence(proposalId, experimentId);
      return NextResponse.json(EvaluationRemediationProposalManager.getProposal(proposalId));
    } catch (err: unknown) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }
  } catch (error: unknown) {
    console.error('Evidence POST Error:', error);
    return NextResponse.json({ error: 'Failed to attach evidence.' }, { status: 500 });
  }
}
