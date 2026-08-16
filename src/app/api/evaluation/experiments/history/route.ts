import { NextResponse } from 'next/server';
import { ExperimentHistoryManager } from '@/evaluation/experimentHistory';
import { compareSummaries } from '@/evaluation/regression';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Experiment history endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const list = ExperimentHistoryManager.listRecords();
    return NextResponse.json(list);
  } catch (error: unknown) {
    console.error('Experiment History GET Error:', error);
    return NextResponse.json({ error: 'Failed to fetch experiment history.' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Experiment history endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (id) {
      const deleted = ExperimentHistoryManager.deleteRecord(id);
      return NextResponse.json({ success: deleted });
    } else {
      ExperimentHistoryManager.clearHistory();
      return NextResponse.json({ success: true });
    }
  } catch (error: unknown) {
    console.error('Experiment History DELETE Error:', error);
    return NextResponse.json({ error: 'Failed to delete experiment history.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Experiment history endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const { baseExperimentId, targetExperimentId } = body;

    if (!baseExperimentId || !targetExperimentId) {
      return NextResponse.json(
        { error: 'Missing baseExperimentId or targetExperimentId in request body.' },
        { status: 400 }
      );
    }

    if (baseExperimentId === targetExperimentId) {
      return NextResponse.json(
        { error: 'Cannot compare an experiment with itself. baseExperimentId and targetExperimentId must be distinct.' },
        { status: 400 }
      );
    }

    const baseRecord = ExperimentHistoryManager.getRecord(baseExperimentId);
    const targetRecord = ExperimentHistoryManager.getRecord(targetExperimentId);

    if (!baseRecord) {
      return NextResponse.json(
        { error: `Control base experiment record '${baseExperimentId}' not found in history.` },
        { status: 400 }
      );
    }

    if (!targetRecord) {
      return NextResponse.json(
        { error: `Target experiment record '${targetExperimentId}' not found in history.` },
        { status: 400 }
      );
    }

    const comparison = compareSummaries(targetRecord.candidateSummary, baseRecord.candidateSummary);

    return NextResponse.json({ comparison });
  } catch (error: unknown) {
    console.error('Experiment History POST Error:', error);
    const msg = error instanceof Error ? error.message : 'Failed to compare historical experiments.';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
