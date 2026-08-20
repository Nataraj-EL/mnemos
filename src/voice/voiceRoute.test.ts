import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '@/app/api/v1/voice/transcribe/route';
import { resetRateLimits } from '@/memory/security';
import { LocalWhisperTranscriptionProvider } from './localWhisperTranscription';

describe('POST /api/v1/voice/transcribe API Route', () => {
  beforeEach(() => {
    process.env.MNEMOS_AUTH_ENABLED = 'false';
    process.env.WHISPER_API_KEY = 'mock-whisper-key';
    process.env.WHISPER_PROVIDER = 'cloud';
    vi.stubGlobal('fetch', vi.fn());
    resetRateLimits();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should successfully transcribe valid audio payload (raw binary)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'Hello world' }),
    } as unknown as Response);

    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
      },
      body: Buffer.from('mock-audio-data'),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.data.text).toBe('Hello world');
    expect(data.requestId).toBeDefined();
    
    // API-key confidentiality: Verify Whisper API key is never in the response data
    expect(JSON.stringify(data)).not.toContain('mock-whisper-key');
  });

  it('should successfully transcribe valid audio via multipart/form-data', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'Form upload success' }),
    } as unknown as Response);

    const formData = new FormData();
    const blob = new Blob([Buffer.from('fake-wav-bytes')], { type: 'audio/wav' });
    formData.append('file', blob, 'test.wav');

    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.data.text).toBe('Form upload success');
  });

  it('should reject requests with unsupported MIME types', async () => {
    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
      },
      body: Buffer.from('text content'),
    });

    const response = await POST(request);
    expect(response.status).toBe(415); // Unsupported Media Type

    const data = await response.json();
    expect(data.status).toBe('error');
    expect(data.error).toContain('Unsupported MIME type');
  });

  it('should reject empty audio uploads', async () => {
    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
      },
      body: Buffer.alloc(0),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.status).toBe('error');
    expect(data.error).toContain('payload cannot be empty');
  });

  it('should reject oversized audio uploads', async () => {
    const largeBuffer = Buffer.alloc(11 * 1024 * 1024);
    
    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
        'content-length': largeBuffer.length.toString(),
      },
      body: largeBuffer,
    });

    const response = await POST(request);
    expect(response.status).toBe(413); // Payload Too Large

    const data = await response.json();
    expect(data.status).toBe('error');
    expect(data.error).toContain('limit of 10 MB exceeded');
  });

  it('should require authentication when enabled', async () => {
    process.env.MNEMOS_AUTH_ENABLED = 'true';
    process.env.MNEMOS_API_KEY = 'super-secret-api-key';

    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
      },
      body: Buffer.from('mock-audio-data'),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);

    const data = await response.json();
    expect(data.status).toBe('error');
    expect(data.error).toContain('API key is missing');
  });

  it('should succeed authentication with correct key', async () => {
    process.env.MNEMOS_AUTH_ENABLED = 'true';
    process.env.MNEMOS_API_KEY = 'super-secret-api-key';

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'Authenticated success' }),
    } as unknown as Response);

    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
        'X-API-Key': 'super-secret-api-key',
      },
      body: Buffer.from('mock-audio-data'),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('success');
  });

  it('should enforce rate limits', async () => {
    process.env.RATE_LIMIT_MAX_REQUESTS = '2';
    process.env.RATE_LIMIT_WINDOW_SECONDS = '10';

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Success' }),
    } as unknown as Response);

    const makeRequest = () => new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.from('mock-audio-data'),
    });

    let res = await POST(makeRequest());
    expect(res.status).toBe(200);

    res = await POST(makeRequest());
    expect(res.status).toBe(200);

    res = await POST(makeRequest());
    expect(res.status).toBe(429); // Too Many Requests
  });

  it('should handle provider timeouts gracefully', async () => {
    const timeoutError = new Error('The operation was aborted.');
    timeoutError.name = 'TimeoutError';
    vi.mocked(fetch).mockRejectedValueOnce(timeoutError);

    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.from('mock-audio-data'),
    });

    const response = await POST(request);
    expect(response.status).toBe(504); // Gateway Timeout

    const data = await response.json();
    expect(data.status).toBe('error');
    expect(data.error.toLowerCase()).toContain('timeout');
  });

  it('should handle provider failure gracefully', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error on Whisper',
    } as unknown as Response);

    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.from('mock-audio-data'),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.status).toBe('error');
    expect(data.error).toContain('Whisper Transcription API error');
  });

  describe('Sprint 62A MIME Normalization & Safety Regression Tests', () => {
    const runMimeTest = async (mime: string, expectStatus: number) => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'Success text response' }),
      } as unknown as Response);

      const request = new Request('http://localhost/api/v1/voice/transcribe', {
        method: 'POST',
        headers: {
          'content-type': mime,
        },
        body: Buffer.from('mock-audio-data'),
      });

      const response = await POST(request);
      expect(response.status).toBe(expectStatus);
    };

    it('should accept audio/webm;codecs=opus successfully', async () => {
      await runMimeTest('audio/webm;codecs=opus', 200);
    });

    it('should accept audio/webm;codecs=vp9 successfully', async () => {
      await runMimeTest('audio/webm;codecs=vp9', 200);
    });

    it('should accept audio/webm successfully', async () => {
      await runMimeTest('audio/webm', 200);
    });

    it('should match MIME types case-insensitively', async () => {
      await runMimeTest('AUDIO/WEBM;CODECS=OPUS', 200);
    });

    it('should reject unsupported base MIME with 415', async () => {
      await runMimeTest('application/pdf', 415);
    });
  });

  describe('Sprint 62B Route Exception Mapping Tests', () => {
    it('should return 503 when WHISPER_API_KEY is missing on cloud provider', async () => {
      process.env.WHISPER_PROVIDER = 'cloud';
      const origKey = process.env.WHISPER_API_KEY;
      delete process.env.WHISPER_API_KEY;

      const request = new Request('http://localhost/api/v1/voice/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: Buffer.from('mock-audio-data'),
      });

      const response = await POST(request);
      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.status).toBe('error');
      expect(data.error.toLowerCase()).toContain('missing');
      expect(data.error.toLowerCase()).toContain('api key');

      if (origKey) process.env.WHISPER_API_KEY = origKey;
    });

    it('should return 503 when Local Whisper port conflict occurs', async () => {
      process.env.WHISPER_PROVIDER = 'local';
      
      const spy = vi.spyOn(LocalWhisperTranscriptionProvider.prototype, 'transcribe')
        .mockRejectedValueOnce(new Error('Local Whisper port conflict: Port 50051 is already in use by another process.'));

      const request = new Request('http://localhost/api/v1/voice/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: Buffer.from('mock-audio-data'),
      });

      const response = await POST(request);
      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.status).toBe('error');
      expect(data.error).toContain('port conflict');
      spy.mockRestore();
    });

    it('should return 400 when invalid audio format error occurs', async () => {
      process.env.WHISPER_PROVIDER = 'local';
      
      const spy = vi.spyOn(LocalWhisperTranscriptionProvider.prototype, 'transcribe')
        .mockRejectedValueOnce(new Error('Invalid audio format or corrupted payload.'));

      const request = new Request('http://localhost/api/v1/voice/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: Buffer.from('mock-audio-data'),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.status).toBe('error');
      expect(data.error).toContain('Unsupported audio format');
      spy.mockRestore();
    });

    it('should return 400 when audio exceeds maximum duration limit', async () => {
      process.env.WHISPER_PROVIDER = 'local';
      
      const spy = vi.spyOn(LocalWhisperTranscriptionProvider.prototype, 'transcribe')
        .mockRejectedValueOnce(new Error('Audio duration exceeds the maximum limit of 60 seconds.'));

      const request = new Request('http://localhost/api/v1/voice/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: Buffer.from('mock-audio-data'),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.status).toBe('error');
      expect(data.error).toContain('exceeds the maximum limit');
      spy.mockRestore();
    });
  });

  describe('Sprint 66 Route Gated Error visibility & Actionable Messages', () => {
    const runErrorTest = async (thrownError: Error, expectedMsg: string, expectedStatus: number, isProduction = false) => {
      process.env.WHISPER_PROVIDER = 'local';
      const origEnv = process.env.NODE_ENV;
      if (isProduction) {
        (process.env as Record<string, string>).NODE_ENV = 'production';
      } else {
        (process.env as Record<string, string>).NODE_ENV = 'test';
      }

      const spy = vi.spyOn(LocalWhisperTranscriptionProvider.prototype, 'transcribe').mockRejectedValueOnce(thrownError);

      const request = new Request('http://localhost/api/v1/voice/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: Buffer.from('mock-audio-data'),
      });

      const response = await POST(request);
      expect(response.status).toBe(expectedStatus);

      const data = await response.json();
      expect(data.status).toBe('error');
      expect(data.error).toBe(expectedMsg);

      spy.mockRestore();
      if (origEnv) {
        (process.env as Record<string, string>).NODE_ENV = origEnv;
      }
    };

    it('should map connection failures (fetch failed) to "Whisper daemon connection failed" in development/testing', async () => {
      await runErrorTest(new Error('fetch failed'), 'Whisper daemon connection failed', 503);
    });

    it('should map daemon crashes (exited unexpectedly) to "Local transcription service unavailable" in development/testing', async () => {
      await runErrorTest(new Error('Local Whisper daemon exited unexpectedly with code 1.'), 'Local transcription service unavailable', 503);
    });

    it('should map timeout rejections to "Transcription provider timeout" in development/testing', async () => {
      const err = new Error('The operation timed out.');
      err.name = 'TimeoutError';
      await runErrorTest(err, 'Transcription provider timeout', 504);
    });

    it('should map Empty transcription errors to "Audio payload is empty" in development/testing', async () => {
      await runErrorTest(new Error('Empty transcription: No speech detected.'), 'Audio payload is empty', 422);
    });

    it('should return generic sanitized error message in production for connection failures', async () => {
      await runErrorTest(new Error('fetch failed'), 'Local Whisper transcription service is currently unavailable.', 503, true);
    });
  });
});
