import { NextResponse } from 'next/server';
import { WhisperTranscriptionProvider } from '@/voice/whisperTranscription';
import { LocalWhisperTranscriptionProvider } from '@/voice/localWhisperTranscription';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { GeminiResponseGenerator } from '@/response/geminiGenerator';
import { ResponseService } from '@/response/service';
import { PgMemoryRepository } from '@/memory/repository';
import { logTelemetry } from '@/core/logger';
import { voiceDiagnostics } from '@/voice/voiceDiagnostics';
import { ConversationRetriever } from '@/conversation/retriever';
import { MemoryIngestionService } from '@/memory/ingestionService';
import { GeminiMemoryExtractor } from '@/memory/geminiExtractor';
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
    baseMime = normalizedMime.split(';')[0].trim();

    if (!SUPPORTED_MIME_TYPES.includes(baseMime)) {
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

    audioBuffer = Buffer.from(arrayBuffer);
    if (audioBuffer.length === 0) {
      return NextResponse.json(
        { status: 'error', error: 'Missing or empty parameter: audio payload cannot be empty.', requestId },
        { status: 400 }
      );
    }

    // 6. Execute Whisper transcription provider
    const transcriptionProvider = process.env.WHISPER_PROVIDER === 'cloud'
      ? new WhisperTranscriptionProvider()
      : new LocalWhisperTranscriptionProvider();
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
    const conversationRetriever = new ConversationRetriever();
    
    // Ingest voice query to persist any spoken facts/preferences
    const extractor = new GeminiMemoryExtractor();
    const ingestionService = new MemoryIngestionService(repository, extractor, embeddingProvider);
    await ingestionService.ingest(userId, transcript, {
      conversationId: 'voice-session',
      sourceType: 'voice',
      sourceTimestamp: new Date().toISOString(),
    }).catch((ingestErr) => {
      console.error('Ask-by-Voice Ingestion Error (continuing to respond):', ingestErr);
    });

    const responseService = new ResponseService(retriever, assembler, generator, repository, conversationRetriever);
    const groundedResult = await responseService.respond(userId, transcript);

    const latency = Date.now() - startTime;

    voiceDiagnostics.record({
      requestId,
      provider: process.env.WHISPER_PROVIDER === 'cloud' ? 'cloud' : 'local',
      mimeBaseType: baseMime,
      audioSize: audioBuffer ? audioBuffer.length : 0,
      duration: transcriptionResult.metadata?.duration as number | undefined,
      latencyMs: latency,
      status: 'success',
    });

    logTelemetry({
      correlationId: requestId,
      totalLatencyMs: latency,
      status: 'success',
      model: 'whisper-1 + ' + (process.env.GENERATION_MODEL || 'gemini-3.5-flash'),
    });

    const sanitizedUsedMemories = (groundedResult.usedMemories || []).map((m) => ({
      id: m.id,
      content: m.content ? (m.content.length > 120 ? m.content.slice(0, 117) + '...' : m.content) : '',
      similarity: typeof m.similarity === 'number' ? m.similarity : 1.0,
      sourceType: m.sourceType || 'voice',
      timestamp: m.sourceTimestamp || new Date().toISOString(),
    }));

    return NextResponse.json({
      status: 'success',
      data: {
        transcript,
        response: groundedResult.response,
        usedMemories: sanitizedUsedMemories,
        contextTokenCount: groundedResult.contextTokenCount,
        usedConversations: groundedResult.usedConversations,
      },
      requestId,
    });
  } catch (error: unknown) {
    const latency = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMsg.includes('timed out') || errorMsg.includes('TimeoutError') || errorMsg.includes('timeout') || errorMsg.includes('aborted');

    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
      console.error('Error during voice response processing:', error);
    }

    let errorCategory = 'UNKNOWN_FAILURE';
    let status = 500;
    let displayError = 'An error occurred during voice response processing.';

    if (isTimeout) {
      errorCategory = 'TIMEOUT';
      status = 504;
      displayError = 'The request timed out while communicating with external model provider.';
    } else {
      const isPayloadLarge = errorMsg.includes('Payload Too Large') || errorMsg.includes('size limit');
      if (isPayloadLarge) {
        errorCategory = 'PAYLOAD_TOO_LARGE';
        status = 413;
        displayError = 'Payload Too Large: Audio size limit of 10 MB exceeded.';
      } else if (errorMsg.includes('GEMINI_API_KEY') || errorMsg.includes('WHISPER_API_KEY') || errorMsg.includes('Whisper API key')) {
        errorCategory = 'MISSING_API_KEY';
        status = 503;
        displayError = 'Grounded voice response service is temporarily unavailable due to missing API keys.';
      } else if (
        errorMsg.includes('Local Whisper transcription service') ||
        errorMsg.includes('Local Whisper daemon failed to load') ||
        errorMsg.includes('exited unexpectedly') ||
        errorMsg.includes('ENOENT')
      ) {
        errorCategory = 'LOCAL_SERVICE_UNAVAILABLE';
        status = 503;
        displayError = 'Local Whisper transcription service is currently unavailable.';
      } else if (errorMsg.includes('fetch failed') || errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Connection refused')) {
        errorCategory = 'LOCAL_SERVICE_UNAVAILABLE';
        status = 503;
        displayError = 'Local Whisper transcription service is currently unavailable.';
      } else if (errorMsg.includes('Local Whisper port conflict') || errorMsg.includes('port is already in use')) {
        errorCategory = 'PORT_CONFLICT';
        status = 503;
        displayError = 'Local Whisper transcription service is currently unavailable due to a port conflict.';
      } else if (errorMsg.includes('Invalid audio format') || errorMsg.includes('corrupted payload') || errorMsg.includes('Invalid data found')) {
        errorCategory = 'INVALID_FORMAT';
        status = 400;
        displayError = 'Invalid audio format or corrupted payload.';
      } else if (errorMsg.includes('exceeds the maximum limit')) {
        errorCategory = 'DURATION_LIMIT_EXCEEDED';
        status = 400;
        displayError = 'Audio duration exceeds the maximum limit of 60 seconds.';
      } else if (errorMsg.includes('busy')) {
        errorCategory = 'ENGINE_BUSY';
        status = 503;
        displayError = 'Transcription engine is busy. Please try again.';
      } else if (errorMsg.includes('Empty transcription') || errorMsg.includes('cannot be empty')) {
        errorCategory = 'EMPTY_TRANSCRIPTION';
        status = 422;
        displayError = 'Empty transcription: No text could be extracted from this audio.';
      }
    }

    // Expose sanitized developer actionable errors in development/test only
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
      if (errorCategory === 'LOCAL_SERVICE_UNAVAILABLE') {
        if (errorMsg.includes('fetch failed') || errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Connection refused')) {
          displayError = 'Whisper daemon connection failed';
        } else {
          displayError = 'Local transcription service unavailable';
        }
      } else if (errorCategory === 'MISSING_API_KEY') {
        displayError = 'Missing transcription API key';
      } else if (errorCategory === 'INVALID_FORMAT') {
        displayError = 'Unsupported audio format';
      } else if (errorCategory === 'EMPTY_TRANSCRIPTION') {
        displayError = 'Audio payload is empty';
      } else if (errorCategory === 'TIMEOUT') {
        displayError = 'Transcription provider timeout';
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
