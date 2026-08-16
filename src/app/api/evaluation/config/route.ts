import { NextResponse } from 'next/server';
import { EvaluationConfigPromotionManager } from '@/evaluation/promotion';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Promotion endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const currentConfig = EvaluationConfigPromotionManager.getCurrentConfig();
    const previousConfig = EvaluationConfigPromotionManager.getPreviousConfig();
    const hasPromoted = EvaluationConfigPromotionManager.hasPromotedConfig();

    return NextResponse.json({
      hasPromotedConfig: hasPromoted,
      currentConfig,
      previousConfig,
    });
  } catch (error: unknown) {
    console.error('Promotion GET Error:', error);
    return NextResponse.json({ error: 'Failed to fetch promoted config status.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Promotion endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const { config } = body;

    if (!config) {
      return NextResponse.json({ error: 'Missing configuration in request body.' }, { status: 400 });
    }

    EvaluationConfigPromotionManager.promote(config);

    return NextResponse.json({
      success: true,
      hasPromotedConfig: true,
      currentConfig: EvaluationConfigPromotionManager.getCurrentConfig(),
      previousConfig: EvaluationConfigPromotionManager.getPreviousConfig(),
    });
  } catch (error: unknown) {
    console.error('Promotion POST Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred during configuration promotion.';
    const status = errorMessage.includes('Invalid configuration') ? 400 : 500;
    return NextResponse.json({ error: errorMessage }, { status });
  }
}

export async function DELETE() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Promotion endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const previousConfig = EvaluationConfigPromotionManager.getPreviousConfig();
    if (!previousConfig) {
      return NextResponse.json({ error: 'No previous configuration available to rollback.' }, { status: 409 });
    }

    EvaluationConfigPromotionManager.rollback();

    return NextResponse.json({
      success: true,
      hasPromotedConfig: EvaluationConfigPromotionManager.hasPromotedConfig(),
      currentConfig: EvaluationConfigPromotionManager.getCurrentConfig(),
      previousConfig: null,
    });
  } catch (error: unknown) {
    console.error('Promotion DELETE Error:', error);
    return NextResponse.json({ error: 'Failed to rollback configuration.' }, { status: 500 });
  }
}
