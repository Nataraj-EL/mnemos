import { NextRequest, NextResponse } from 'next/server';
import { EvaluationReportHistoryManager } from '@/evaluation/reportHistory';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation report history endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const { baseReportId, targetReportId } = await req.json();
    if (!baseReportId || !targetReportId) {
      return NextResponse.json({ error: 'Missing baseReportId or targetReportId payload.' }, { status: 400 });
    }

    const comparison = EvaluationReportHistoryManager.compareReports(baseReportId, targetReportId);
    return NextResponse.json(comparison);
  } catch (error: unknown) {
    console.error('Report Comparison POST Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to compare reports.' },
      { status: 500 }
    );
  }
}
