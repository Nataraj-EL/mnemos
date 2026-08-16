import { NextResponse } from 'next/server';
import { ConfigSafetyGuard } from '@/evaluation/configGuard';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Config validation endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const { config } = body;

    if (!config) {
      return NextResponse.json(
        {
          valid: false,
          errors: ['Missing configuration payload in request body.'],
          warnings: [],
        },
        { status: 400 }
      );
    }

    const check = ConfigSafetyGuard.validate(config);
    return NextResponse.json(check);
  } catch (error: unknown) {
    console.error('Config Validation POST Error:', error);
    return NextResponse.json(
      {
        valid: false,
        errors: [error instanceof Error ? error.message : 'Malformed configuration payload.'],
        warnings: [],
      },
      { status: 400 }
    );
  }
}
