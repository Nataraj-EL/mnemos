import { NextResponse } from 'next/server';
import { EvaluationRemediationOutcomeManager } from '@/evaluation/remediationOutcome';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Remediation outcome verification endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const outcomes = EvaluationRemediationOutcomeManager.generateOutcomes();
    return NextResponse.json({
      outcomes,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error('Outcomes GET Error:', error);
    return NextResponse.json({ error: 'Failed to generate outcome verifications.' }, { status: 500 });
  }
}
