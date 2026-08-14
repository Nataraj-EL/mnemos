import { NextResponse } from 'next/server';
import { EvaluationRunner } from '@/evaluation/runner';

export const dynamic = 'force-dynamic';

export async function POST() {
  // Safe evaluation runner: protect production environments from running expensive/arbitrary calls
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const runner = new EvaluationRunner();
    const result = await runner.runAll();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Evaluation Route Execution Error:', error);
    return NextResponse.json(
      { error: 'An error occurred during evaluation suite execution.' },
      { status: 500 }
    );
  }
}
