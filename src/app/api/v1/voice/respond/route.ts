import { NextResponse } from 'next/server';
import { WhisperTranscriptionProvider } from '@/voice/whisperTranscription';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { GeminiResponseGenerator } from '@/response/geminiGenerator';
import { ResponseService } from '@/response/service';
import { PgMemoryRepository } from '@/memory/repository';
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

    // 4. Parse request content-type and extract multipart variables
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return NextResponse.json(
        { status: 'error', error: 'Content-Type must be multipart/form-data.', requestId },
        { status: 400 }
      );
    }

    const formData = await request.formData().catch(() => null);
    if (!formData) {
      return NextResponse.json(
        { status: 'error', error: 'Malformed multipart form data.', requestId },
        { status: 400 }
      );
    }

    const file = formData.get('file');
    const userIdVal = formData.get('userId');

    // 5. Input validation guards
    if (typeof userIdVal !== 'string' || !userIdVal.trim()) {
      return NextResponse.json(
        { status: 'error', error: 'Missing or invalid parameter: userId is required.', requestId },
        { status: 400 }
      );
    }

    const userId = userIdVal.trim();
    if (userId.length > 128) {
      return NextResponse.json(
        { status: 'error', error: 'Invalid parameter: userId cannot exceed 128 characters.', requestId },
        { status: 400 }
      );
    }

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { status: 'error', error: 'Missing or empty parameter: file is required.', requestId },
        { status: 400 }
      );
    }

    const mimeType = file.type || 'audio/wav';
    const normalizedMime = mimeType.toLowerCase();

    if (!SUPPORTED_MIME_TYPES.includes(normalizedMime)) {
      return NextResponse.json(
        {
          status: 'error',
          error: `Unsupported MIME type: "${mimeType}". Only audio formats (WAV, MP3, WebM, etc.) are supported.`,
          requestId,
        },
        { status: 415 }
      );
    }

    const arrayBuffer = await file.arrayBuffer().catch(() => null);
    if (!arrayBuffer) {
      return NextResponse.json(
        { status: 'error', error: 'Failed to read audio file bytes.', requestId },
        { status: 400 }
      );
    }

    const audioBuffer = Buffer.from(arrayBuffer);
    if (audioBuffer.length === 0) {
      return NextResponse.json(
        { status: 'error', error: 'Missing or empty parameter: audio payload cannot be empty.', requestId },
        { status: 400 }
      );
    }

    // 6. Execute Whisper transcription provider (timeout protected natively to 10s)
    const transcriptionProvider = new WhisperTranscriptionProvider();
    const transcriptionResult = await transcriptionProvider.transcribe(audioBuffer, normalizedMime);

    const transcript = transcriptionResult.text ? transcriptionResult.text.trim() : '';
    if (!transcript) {
      return NextResponse.json(
        { status: 'error', error: 'Empty transcription: No text could be extracted from this audio.', requestId },
        { status: 422 }
      );
    }

    // 7. Execute ResponseService orchestration pipeline
    const embeddingProvider = new GeminiEmbeddingProvider();
    const retriever = new MemoryRetriever(embeddingProvider);
    const assembler = new ContextAssembler();
    const generator = new GeminiResponseGenerator();
    const repository = new PgMemoryRepository();
    const responseService = new ResponseService(retriever, assembler, generator, repository);

    const groundedResult = await responseService.respond(userId, transcript);

    const latency = Date.now() - startTime;
    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'success',
      model: 'whisper-1 + ' + (process.env.GENERATION_MODEL || 'gemini-3.5-flash'),
    });

    return NextResponse.json({
      status: 'success',
      data: {
        transcript,
        response: groundedResult.response,
        usedMemories: groundedResult.usedMemories,
        contextTokenCount: groundedResult.contextTokenCount,
      },
      requestId,
    });
  } catch (error: unknown) {
    const latency = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMsg.includes('timed out') || errorMsg.includes('TimeoutError') || errorMsg.includes('abort');

    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'error',
      errorCategory: isTimeout ? 'TIMEOUT' : 'PROVIDER_FAILURE',
    });

    if (errorMsg.includes('GEMINI_API_KEY') || errorMsg.includes('WHISPER_API_KEY')) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'Grounded voice response service is temporarily unavailable.',
          requestId,
        },
        { status: 503 }
      );
    }

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
      ? 'The request timed out while communicating with external model provider.'
      : 'An error occurred during voice response processing.';

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
