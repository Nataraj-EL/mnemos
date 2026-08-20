import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';
import { resetRateLimits } from '@/memory/security';

const mockTranscribe = vi.fn();
const mockRespond = vi.fn();

vi.mock('@/voice/whisperTranscription', () => {
  return {
    WhisperTranscriptionProvider: vi.fn().mockImplementation(function () {
      return {
        transcribe: mockTranscribe,
      };
    }),
  };
});

vi.mock('@/response/service', () => {
  return {
    ResponseService: vi.fn().mockImplementation(function () {
      return {
        respond: mockRespond,
      };
    }),
  };
});

describe('POST /api/v1/voice/respond Route Handler', () => {
  beforeEach(() => {
    process.env.MNEMOS_AUTH_ENABLED = 'false';
    process.env.WHISPER_PROVIDER = 'cloud';
    resetRateLimits();
    mockTranscribe.mockReset();
    mockRespond.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should successfully transcribe and generate grounded response with memories', async () => {
    mockTranscribe.mockResolvedValueOnce({ text: 'What is my favorite database?' });

    const mockUsedMemories = [
      { id: 'mem-1', type: 'PREFERENCE', similarity: 0.85, score: 0.85 },
    ];
    mockRespond.mockResolvedValueOnce({
      response: 'Your favorite database is Neon PostgreSQL.',
      usedMemories: mockUsedMemories,
      contextTokenCount: 15,
    });

    const formData = new FormData();
    const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    formData.append('file', audioBlob);
    formData.append('userId', 'user-123');

    const request = new Request('http://localhost/api/v1/voice/respond', {
      method: 'POST',
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.data.transcript).toBe('What is my favorite database?');
    expect(data.data.response).toBe('Your favorite database is Neon PostgreSQL.');
    expect(data.data.usedMemories).toEqual(mockUsedMemories);
    expect(data.data.contextTokenCount).toBe(15);
    expect(mockRespond).toHaveBeenCalledWith('user-123', 'What is my favorite database?');
  });

  it('should return 400 when Content-Type is not multipart/form-data', async () => {
    const request = new Request('http://localhost/api/v1/voice/respond', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-1' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain('Content-Type must be multipart/form-data');
  });

  it('should return 400 when userId is missing', async () => {
    const formData = new FormData();
    const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    formData.append('file', audioBlob);

    const request = new Request('http://localhost/api/v1/voice/respond', {
      method: 'POST',
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain('userId is required');
  });

  it('should return 422 and NOT call ResponseService when transcription fails or is empty', async () => {
    mockTranscribe.mockResolvedValueOnce({ text: '   ' });

    const formData = new FormData();
    const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    formData.append('file', audioBlob);
    formData.append('userId', 'user-123');

    const request = new Request('http://localhost/api/v1/voice/respond', {
      method: 'POST',
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(422);

    const data = await response.json();
    expect(data.error).toContain('Empty transcription');
    expect(mockRespond).not.toHaveBeenCalled();
  });

  it('should handle Whisper timeout cleanly (return 504)', async () => {
    mockTranscribe.mockRejectedValueOnce(new Error('Whisper Transcription request timed out'));

    const formData = new FormData();
    const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    formData.append('file', audioBlob);
    formData.append('userId', 'user-123');

    const request = new Request('http://localhost/api/v1/voice/respond', {
      method: 'POST',
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(504);

    const data = await response.json();
    expect(data.error.toLowerCase()).toContain('timeout');
    expect(mockRespond).not.toHaveBeenCalled();
  });

  it('should handle ResponseService timeout cleanly (return 504)', async () => {
    mockTranscribe.mockResolvedValueOnce({ text: 'Hello' });
    mockRespond.mockRejectedValueOnce(new Error('Gemini Generation request timed out'));

    const formData = new FormData();
    const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    formData.append('file', audioBlob);
    formData.append('userId', 'user-123');

    const request = new Request('http://localhost/api/v1/voice/respond', {
      method: 'POST',
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(504);
  });

  it('should require authentication when enabled', async () => {
    process.env.MNEMOS_AUTH_ENABLED = 'true';
    process.env.MNEMOS_API_KEY = 'secret-key';

    const formData = new FormData();
    const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    formData.append('file', audioBlob);
    formData.append('userId', 'user-123');

    const request = new Request('http://localhost/api/v1/voice/respond', {
      method: 'POST',
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });
});
