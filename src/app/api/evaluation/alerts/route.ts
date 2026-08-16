import { NextResponse } from 'next/server';
import { EvaluationAlertManager } from '@/evaluation/alerts';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation alerts endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const summary = await EvaluationAlertManager.generateAlerts();
    return NextResponse.json(summary);
  } catch (error: unknown) {
    console.error('Evaluation Alerts GET Error:', error);
    return NextResponse.json({ error: 'Failed to generate evaluation alerts.' }, { status: 500 });
  }
}
