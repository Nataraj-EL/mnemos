import { NextResponse } from 'next/server';
import { EvaluationQualityGateManager } from '@/evaluation/qualityGate';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Quality gate endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const result = await EvaluationQualityGateManager.evaluateGate();
    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error('Quality Gate GET Error:', error);
    return NextResponse.json({ error: 'Failed to evaluate release quality gate.' }, { status: 500 });
  }
}
