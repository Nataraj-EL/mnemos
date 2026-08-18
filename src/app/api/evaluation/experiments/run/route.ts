import { NextResponse } from 'next/server';
import { EvaluationExperimentRunner } from '@/evaluation/experiment';
import { ExperimentHistoryManager } from '@/evaluation/experimentHistory';
import { EvaluationConfigPromotionManager } from '@/evaluation/promotion';
import { ConfigSafetyGuard } from '@/evaluation/configGuard';
import { TuningConfig } from '@/evaluation/types';

export const dynamic = 'force-dynamic';

const DEFAULT_CONFIG: TuningConfig = {
  semanticWeight: 0.7,
  lexicalWeight: 0.3,
  minSimilarity: 0.5,
  diversityThreshold: 0.3,
  maxConversationSnippets: 10,
};

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    return NextResponse.json(
      { error: 'Forbidden: Experimentation endpoint is only available in development or testing environment.' },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const { candidateConfig, baselineConfig: inputBaselineConfig, evidenceIds = [] } = body;

    if (!candidateConfig) {
      return NextResponse.json(
        { error: 'Missing candidateConfig in request body.' },
        { status: 400 }
      );
    }

    // 1. Safety Validation of candidate
    const safetyCheck = ConfigSafetyGuard.validate(candidateConfig);
    if (!safetyCheck.valid) {
      return NextResponse.json(
        { error: `Invalid candidate configuration: ${safetyCheck.errors.join(', ')}` },
        { status: 400 }
      );
    }

    // 2. Resolve baseline config
    const baselineConfig = inputBaselineConfig || EvaluationConfigPromotionManager.getCurrentConfig() || DEFAULT_CONFIG;

    // 3. Validate baseline format just to be safe
    try {
      EvaluationExperimentRunner.validateConfig(baselineConfig);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        { error: `Invalid baseline configuration: ${msg}` },
        { status: 400 }
      );
    }

    // 4. Run A/B experiment
    const result = await EvaluationExperimentRunner.runControlledExperiment(
      baselineConfig,
      candidateConfig,
      evidenceIds
    );

    // 5. Save to history
    ExperimentHistoryManager.addControlledRecord(result);

    return NextResponse.json({
      status: 'success',
      data: result,
    });
  } catch (error: unknown) {
    console.error('Controlled Experiment Run POST Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred during experiment run.';
    const status = errorMessage.includes('already in progress') ? 409 : 500;
    return NextResponse.json({ error: errorMessage }, { status });
  }
}
