import { NextResponse } from 'next/server';
import { EvaluationHistoryManager } from '@/evaluation/history';
import { compareSummaries } from '@/evaluation/regression';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'History endpoint is only available in development environment.' },
      { status: 403 }
    );
  }
  return NextResponse.json(EvaluationHistoryManager.listRuns());
}

export async function DELETE(request: Request) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'History endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (id) {
    const deleted = EvaluationHistoryManager.deleteRun(id);
    return NextResponse.json({ success: deleted });
  } else {
    EvaluationHistoryManager.clearHistory();
    return NextResponse.json({ success: true });
  }
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'History endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const { baseRunId, targetRunId } = body || {};

    if (!baseRunId || !targetRunId) {
      return NextResponse.json({ error: 'Missing baseRunId or targetRunId.' }, { status: 400 });
    }

    const baseRecord = EvaluationHistoryManager.getRun(baseRunId);
    const targetRecord = EvaluationHistoryManager.getRun(targetRunId);

    if (!baseRecord || !targetRecord) {
      return NextResponse.json({ error: 'One or both runs not found in history.' }, { status: 404 });
    }

    const comparison = compareSummaries(targetRecord.summary, baseRecord.summary);
    return NextResponse.json({
      baseRunId,
      targetRunId,
      comparison,
    });
  } catch (error) {
    console.error('History Route POST Error:', error);
    return NextResponse.json(
      { error: 'An error occurred during run comparison.' },
      { status: 500 }
    );
  }
}
