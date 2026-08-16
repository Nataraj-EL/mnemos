import { NextResponse } from 'next/server';
import { EvaluationRemediationManager } from '@/evaluation/remediation';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation remediation endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const remediations = await EvaluationRemediationManager.generateRemediations();
    return NextResponse.json({
      remediations,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error('Evaluation Remediation GET Error:', error);
    return NextResponse.json({ error: 'Failed to generate remediation recommendations.' }, { status: 500 });
  }
}
