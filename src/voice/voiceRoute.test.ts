import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '@/app/api/v1/voice/transcribe/route';
import { resetRateLimits } from '@/memory/security';

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
    expect(data.error).toContain('timed out');
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
});
