/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalWhisperTranscriptionProvider } from './localWhisperTranscription';
import { execFile } from 'child_process';
import * as fs from 'fs';

// Mock child_process and fs modules
vi.mock('child_process', () => {
  return {
    execFile: vi.fn(),
  };
});

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    promises: {
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
    unlinkSync: vi.fn(),
  };
});

describe('LocalWhisperTranscriptionProvider', () => {
  let provider: LocalWhisperTranscriptionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LOCAL_WHISPER_MODEL = 'tiny.en';
    process.env.WHISPER_DEVICE = 'auto';
    provider = new LocalWhisperTranscriptionProvider();
  });

  it('should successfully transcribe an audio buffer using local Python execution', async () => {
    // Mock existence check for python binary and script
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (typeof p === 'string' && (p.includes('python3') || p.includes('transcribe.py'))) {
        return true;
      }
      return false;
    });

    // Mock successful output from Python script execution
    const mockStdout = JSON.stringify({
      text: 'Hello, this is a local transcription test.',
      language: 'en',
      duration: 3.5,
      device: 'cpu',
      compute: 'int8',
    });

    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
      // execFile signature: (file, args, options, callback)
      if (callback) {
        callback(null, { stdout: mockStdout, stderr: '' } as any, '');
      }
      return {} as any;
    });

    const result = await provider.transcribe(Buffer.from('dummy-audio-bytes'), 'audio/wav');
    expect(result.text).toBe('Hello, this is a local transcription test.');
    expect(result.metadata?.model).toBe('local-whisper-tiny.en');
    expect(result.metadata?.local).toBe(true);
    expect(result.metadata?.duration).toBe(3.5);
    expect(result.metadata?.device).toBe('cpu');
  });

  it('should throw an error if audio buffer is empty', async () => {
    await expect(provider.transcribe(Buffer.alloc(0))).rejects.toThrow(
      'Audio buffer cannot be empty.'
    );
  });

  it('should throw a friendly error if local Python environment or script is missing', async () => {
    // Mock runtime files not existing
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await expect(provider.transcribe(Buffer.from('bytes'))).rejects.toThrow(
      'Local Whisper transcription service is currently unavailable.'
    );
  });

  it('should throw an error on empty transcription output', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const mockStdout = JSON.stringify({
      text: '',
      language: 'en',
      duration: 0,
    });

    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
      if (callback) {
        callback(null, { stdout: mockStdout, stderr: '' } as any, '');
      }
      return {} as any;
    });

    await expect(provider.transcribe(Buffer.from('bytes'))).rejects.toThrow(
      'Empty transcription: No text could be extracted from this audio.'
    );
  });

  it('should handle Python execution errors gracefully without exposing internal paths', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const pythonError = new Error('Some Python traceback file "/home/user/venv/lib/..." key error');
    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
      if (callback) {
        callback(pythonError, { stdout: '', stderr: 'Traceback details' } as any, '');
      }
      return {} as any;
    });

    await expect(provider.transcribe(Buffer.from('bytes'))).rejects.toThrow(
      'An error occurred during transcription.'
    );
  });

  it('should map invalid format errors to user-friendly messages', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
      if (callback) {
        callback(null, { stdout: JSON.stringify({ error: 'Invalid data found when processing input' }), stderr: '' } as any, '');
      }
      return {} as any;
    });

    await expect(provider.transcribe(Buffer.from('invalid-bytes'))).rejects.toThrow(
      'Invalid audio format or corrupted payload.'
    );
  });

  it('should handle timeout errors correctly when execution times out', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const timeoutError = new Error('killed');
    (timeoutError as any).name = 'TimeoutError';

    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
      if (callback) {
        callback(timeoutError, { stdout: '', stderr: '' } as any, '');
      }
      return {} as any;
    });

    await expect(provider.transcribe(Buffer.from('bytes'))).rejects.toThrow(
      'Transcription request timed out after 15 seconds.'
    );
  });
});
