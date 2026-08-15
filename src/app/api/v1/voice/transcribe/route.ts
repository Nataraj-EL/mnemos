import { NextResponse } from 'next/server';
import { WhisperTranscriptionProvider } from '@/voice/whisperTranscription';
import { logTelemetry } from '@/core/logger';
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
    let audioBuffer: Buffer | null = null;
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
    if (!SUPPORTED_MIME_TYPES.includes(normalizedMime)) {
      return NextResponse.json(
        { status: 'error', error: `Unsupported MIME type: "${mimeType}". Only audio formats (WAV, MP3, WebM, etc.) are supported.`, requestId },
        { status: 415 } // 415 Unsupported Media Type
      );
    }

    // 6. Execute Transcription Provider
    const provider = new WhisperTranscriptionProvider();
    const result = await provider.transcribe(audioBuffer, normalizedMime);

    // Empty transcript check
    if (!result.text || !result.text.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Empty transcription: No text could be extracted from this audio.', requestId },
        { status: 422 } // Unprocessable Entity
      );
    }

    const latency = Date.now() - startTime;

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

    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'error',
      errorCategory: isTimeout ? 'TIMEOUT' : 'PROVIDER_FAILURE',
    });

    const isPayloadLarge = errorMsg.includes('Payload Too Large') || errorMsg.includes('size limit');
    if (isPayloadLarge) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Payload Too Large: Audio size limit of 10 MB exceeded.',
          requestId,
        },
        { status: 413 }
      );
    }

    const displayError = isTimeout
      ? 'The transcription request timed out while communicating with external model provider.'
      : errorMsg.includes('Whisper Transcription API error')
      ? errorMsg
      : errorMsg.includes('Empty transcription')
      ? errorMsg
      : 'An error occurred during transcription.';

    return NextResponse.json(
      {
        status: 'error',
        error: displayError,
        requestId,
      },
      { status: isTimeout ? 504 : 500 }
    );
  }
}
