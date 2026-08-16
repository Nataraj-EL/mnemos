import { NextResponse } from 'next/server';
import { EvaluationRecommendationsManager } from '@/evaluation/recommendations';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Recommendations endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const recommendations = EvaluationRecommendationsManager.generateRecommendations();
    return NextResponse.json({ recommendations });
  } catch (error) {
    console.error('Recommendations Route GET Error:', error);
    return NextResponse.json(
      { error: 'An error occurred while generating evaluation recommendations.' },
      { status: 500 }
    );
  }
}
