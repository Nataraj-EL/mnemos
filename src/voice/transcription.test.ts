import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhisperTranscriptionProvider } from './whisperTranscription';

describe('WhisperTranscriptionProvider', () => {
  let provider: WhisperTranscriptionProvider;

  beforeEach(() => {
    process.env.WHISPER_API_KEY = 'mock-whisper-key';
    provider = new WhisperTranscriptionProvider();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('should successfully transcribe an audio buffer', async () => {
    const mockResponse = { text: 'Hello, this is a test transcription.' };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as unknown as Response);

    const result = await provider.transcribe(Buffer.from('fake-audio-bytes'), 'audio/wav');
    expect(result.text).toBe('Hello, this is a test transcription.');
    expect(result.metadata?.model).toBe('whisper-1');
  });

  it('should throw an error if WHISPER_API_KEY is missing', async () => {
    delete process.env.WHISPER_API_KEY;
    const localProvider = new WhisperTranscriptionProvider();
    await expect(localProvider.transcribe(Buffer.from('bytes'))).rejects.toThrow(
      'WHISPER_API_KEY environment variable is not defined.'
    );
  });

  it('should throw an error if audio buffer is empty', async () => {
    await expect(provider.transcribe(Buffer.alloc(0))).rejects.toThrow(
      'Audio buffer cannot be empty.'
    );
  });

  it('should handle API failure response codes', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Invalid file format error',
    } as unknown as Response);

    await expect(provider.transcribe(Buffer.from('invalid-bytes'))).rejects.toThrow(
      'Whisper Transcription API error (HTTP 400): Invalid file format error'
    );
  });

  it('should handle timeout errors', async () => {
    const timeoutError = new Error('The operation was aborted.');
    timeoutError.name = 'TimeoutError';
    vi.mocked(fetch).mockRejectedValueOnce(timeoutError);

    await expect(provider.transcribe(Buffer.from('bytes'))).rejects.toThrow(
      'Transcription request timed out after 10 seconds.'
    );
  });

  it('should throw an error on empty transcription output', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '' }),
    } as unknown as Response);

    await expect(provider.transcribe(Buffer.from('bytes'))).rejects.toThrow(
      'Empty transcription: No text could be extracted from this audio.'
    );
  });
});
