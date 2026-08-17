import { NextRequest, NextResponse } from 'next/server';
import { EvaluationRemediationProposalManager } from '@/evaluation/remediationProposal';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Remediation proposal execution endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const { id } = body || {};
    if (!id) {
      return NextResponse.json({ error: 'Missing proposal ID.' }, { status: 400 });
    }

    const proposal = EvaluationRemediationProposalManager.getProposal(id);
    if (!proposal) {
      return NextResponse.json({ error: 'Proposal not found.' }, { status: 404 });
    }

    if (proposal.status !== 'approved') {
      // Return 409 Conflict for non-approved proposals
      return NextResponse.json(
        { error: 'Proposal must be approved before execution.' },
        { status: 409 }
      );
    }

    const success = EvaluationRemediationProposalManager.execute(id);
    if (!success) {
      return NextResponse.json({ error: 'Failed to execute proposal.' }, { status: 500 });
    }

    return NextResponse.json(EvaluationRemediationProposalManager.getProposal(id));
  } catch (error: unknown) {
    console.error('Proposal Execution POST Error:', error);
    return NextResponse.json({ error: 'Failed to execute proposal.' }, { status: 500 });
  }
}
