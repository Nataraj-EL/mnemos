import { TranscriptionProvider } from './transcription';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export class LocalWhisperTranscriptionProvider implements TranscriptionProvider {
  private modelName: string;
  private pythonPath: string;
  private scriptPath: string;
  private tmpDir: string;

  private device: string;

  constructor() {
    this.modelName = process.env.LOCAL_WHISPER_MODEL || 'tiny.en';
    this.device = process.env.WHISPER_DEVICE || 'auto';
    // Path to the local virtual environment python binary
    this.pythonPath = path.join(process.cwd(), 'venv', 'bin', 'python3');
    this.scriptPath = path.join(process.cwd(), 'src', 'voice', 'transcribe.py');
    this.tmpDir = path.join(process.cwd(), 'src', 'voice', 'tmp');
  }

  async transcribe(
    audio: Buffer,
    mimeType?: string
  ): Promise<{
    text: string;
    metadata?: Record<string, unknown>;
  }> {
    if (!audio || audio.length === 0) {
      throw new Error('Audio buffer cannot be empty.');
    }

    // Verify python runtime and script exist
    if (!fs.existsSync(this.pythonPath) || !fs.existsSync(this.scriptPath)) {
      throw new Error('Local Whisper transcription service is currently unavailable.');
    }

    // Create tmp directory if it doesn't exist
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }

    // Generate unique temp file name
    const ext = mimeType?.includes('webm') ? '.webm' : mimeType?.includes('mp3') ? '.mp3' : '.wav';
    const tempFile = path.join(this.tmpDir, `audio_${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`);

    try {
      // Write buffer to temp file
      await fs.promises.writeFile(tempFile, audio);

      // Execute Python script with 15 second timeout
      const { stdout } = await execFileAsync(
        this.pythonPath,
        [this.scriptPath, '--audio', tempFile, '--model', this.modelName, '--device', this.device],
        { timeout: 15000 } // 15 seconds limit
      );

      const parsed = JSON.parse(stdout);

      if (parsed.error) {
        throw new Error(parsed.error);
      }

      const text = parsed.text || '';
      const trimmedText = text.trim();

      if (!trimmedText) {
        throw new Error('Empty transcription: No text could be extracted from this audio.');
      }

      return {
        text: trimmedText,
        metadata: {
          model: `local-whisper-${this.modelName}`,
          mimeType: mimeType || 'audio/wav',
          audioSize: audio.length,
          local: true,
          duration: parsed.duration,
          language: parsed.language,
          device: parsed.device,
          compute: parsed.compute,
        },
      };
    } catch (error: unknown) {
      const err = error as Error;
      if (err.name === 'TimeoutError' || err.message?.includes('timeout') || err.message?.includes('killed')) {
        throw new Error('Transcription request timed out after 15 seconds.');
      }
      
      // Map to user-friendly errors, hiding internal file paths
      const errMsg = err.message || 'An error occurred during transcription.';
      if (errMsg.includes('Empty transcription')) {
        throw err;
      }
      if (errMsg.includes('Invalid data found when processing input') || errMsg.includes('Invalid argument')) {
        throw new Error('Invalid audio format or corrupted payload.');
      }
      if (errMsg.includes('Local Whisper transcription service') || errMsg.includes('ENOENT')) {
        throw new Error('Local Whisper transcription service is currently unavailable.');
      }
      
      throw new Error('An error occurred during transcription.');
    } finally {
      // Clean up temp file
      if (fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch (cleanupErr) {
          console.error('Failed to clean up temp transcription file:', cleanupErr);
        }
      }
    }
  }
}
