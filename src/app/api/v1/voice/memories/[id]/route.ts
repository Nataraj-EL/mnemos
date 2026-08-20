import { NextRequest, NextResponse } from 'next/server';
import { PgMemoryRepository } from '@/memory/repository';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // 1. Gating environment
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    return NextResponse.json(
      { error: 'Endpoint is only available in development/testing environment.' },
      { status: 403 }
    );
  }

  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Missing parameter: id is required.' }, { status: 400 });
    }

    const repository = new PgMemoryRepository();
    const memory = await repository.get(id);

    // 2. Allow deletion only when memory exists and metadata.source/sourceType is voice
    if (!memory) {
      return NextResponse.json({ error: 'Voice memory not found.' }, { status: 404 });
    }

    const isVoice = memory.metadata?.source === 'voice' || memory.metadata?.sourceType === 'voice';
    if (!isVoice) {
      return NextResponse.json({ error: 'Forbidden: Selected memory is not a voice memory.' }, { status: 404 });
    }

    // 3. Delete memory
    await repository.delete(id);

    return NextResponse.json({
      status: 'success',
      message: 'Voice memory deleted successfully.',
    });
  } catch (error: unknown) {
    console.error('DELETE voice memory error:', error);
    return NextResponse.json(
      { error: 'Failed to delete voice memory.' },
      { status: 500 }
    );
  }
}
