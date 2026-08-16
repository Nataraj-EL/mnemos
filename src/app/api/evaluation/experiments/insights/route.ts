import { NextResponse } from 'next/server';
import { ExperimentInsightsManager } from '@/evaluation/experimentInsights';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Experiment insights endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const insights = ExperimentInsightsManager.generateInsights();
    return NextResponse.json(insights);
  } catch (error: unknown) {
    console.error('Experiment Insights GET Error:', error);
    return NextResponse.json({
      insufficientHistory: true,
      totalExperiments: 0,
      controlWins: 0,
      candidateWins: 0,
      draws: 0,
      bestConfig: null,
      bestConfigSource: null,
      averageDeltas: {},
      improvingMetrics: [],
      degradingMetrics: [],
    });
  }
}
