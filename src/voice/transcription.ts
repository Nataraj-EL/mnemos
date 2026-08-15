export interface TranscriptionProvider {
  transcribe(
    audio: Buffer,
    mimeType?: string
  ): Promise<{
    text: string;
    metadata?: Record<string, unknown>;
  }>;
}
