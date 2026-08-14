import { NextResponse } from 'next/server';
import { testConnection } from '@/db';

// Ensure the health check is always run dynamically and not cached
export const dynamic = 'force-dynamic';

export async function GET() {
  const dbConnected = await testConnection();

  const status = dbConnected ? 'healthy' : 'unhealthy';
  const statusCode = dbConnected ? 200 : 503;

  return NextResponse.json(
    {
      status,
      timestamp: new Date().toISOString(),
      services: {
        app: 'running',
        database: dbConnected ? 'connected' : 'disconnected',
      },
    },
    {
      status: statusCode,
    }
  );
}
