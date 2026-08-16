import { NextResponse } from 'next/server';
import { EvaluationExperimentRunner } from '@/evaluation/experiment';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Experimentation endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const { controlConfig, candidateConfig } = body;

    if (!controlConfig || !candidateConfig) {
      return NextResponse.json(
        { error: 'Missing controlConfig or candidateConfig in request body.' },
        { status: 400 }
      );
    }

    EvaluationExperimentRunner.validateConfig(controlConfig);
    EvaluationExperimentRunner.validateConfig(candidateConfig);

    const result = await EvaluationExperimentRunner.runExperiment(controlConfig, candidateConfig);
    return NextResponse.json(result);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred during the A/B experiment.';
    console.error('Experiment Route POST Error:', error);
    
    const status = (errorMessage.includes('Invalid configuration') || errorMessage.includes('Missing')) ? 400
                 : errorMessage.includes('already in progress') ? 409
                 : 500;

    return NextResponse.json({ error: errorMessage }, { status });
  }
}
