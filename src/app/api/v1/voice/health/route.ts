import { NextResponse } from 'next/server';
import { LocalWhisperTranscriptionProvider } from '@/voice/localWhisperTranscription';
import { voiceDiagnostics } from '@/voice/voiceDiagnostics';

export const dynamic = 'force-dynamic';

const SUPPORTED_MIME_TYPES = [
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/webm',
  'audio/m4a',
  'audio/x-m4a',
  'audio/mp4',
  'audio/flac',
];

export async function GET() {
  if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
    return NextResponse.json(
      { status: 'error', error: 'Forbidden: Endpoint is only available in development environment.' },
      { status: 403 }
    );
  }

  try {
    const provider = process.env.WHISPER_PROVIDER === 'cloud' ? 'cloud' : 'local';
    
    let localWhisperAvailable = false;
    let daemonState: 'ready' | 'loading' | 'error' | 'none' | 'forbidden' = 'none';

    try {
      const localProvider = new LocalWhisperTranscriptionProvider();
      const status = await localProvider.getStatus();
      localWhisperAvailable = status.healthy;
      daemonState = status.status as 'ready' | 'loading' | 'error' | 'none' | 'forbidden';
    } catch (e) {
      console.error('Error checking local Whisper status:', e);
      daemonState = 'error';
    }

    const healthInfo = {
      provider,
      localWhisperAvailable,
      daemonState,
      supportedMimeTypes: SUPPORTED_MIME_TYPES,
      lastFailureCategory: voiceDiagnostics.getLastFailureCategory(),
      latestRequest: voiceDiagnostics.getLatest(),
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json({
      status: 'success',
      data: healthInfo,
    });
  } catch (error: unknown) {
    console.error('Voice health endpoint failure:', error);
    return NextResponse.json(
      { status: 'error', error: 'An unexpected error occurred while compiling voice health.' },
      { status: 500 }
    );
  }
}
