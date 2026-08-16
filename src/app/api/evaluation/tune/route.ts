import { NextResponse } from 'next/server';
import { TuningRunner, getIsTuningActive } from '@/evaluation/tuner';

export const dynamic = 'force-dynamic';

export async function POST() {
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

  try {
    const tuner = new TuningRunner();
    const result = await tuner.runTuning();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Parameter Tuning Route Execution Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'An error occurred during matrix tuning.' },
      { status: 500 }
    );
  }
}
