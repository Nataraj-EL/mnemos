import { NextResponse } from 'next/server';
import { BaselineManager } from '@/evaluation/regression';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Baseline endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid summary payload.' }, { status: 400 });
    }

    BaselineManager.setBaseline(body);
    return NextResponse.json({
      success: true,
      label: BaselineManager.getLabel(),
    });
  } catch (error) {
    console.error('Baseline Route Execution Error:', error);
    return NextResponse.json(
      { error: 'An error occurred while updating baseline.' },
      { status: 500 }
    );
  }
}
