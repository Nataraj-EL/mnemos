import { NextResponse } from 'next/server';
import { EvaluationRemediationExecutionManager } from '@/evaluation/remediationExecution';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Remediation executions endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const records = EvaluationRemediationExecutionManager.listExecutions();
    return NextResponse.json({
      records,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error('Executions GET Error:', error);
    return NextResponse.json({ error: 'Failed to retrieve execution records.' }, { status: 500 });
  }
}

export async function DELETE() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Remediation executions endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    EvaluationRemediationExecutionManager.clearHistory();
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('Executions DELETE Error:', error);
    return NextResponse.json({ error: 'Failed to clear execution history.' }, { status: 500 });
  }
}
