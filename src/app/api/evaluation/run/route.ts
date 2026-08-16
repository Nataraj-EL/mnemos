import { NextResponse } from 'next/server';
import { EvaluationRunner } from '@/evaluation/runner';
import { BaselineManager, compareSummaries } from '@/evaluation/regression';

export const dynamic = 'force-dynamic';

export async function POST() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const runner = new EvaluationRunner();
    const result = await runner.runAll();

    const baseline = BaselineManager.getBaseline();
    const regression = compareSummaries(result.summary, baseline);

    // Save as baseline if none exists
    if (!baseline) {
      BaselineManager.setBaseline(result.summary);
    }

    // Attach regression summary to the response
    const summaryWithRegression = {
      ...result.summary,
      regression,
    };

    return NextResponse.json({
      results: result.results,
      summary: summaryWithRegression,
    });
  } catch (error) {
    console.error('Evaluation Route Execution Error:', error);
    return NextResponse.json(
      { error: 'An error occurred during evaluation suite execution.' },
      { status: 500 }
    );
  }
}
