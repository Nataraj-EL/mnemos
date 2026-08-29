/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalWhisperTranscriptionProvider } from './localWhisperTranscription';
import { spawn } from 'child_process';
import * as fs from 'fs';

vi.mock('child_process', () => {
  return {
    spawn: vi.fn(),
  };
});

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

describe('LocalWhisperTranscriptionProvider - Reliability & Lifecycle Tests', () => {
  let provider: LocalWhisperTranscriptionProvider;
  let mockFetch: any;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LOCAL_WHISPER_PORT = '50051';
    process.env.WHISPER_DEVICE = 'auto';
    LocalWhisperTranscriptionProvider.resetDaemonState();
    provider = new LocalWhisperTranscriptionProvider();
    
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    // Mock existence check for python binary and script as true by default
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (typeof p === 'string' && (p.includes('python3') || p.includes('transcription_server.py') || p.includes('.whisper_secret'))) {
        return true;
      }
      return false;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. should reuse an existing healthy daemon without spawning a new process', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('saved-secret-token');

    // Health check returns ready
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ready', device: 'cpu', compute: 'int8' }),
    });

    // Transcribe endpoint returns successful result
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'Speech text', duration: 1.5, latency_ms: 150, device: 'cpu', compute: 'int8' }),
    });

    const result = await provider.transcribe(Buffer.from('audio-bytes'), 'audio/wav');
    expect(result.text).toBe('Speech text');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('2. should prevent duplicate spawn calls under concurrent requests', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('');

    // Mock spawn to return dummy child process object
    const mockChildProcess = {
      unref: vi.fn(),
      on: vi.fn(),
      kill: vi.fn(),
    } as any;
    vi.mocked(spawn).mockReturnValue(mockChildProcess);

    let healthCallCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/health')) {
        healthCallCount++;
        if (healthCallCount === 1) {
          throw new Error('Connection refused');
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ready', device: 'cpu', compute: 'int8' }),
        };
      }
      if (url.includes('/transcribe')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ text: 'Transcribed text', duration: 1.5, latency_ms: 100, device: 'cpu', compute: 'int8' }),
        };
      }
      return { ok: false, status: 404 };
    });

    // Run two transcriptions concurrently
    const p1 = provider.transcribe(Buffer.from('bytes'), 'audio/wav');
    const p2 = provider.transcribe(Buffer.from('bytes'), 'audio/wav');

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.text).toBe('Transcribed text');
    expect(r2.text).toBe('Transcribed text');
    // Spawn should be called exactly once
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('3. should throw a port conflict error if port is already in use by another process', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('stale-token');

    // Health check returns 403 Forbidden because of stale secret/port in use by other process
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
    });

    await expect(provider.transcribe(Buffer.from('bytes'), 'audio/wav')).rejects.toThrow(
      'Local Whisper port conflict: Port 50051 is already in use by another process.'
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('4. should handle daemon startup exit failures gracefully', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('');

    mockFetch.mockRejectedValue(new Error('Connection refused'));

    let exitHandler: any;
    const mockChildProcess = {
      unref: vi.fn(),
      on: vi.fn().mockImplementation((event, handler) => {
        if (event === 'exit') {
          exitHandler = handler;
        }
      }),
      kill: vi.fn(),
    } as any;
    vi.mocked(spawn).mockReturnValue(mockChildProcess);

    const promise = provider.transcribe(Buffer.from('bytes'), 'audio/wav');

    // Simulate child process exiting immediately with code 1
    setTimeout(() => {
      if (exitHandler) {
        exitHandler(1);
      }
    }, 100);

    await expect(promise).rejects.toThrow(
      'Local Whisper daemon exited unexpectedly with code 1.'
    );
  });

  it('5. should enforce request timeouts and clean up properly', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('token');

    // Health check ready
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ready', device: 'cpu', compute: 'int8' }),
    });

    // Transcribe endpoint times out
    const timeoutError = new Error('The request timed out.');
    timeoutError.name = 'TimeoutError';
    mockFetch.mockRejectedValueOnce(timeoutError);

    await expect(provider.transcribe(Buffer.from('bytes'), 'audio/wav')).rejects.toThrow(
      'Transcription request timed out after 45 seconds.'
    );
  });

  it('6. should reject audio if duration exceeds 60 seconds limit', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('token');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ready', device: 'cpu', compute: 'int8' }),
    });

    // Transcribe returns duration limit error from Python daemon
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Audio duration exceeds the maximum limit of 60 seconds.' }),
    });

    await expect(provider.transcribe(Buffer.from('bytes'), 'audio/wav')).rejects.toThrow(
      'Audio duration exceeds the maximum limit of 60 seconds.'
    );
  });

  it('7. should report latency and execution device diagnostic metadata', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('token');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ready', device: 'cuda', compute: 'float16' }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        text: 'Hello world',
        duration: 2.1,
        latency_ms: 120,
        device: 'cuda',
        compute: 'float16',
      }),
    });

    const result = await provider.transcribe(Buffer.from('bytes'), 'audio/wav');
    expect(result.text).toBe('Hello world');
    expect(result.metadata?.latencyMs).toBe(120);
    expect(result.metadata?.device).toBe('cuda');
    expect(result.metadata?.compute).toBe('float16');
  });
});
