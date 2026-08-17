import { NextRequest, NextResponse } from 'next/server';
import { EvaluationRemediationExecutionManager } from '@/evaluation/remediationExecution';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Remediation rollback endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const { id } = body || {};
    if (!id) {
      return NextResponse.json({ error: 'Missing execution ID.' }, { status: 400 });
    }

    const execution = EvaluationRemediationExecutionManager.getExecution(id);
    if (!execution) {
      return NextResponse.json({ error: 'Execution record not found.' }, { status: 404 });
    }

    if (execution.status !== 'success') {
      return NextResponse.json({ error: 'Only successful executions can be rolled back.' }, { status: 400 });
    }

    const success = EvaluationRemediationExecutionManager.rollback(id);
    if (!success) {
      return NextResponse.json({ error: 'Rollback operation failed.' }, { status: 400 });
    }

    return NextResponse.json(EvaluationRemediationExecutionManager.getExecution(id));
  } catch (error: unknown) {
    console.error('Execution Rollback POST Error:', error);
    return NextResponse.json({ error: 'Failed to perform rollback operation.' }, { status: 500 });
  }
}
