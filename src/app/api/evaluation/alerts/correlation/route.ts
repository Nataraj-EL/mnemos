import { NextRequest, NextResponse } from 'next/server';
import { EvaluationAlertCorrelationManager } from '@/evaluation/alertCorrelation';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation alerts correlation endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const includeResolved = searchParams.get('includeResolved') === 'true';

    const correlations = await EvaluationAlertCorrelationManager.correlateAlerts(includeResolved);
    return NextResponse.json({
      correlations,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error('Alert Correlation GET Error:', error);
    return NextResponse.json({ error: 'Failed to compute root-cause correlations.' }, { status: 500 });
  }
}
