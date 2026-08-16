import { NextRequest, NextResponse } from 'next/server';
import { EvaluationAlertHistoryManager } from '@/evaluation/alertHistory';
import { EvaluationAlertManager } from '@/evaluation/alerts';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation alerts history endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const activeSummary = await EvaluationAlertManager.generateAlerts();

    for (const alert of activeSummary.alerts) {
      EvaluationAlertHistoryManager.addAlertRecord(alert);
    }

    const records = EvaluationAlertHistoryManager.listAlerts();

    let openCount = 0;
    let acknowledgedCount = 0;
    let resolvedCount = 0;

    for (const rec of records) {
      if (rec.status === 'open') openCount++;
      else if (rec.status === 'acknowledged') acknowledgedCount++;
      else if (rec.status === 'resolved') resolvedCount++;
    }

    return NextResponse.json({
      records,
      timestamp: new Date().toISOString(),
      openCount,
      acknowledgedCount,
      resolvedCount,
    });
  } catch (error: unknown) {
    console.error('Alert History GET Error:', error);
    return NextResponse.json({ error: 'Failed to fetch alert history.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation alerts history endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const { id, action } = await req.json();
    if (!id || !action) {
      return NextResponse.json({ error: 'Missing id or action payload.' }, { status: 400 });
    }

    const records = EvaluationAlertHistoryManager.listAlerts();
    const exists = records.some((r) => r.id === id);
    if (!exists) {
      return NextResponse.json({ error: 'Alert record not found.' }, { status: 404 });
    }

    let success = false;
    if (action === 'acknowledge') {
      success = EvaluationAlertHistoryManager.acknowledge(id);
    } else if (action === 'resolve') {
      success = EvaluationAlertHistoryManager.resolve(id);
    } else if (action === 'reopen') {
      success = EvaluationAlertHistoryManager.reopen(id);
    } else {
      return NextResponse.json({ error: `Invalid action: ${action}.` }, { status: 400 });
    }

    if (!success) {
      return NextResponse.json({ error: 'Invalid lifecycle transition.' }, { status: 400 });
    }

    return NextResponse.json({ success: true, id, action });
  } catch (error: unknown) {
    console.error('Alert History POST Error:', error);
    return NextResponse.json({ error: 'Failed to update alert state.' }, { status: 500 });
  }
}

export async function DELETE() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Evaluation alerts history endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  EvaluationAlertHistoryManager.clearHistory();
  return NextResponse.json({ success: true, cleared: true });
}
