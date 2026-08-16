import { NextRequest, NextResponse } from 'next/server';
import { EvaluationReportHistoryManager } from '@/evaluation/reportHistory';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation report history endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  const reports = EvaluationReportHistoryManager.listReports();
  return NextResponse.json(reports);
}

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation report history endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const { report } = await req.json();
    if (!report) {
      return NextResponse.json({ error: 'Missing report payload in body.' }, { status: 400 });
    }
    const record = EvaluationReportHistoryManager.addReport(report);
    return NextResponse.json(record, { status: 201 });
  } catch (error: unknown) {
    console.error('Report History POST Error:', error);
    return NextResponse.json({ error: 'Failed to save report to history.' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation report history endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (id) {
    const deleted = EvaluationReportHistoryManager.deleteReport(id);
    if (!deleted) {
      return NextResponse.json({ error: `Report record with ID ${id} not found.` }, { status: 404 });
    }
    return NextResponse.json({ success: true, deletedId: id });
  } else {
    EvaluationReportHistoryManager.clearHistory();
    return NextResponse.json({ success: true, cleared: true });
  }
}
