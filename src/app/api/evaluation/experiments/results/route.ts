import { NextResponse } from 'next/server';
import { ExperimentHistoryManager } from '@/evaluation/experimentHistory';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    return NextResponse.json(
      { error: 'Forbidden: Endpoint is only available in development or testing environment.' },
      { status: 403 }
    );
  }

  try {
    const list = ExperimentHistoryManager.listControlledRecords();
    return NextResponse.json({
      status: 'success',
      data: list,
    });
  } catch (error: unknown) {
    console.error('Controlled Results GET Error:', error);
    return NextResponse.json({ error: 'Failed to fetch experiment results.' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    return NextResponse.json(
      { error: 'Forbidden: Endpoint is only available in development or testing environment.' },
      { status: 403 }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (id) {
      const deleted = ExperimentHistoryManager.deleteControlledRecord(id);
      return NextResponse.json({ status: 'success', success: deleted });
    } else {
      ExperimentHistoryManager.clearControlledHistory();
      return NextResponse.json({ status: 'success', success: true });
    }
  } catch (error: unknown) {
    console.error('Controlled Results DELETE Error:', error);
    return NextResponse.json({ error: 'Failed to delete experiment results.' }, { status: 500 });
  }
}
