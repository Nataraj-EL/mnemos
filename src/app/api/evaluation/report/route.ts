import { NextResponse } from 'next/server';
import { EvaluationReportManager } from '@/evaluation/report';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation report endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const report = await EvaluationReportManager.generateReport();
    return NextResponse.json(report);
  } catch (error: unknown) {
    console.error('Evaluation Report GET Error:', error);
    return NextResponse.json({ error: 'Failed to generate evaluation report.' }, { status: 500 });
  }
}
