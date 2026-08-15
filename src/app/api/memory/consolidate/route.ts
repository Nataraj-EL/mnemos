import { NextResponse } from 'next/server';
import { PgMemoryRepository } from '@/memory/repository';
import { MemoryConsolidationService } from '@/memory/consolidationService';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { userId } = body;

    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return NextResponse.json(
        { error: 'Missing or invalid parameter: userId is required.' },
        { status: 400 }
      );
    }

    const repository = new PgMemoryRepository();
    const service = new MemoryConsolidationService(repository);

    const result = await service.consolidate(userId);

    return NextResponse.json({
      status: 'success',
      consolidatedCount: result.consolidatedCount,
      actions: result.actions,
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : 'Internal server error during consolidation.';
    console.error('Memory consolidation endpoint failed:', error);
    return NextResponse.json(
      { error: errMsg },
      { status: 500 }
    );
  }
}
