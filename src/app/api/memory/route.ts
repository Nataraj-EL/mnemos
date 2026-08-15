import { NextResponse } from 'next/server';
import { PgMemoryRepository } from '@/memory/repository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');
    const conversationId = searchParams.get('conversationId');

    if (!userId || !userId.trim()) {
      return NextResponse.json(
        { error: 'Missing or invalid parameter: userId is required.' },
        { status: 400 }
      );
    }

    const repository = new PgMemoryRepository();
    const filter: { userId?: string; conversationId?: string } = { userId: userId.trim() };
    if (conversationId && conversationId.trim()) {
      filter.conversationId = conversationId.trim();
    }
    const memories = await repository.list(filter);

    return NextResponse.json({
      status: 'success',
      memories,
    });
  } catch (error: unknown) {
    console.error('Fetch Memories API Error:', error);
    return NextResponse.json(
      { error: 'An error occurred while retrieving memories.' },
      { status: 500 }
    );
  }
}
