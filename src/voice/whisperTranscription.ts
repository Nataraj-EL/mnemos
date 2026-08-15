import { TranscriptionProvider } from './transcription';

export class WhisperTranscriptionProvider implements TranscriptionProvider {
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = process.env.WHISPER_API_KEY;
  }

  async transcribe(
    audio: Buffer,
    mimeType?: string
  ): Promise<{
    text: string;
    metadata?: Record<string, unknown>;
  }> {
    if (!this.apiKey) {
      throw new Error('WHISPER_API_KEY environment variable is not defined.');
    }
    if (!audio || audio.length === 0) {
      throw new Error('Audio buffer cannot be empty.');
    }

    const url = 'https://api.openai.com/v1/audio/transcriptions';
    
    // Create FormData natively in Node.js
    const formData = new FormData();
    const blob = new Blob([audio as unknown as BlobPart], { type: mimeType || 'audio/wav' });
    formData.append('file', blob, 'audio.wav');
    formData.append('model', 'whisper-1');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: formData,
        signal: AbortSignal.timeout(10000), // 10-second timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Whisper Transcription API error (HTTP ${response.status}): ${errorText}`);
      }

      const json = (await response.json()) as { text?: string };
      const text = json?.text;

      if (text === undefined || text === null) {
        throw new Error('Malformed response: "text" field is missing.');
      }

      const trimmedText = text.trim();
      if (!trimmedText) {
        throw new Error('Empty transcription: No text could be extracted from this audio.');
      }

      return {
        text: trimmedText,
        metadata: {
          model: 'whisper-1',
          mimeType: mimeType || 'audio/wav',
          audioSize: audio.length,
        },
      };
    } catch (error: unknown) {
      const err = error as Error;
      if (err.name === 'TimeoutError' || err.message?.includes('timeout') || err.message?.includes('signal')) {
        throw new Error('Transcription request timed out after 10 seconds.');
      }
      console.error('Error during Whisper transcription:', error);
      throw error;
    }
  }
}
