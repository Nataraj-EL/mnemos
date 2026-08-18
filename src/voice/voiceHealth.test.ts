import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET } from '@/app/api/v1/voice/health/route';
import { POST as TranscribePOST } from '@/app/api/v1/voice/transcribe/route';
import { voiceDiagnostics } from '@/voice/voiceDiagnostics';
import { LocalWhisperTranscriptionProvider } from '@/voice/localWhisperTranscription';
import { resetRateLimits } from '@/memory/security';

describe('Voice Health & Diagnostics API Route (Sprint 63)', () => {
  beforeEach(() => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    process.env.WHISPER_PROVIDER = 'local';
    process.env.MNEMOS_AUTH_ENABLED = 'false';
    vi.stubGlobal('fetch', vi.fn());
    resetRateLimits();
    voiceDiagnostics.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (process.env as Record<string, string>).NODE_ENV = 'test';
  });

  it('should block GET /api/v1/voice/health in non-development/non-testing environments (Production Isolation)', async () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    const response = await GET();
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.status).toBe('error');
    expect(data.error).toContain('Forbidden');
  });

  it('should return correct WHISPER_PROVIDER configuration and supported MIME types', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('success');
    expect(data.data.provider).toBe('local');
    expect(data.data.supportedMimeTypes).toContain('audio/webm');
    expect(data.data.supportedMimeTypes).toContain('audio/wav');
  });

  it('should sanitize diagnostics and never store audio or transcripts', async () => {
    voiceDiagnostics.record({
      requestId: 'req-test-1',
      provider: 'local',
      mimeBaseType: 'audio/wav',
      audioSize: 1024,
      latencyMs: 150,
      status: 'success',
    });

    const response = await GET();
    const data = await response.json();
    const latest = data.data.latestRequest;

    expect(latest).toBeDefined();
    expect(latest.requestId).toBe('req-test-1');
    expect(latest.audioSize).toBe(1024);
    
    // Safety boundaries verification
    expect(latest.audio).toBeUndefined();
    expect(latest.transcript).toBeUndefined();
    expect(latest.text).toBeUndefined();
    expect(latest.apiKey).toBeUndefined();
    expect(latest.secret).toBeUndefined();
  });

  it('should record and propagate error-category during provider failures', async () => {
    process.env.WHISPER_PROVIDER = 'local';
    
    const spy = vi.spyOn(LocalWhisperTranscriptionProvider.prototype, 'transcribe')
      .mockRejectedValueOnce(new Error('Invalid audio format or corrupted payload.'));

    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.from('mock-audio-data'),
    });

    const response = await TranscribePOST(request);
    expect(response.status).toBe(400);

    const resJson = await response.json();
    expect(resJson.errorCategory).toBe('INVALID_FORMAT');

    // Retrieve health status diagnostics to check storage
    const healthResponse = await GET();
    const healthData = await healthResponse.json();
    expect(healthData.data.lastFailureCategory).toBe('INVALID_FORMAT');
    expect(healthData.data.latestRequest.errorCategory).toBe('INVALID_FORMAT');
    expect(healthData.data.latestRequest.status).toBe('error');

    spy.mockRestore();
  });

  it('should handle missing keys on cloud provider with correct category', async () => {
    process.env.WHISPER_PROVIDER = 'cloud';
    const origKey = process.env.WHISPER_API_KEY;
    delete process.env.WHISPER_API_KEY;

    const request = new Request('http://localhost/api/v1/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.from('mock-audio-data'),
    });

    const response = await TranscribePOST(request);
    expect(response.status).toBe(503);

    const resJson = await response.json();
    expect(resJson.errorCategory).toBe('MISSING_API_KEY');

    const healthResponse = await GET();
    const healthData = await healthResponse.json();
    expect(healthData.data.latestRequest.errorCategory).toBe('MISSING_API_KEY');

    if (origKey) process.env.WHISPER_API_KEY = origKey;
  });
});
