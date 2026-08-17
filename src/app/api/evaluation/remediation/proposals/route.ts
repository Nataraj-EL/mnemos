import { NextRequest, NextResponse } from 'next/server';
import { EvaluationRemediationProposalManager } from '@/evaluation/remediationProposal';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Remediation proposals endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const proposals = EvaluationRemediationProposalManager.listProposals();
    return NextResponse.json({
      proposals,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error('Proposals GET Error:', error);
    return NextResponse.json({ error: 'Failed to retrieve proposals.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Remediation proposals endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    if (!body || !body.alertId || !body.action) {
      return NextResponse.json({ error: 'Missing remediation fields.' }, { status: 400 });
    }

    const proposal = EvaluationRemediationProposalManager.createProposal(body);
    return NextResponse.json(proposal);
  } catch (error: unknown) {
    console.error('Proposals POST Error:', error);
    return NextResponse.json({ error: 'Failed to create proposal.' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Remediation proposals endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const { id, action } = body || {};
    if (!id || !action || (action !== 'approve' && action !== 'reject')) {
      return NextResponse.json({ error: 'Invalid or missing parameters.' }, { status: 400 });
    }

    const proposal = EvaluationRemediationProposalManager.getProposal(id);
    if (!proposal) {
      return NextResponse.json({ error: 'Proposal not found.' }, { status: 404 });
    }

    let success = false;
    if (action === 'approve') {
      success = EvaluationRemediationProposalManager.approve(id);
    } else if (action === 'reject') {
      success = EvaluationRemediationProposalManager.reject(id);
    }

    if (!success) {
      return NextResponse.json({ error: 'Invalid transition state.' }, { status: 400 });
    }

    return NextResponse.json(EvaluationRemediationProposalManager.getProposal(id));
  } catch (error: unknown) {
    console.error('Proposals PATCH Error:', error);
    return NextResponse.json({ error: 'Failed to update proposal status.' }, { status: 500 });
  }
}

export async function DELETE() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Remediation proposals endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    EvaluationRemediationProposalManager.clearProposals();
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('Proposals DELETE Error:', error);
    return NextResponse.json({ error: 'Failed to clear proposals.' }, { status: 500 });
  }
}
