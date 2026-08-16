import { NextResponse } from 'next/server';
import { EvaluationReportInsightsManager } from '@/evaluation/reportInsights';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation report insights endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const insights = await EvaluationReportInsightsManager.generateInsights();
    return NextResponse.json(insights);
  } catch (error: unknown) {
    console.error('Evaluation Report Insights GET Error:', error);
    return NextResponse.json({ error: 'Failed to generate report insights.' }, { status: 500 });
  }
}
