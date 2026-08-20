import { NextRequest, NextResponse } from 'next/server';
import { getDbPool } from '@/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // 1. Gating environment
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    return NextResponse.json(
      { error: 'Endpoint is only available in development/testing environment.' },
      { status: 403 }
    );
  }

  try {
    // 2. Enforce user isolation: require userId
    const url = new URL(req.url);
    const userId = url.searchParams.get('userId')?.trim();

    if (!userId) {
      return NextResponse.json(
        { error: 'Missing parameter: userId is required for user isolation.' },
        { status: 400 }
      );
    }

    const pool = getDbPool();
    // 3. Query only target user's voice memories
    const query = `
      SELECT id, user_id as "userId", type, content, metadata, created_at as "createdAt", updated_at as "updatedAt"
      FROM memories
      WHERE user_id = $1 AND (metadata->>'source' = 'voice' OR metadata->>'sourceType' = 'voice')
      ORDER BY created_at DESC;
    `;
    const result = await pool.query(query, [userId]);

    // 4. Return strictly sanitized fields
    const sanitizedMemories = result.rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      type: row.type,
      content: row.content,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      metadata: {
        source: row.metadata?.source || row.metadata?.sourceType || 'voice',
        confidence: row.metadata?.confidence ?? 0.8,
        importance: row.metadata?.importance ?? 5,
        status: row.metadata?.status || 'active',
        createdAt: row.metadata?.createdAt || row.createdAt,
      },
    }));

    return NextResponse.json({
      status: 'success',
      memories: sanitizedMemories,
    });
  } catch (error: unknown) {
    console.error('GET voice memories error:', error);
    return NextResponse.json(
      { error: 'Failed to retrieve voice memories.' },
      { status: 500 }
    );
  }
}
