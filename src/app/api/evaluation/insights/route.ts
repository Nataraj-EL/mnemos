import { NextResponse } from 'next/server';
import { EvaluationInsightsManager } from '@/evaluation/insights';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Insights endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const insights = EvaluationInsightsManager.generateInsights();
    return NextResponse.json(insights);
  } catch (error) {
    console.error('Insights Route GET Error:', error);
    return NextResponse.json(
      { error: 'An error occurred while generating evaluation insights.' },
      { status: 500 }
    );
  }
}
