import { NextResponse } from 'next/server';
import { testConnection } from '@/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const requestId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'req-' + Date.now();

  try {
    const dbConnected = await testConnection();
    const hasGeminiKey = !!process.env.GEMINI_API_KEY;

    const data = {
      service: 'healthy',
      database: dbConnected ? 'healthy' : 'unhealthy',
      provider: hasGeminiKey ? 'healthy' : 'unhealthy',
      authEnabled: process.env.MNEMOS_AUTH_ENABLED === 'true',
      rateLimitMax: Number(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
      rateLimitWindow: Number(process.env.RATE_LIMIT_WINDOW_SECONDS || '60'),
    };

    if (!dbConnected) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Database connection is unavailable.',
          data,
          requestId,
        },
        { status: 503 }
      );
    }

    if (!hasGeminiKey) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Gemini API key is not configured.',
          data,
          requestId,
        },
        { status: 503 }
      );
    }

    return NextResponse.json({
      status: 'success',
      data,
      requestId,
    });
  } catch {
    return NextResponse.json(
      {
        status: 'error',
        error: 'An unexpected system health check error occurred.',
        requestId,
      },
      { status: 500 }
    );
  }
}
