import { NextRequest, NextResponse } from 'next/server';
import { TuningRunner, getIsTuningActive } from '@/evaluation/tuner';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // Developer authorization boundary: protect non-development/production environments
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  if (getIsTuningActive()) {
    return NextResponse.json(
      { error: 'A parameter tuning benchmark run is already in progress.' },
      { status: 429 }
    );
  }

  let benchmarkMode: 'mock' | 'real' = 'real';
  try {
    const body = await req.json();
    if (body?.benchmarkMode === 'mock' || body?.benchmarkMode === 'real') {
      benchmarkMode = body.benchmarkMode;
    }
  } catch {
    // Default to 'real' if body is missing or malformed
  }

  try {
    const tuner = new TuningRunner();
    const result = await tuner.runTuning(undefined, undefined, benchmarkMode);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Parameter Tuning Route Execution Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'An error occurred during matrix tuning.' },
      { status: 500 }
    );
  }
}
