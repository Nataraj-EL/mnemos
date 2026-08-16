import { NextResponse } from 'next/server';
import { PromotionHistoryManager } from '@/evaluation/promotionHistory';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Promotion history endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const history = PromotionHistoryManager.listRecords();
    return NextResponse.json(history);
  } catch (error: unknown) {
    console.error('Promotion History GET Error:', error);
    return NextResponse.json({ error: 'Failed to fetch promotion history.' }, { status: 500 });
  }
}

export async function DELETE() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Promotion history endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    PromotionHistoryManager.clearHistory();
    return NextResponse.json({ success: true, history: [] });
  } catch (error: unknown) {
    console.error('Promotion History DELETE Error:', error);
    return NextResponse.json({ error: 'Failed to clear promotion history.' }, { status: 500 });
  }
}
