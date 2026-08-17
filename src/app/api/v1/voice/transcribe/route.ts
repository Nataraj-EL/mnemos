import { NextResponse } from 'next/server';
import { WhisperTranscriptionProvider } from '@/voice/whisperTranscription';
import { LocalWhisperTranscriptionProvider } from '@/voice/localWhisperTranscription';
import { logTelemetry } from '@/core/logger';
import { voiceDiagnostics } from '@/voice/voiceDiagnostics';
import {
  authenticate,
  checkRateLimit,
  checkRequestSize,
} from '@/memory/security';

export const dynamic = 'force-dynamic';

const MAX_AUDIO_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

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

export async function POST(request: Request) {
  const requestId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'req-' + Date.now();
  const startTime = Date.now();
  let audioBuffer: Buffer | null = null;
  let baseMime = 'unknown';

  try {
    // 1. Defend request size limits
    if (!checkRequestSize(request.headers, MAX_AUDIO_SIZE_BYTES)) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Payload Too Large: Request body size limit of 10 MB exceeded.',
          requestId,
        },
        { status: 413 }
      );
    }

    // 2. Authentication check
    const authResult = authenticate(request.headers);
    if (!authResult.authenticated) {
      return NextResponse.json(
        {
          status: 'error',
          error: authResult.error || 'Unauthorized: Missing or invalid API key.',
          requestId,
        },
        { status: 401 }
      );
    }

    // 3. Sliding window Rate Limiter
    const rateLimitMax = Number(process.env.RATE_LIMIT_MAX_REQUESTS || '100');
    const rateLimitWindow = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || '60');
    const clientIp = request.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateLimitResult = checkRateLimit(clientIp, rateLimitMax, rateLimitWindow);
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Too Many Requests: Rate limit exceeded. Try again later.',
          requestId,
        },
        { status: 429 }
      );
    }

    // 4. Parse request content-type and extract audio buffer
    const contentType = request.headers.get('content-type') || '';
    let mimeType: string | undefined = undefined;

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData().catch(() => null);
      if (!formData) {
        return NextResponse.json(
          { status: 'error', error: 'Malformed multipart form data.', requestId },
          { status: 400 }
        );
      }

      const file = formData.get('file');
      if (!file || !(file instanceof Blob)) {
        return NextResponse.json(
          { status: 'error', error: 'Missing or empty parameter: file is required.', requestId },
          { status: 400 }
        );
      }

      mimeType = file.type || 'audio/wav';
      
      const arrayBuffer = await file.arrayBuffer().catch(() => null);
      if (!arrayBuffer) {
        return NextResponse.json(
          { status: 'error', error: 'Failed to read audio file bytes.', requestId },
          { status: 400 }
        );
      }
      audioBuffer = Buffer.from(arrayBuffer);
    } else {
      // Direct raw binary upload
      mimeType = contentType.split(';')[0].trim();
      baseMime = mimeType.toLowerCase();
      const arrayBuffer = await request.arrayBuffer().catch(() => null);
      if (!arrayBuffer) {
        return NextResponse.json(
          { status: 'error', error: 'Failed to read request body bytes.', requestId },
          { status: 400 }
        );
      }
      audioBuffer = Buffer.from(arrayBuffer);
    }

    // 5. Audio Validations
    if (!audioBuffer || audioBuffer.length === 0) {
      return NextResponse.json(
        { status: 'error', error: 'Missing or empty parameter: audio payload cannot be empty.', requestId },
        { status: 400 }
      );
    }

    if (audioBuffer.length > MAX_AUDIO_SIZE_BYTES) {
      return NextResponse.json(
        { status: 'error', error: 'Payload Too Large: Audio size limit of 10 MB exceeded.', requestId },
        { status: 413 }
      );
    }

    // supported MIME type check
    const normalizedMime = mimeType ? mimeType.toLowerCase() : '';
    baseMime = normalizedMime.split(';')[0].trim();
    if (!SUPPORTED_MIME_TYPES.includes(baseMime)) {
      return NextResponse.json(
        { status: 'error', error: `Unsupported MIME type: "${mimeType}". Only audio formats (WAV, MP3, WebM, etc.) are supported.`, requestId },
        { status: 415 } // 415 Unsupported Media Type
      );
    }

    // 6. Execute Transcription Provider
    const provider = process.env.WHISPER_PROVIDER === 'cloud'
      ? new WhisperTranscriptionProvider()
      : new LocalWhisperTranscriptionProvider();
    const result = await provider.transcribe(audioBuffer, normalizedMime);

    // Empty transcript check
    if (!result.text || !result.text.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Empty transcription: No text could be extracted from this audio.', requestId },
        { status: 422 } // Unprocessable Entity
      );
    }

    const latency = Date.now() - startTime;

    voiceDiagnostics.record({
      requestId,
      provider: process.env.WHISPER_PROVIDER === 'cloud' ? 'cloud' : 'local',
      mimeBaseType: baseMime,
      audioSize: audioBuffer ? audioBuffer.length : 0,
      duration: result.metadata?.duration as number | undefined,
      latencyMs: latency,
      status: 'success',
    });

    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'success',
      model: 'whisper-1',
    });

    return NextResponse.json({
      status: 'success',
      data: {
        text: result.text,
        metadata: result.metadata,
      },
      requestId,
    });
  } catch (error: unknown) {
    const latency = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMsg.includes('timed out') || errorMsg.includes('TimeoutError');

    console.error('Error during voice transcription:', error);

    let errorCategory = 'UNKNOWN_FAILURE';
    if (isTimeout) {
      errorCategory = 'TIMEOUT';
    } else {
      const isPayloadLarge = errorMsg.includes('Payload Too Large') || errorMsg.includes('size limit');
      if (isPayloadLarge) {
        errorCategory = 'PAYLOAD_TOO_LARGE';
      } else if (errorMsg.includes('WHISPER_API_KEY') || errorMsg.includes('Whisper API key')) {
        errorCategory = 'MISSING_API_KEY';
      } else if (errorMsg.includes('Local Whisper transcription service') || errorMsg.includes('Local Whisper daemon failed to load')) {
        errorCategory = 'LOCAL_SERVICE_UNAVAILABLE';
      } else if (errorMsg.includes('Local Whisper port conflict')) {
        errorCategory = 'PORT_CONFLICT';
      } else if (errorMsg.includes('Invalid audio format') || errorMsg.includes('corrupted payload')) {
        errorCategory = 'INVALID_FORMAT';
      } else if (errorMsg.includes('exceeds the maximum limit')) {
        errorCategory = 'DURATION_LIMIT_EXCEEDED';
      } else if (errorMsg.includes('busy')) {
        errorCategory = 'ENGINE_BUSY';
      } else if (errorMsg.includes('Empty transcription')) {
        errorCategory = 'EMPTY_TRANSCRIPTION';
      }
    }

    voiceDiagnostics.record({
      requestId,
      provider: process.env.WHISPER_PROVIDER === 'cloud' ? 'cloud' : 'local',
      mimeBaseType: baseMime || 'unknown',
      audioSize: audioBuffer ? audioBuffer.length : 0,
      latencyMs: latency,
      status: 'error',
      errorCategory,
    });

    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'error',
      errorCategory,
    });

    const isPayloadLarge = errorMsg.includes('Payload Too Large') || errorMsg.includes('size limit');
    if (isPayloadLarge) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Payload Too Large: Audio size limit of 10 MB exceeded.',
          errorCategory,
          requestId,
        },
        { status: 413 }
      );
    }

    let status = 500;
    let displayError = 'An error occurred during transcription.';

    if (isTimeout) {
      status = 504;
      displayError = 'The transcription request timed out while communicating with external model provider.';
    } else if (errorMsg.includes('WHISPER_API_KEY') || errorMsg.includes('Whisper API key')) {
      status = 503;
      displayError = 'Cloud transcription service is currently unavailable due to missing API key.';
    } else if (errorMsg.includes('Local Whisper transcription service') || errorMsg.includes('Local Whisper daemon failed to load')) {
      status = 503;
      displayError = 'Local Whisper transcription service is currently unavailable.';
    } else if (errorMsg.includes('Local Whisper port conflict')) {
      status = 503;
      displayError = 'Local Whisper transcription service is currently unavailable due to a port conflict.';
    } else if (errorMsg.includes('Invalid audio format') || errorMsg.includes('corrupted payload')) {
      status = 400;
      displayError = 'Invalid audio format or corrupted payload.';
    } else if (errorMsg.includes('exceeds the maximum limit')) {
      status = 400;
      displayError = 'Audio duration exceeds the maximum limit of 60 seconds.';
    } else if (errorMsg.includes('busy')) {
      status = 503;
      displayError = 'Transcription engine is busy. Please try again.';
    } else if (errorMsg.includes('Empty transcription')) {
      status = 422;
      displayError = errorMsg;
    } else if (errorMsg.includes('Whisper Transcription API error')) {
      displayError = errorMsg;
    }

    return NextResponse.json(
      {
        status: 'error',
        error: displayError,
        errorCategory,
        requestId,
      },
      { status }
    );
  }
}
