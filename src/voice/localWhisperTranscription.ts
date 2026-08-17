import { TranscriptionProvider } from './transcription';
import { ChildProcess, spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

let daemonProcess: ChildProcess | null = null;
let spawnPromise: Promise<void> | null = null;
let daemonSecret: string = '';

const SECRET_FILE = path.join(process.cwd(), '.whisper_secret');

function readSavedSecret(): string {
  try {
    if (fs.existsSync(SECRET_FILE)) {
      return fs.readFileSync(SECRET_FILE, 'utf8').trim();
    }
  } catch {
    // Ignore error
  }
  return '';
}

function saveSecret(secret: string): void {
  try {
    fs.writeFileSync(SECRET_FILE, secret, 'utf8');
  } catch {
    // Ignore error
  }
}

function getPidOnPort(port: number): number | null {
  try {
    const stdout = execSync(`lsof -t -i:${port}`, { encoding: 'utf8' }).trim();
    if (stdout) {
      const pid = parseInt(stdout.split('\n')[0], 10);
      if (!isNaN(pid)) return pid;
    }
  } catch {
    // Ignore
  }
  return null;
}

function isOurWhisperProcess(pid: number): boolean {
  try {
    if (process.platform === 'linux') {
      const cmdlinePath = `/proc/${pid}/cmdline`;
      if (fs.existsSync(cmdlinePath)) {
        const cmdline = fs.readFileSync(cmdlinePath, 'utf8');
        return cmdline.includes('transcription_server.py');
      }
    }
    const args = execSync(`ps -p ${pid} -o args=`, { encoding: 'utf8' }).toLowerCase();
    return args.includes('transcription_server.py');
  } catch {
    // Ignore
  }
  return false;
}

function terminateProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    try {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    } catch {
      // Ignore
    }
  }
}

async function checkDaemonHealth(port: number, secret: string): Promise<{ healthy: boolean; status: string; error?: string }> {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 1000);
    const headers: Record<string, string> = {};
    if (secret) {
      headers['X-Whisper-Secret'] = secret;
    }
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(id);

    if (response.ok) {
      const data = await response.json();
      return { healthy: true, status: data.status, error: data.error };
    }
    if (response.status === 403) {
      return { healthy: false, status: 'forbidden' };
    }
  } catch {
    // Connection refused or timed out
  }
  return { healthy: false, status: 'none' };
}

export class LocalWhisperTranscriptionProvider implements TranscriptionProvider {
  private modelName: string;
  private port: number;
  private pythonPath: string;
  private scriptPath: string;
  private device: string;

  constructor() {
    this.modelName = process.env.LOCAL_WHISPER_MODEL || 'tiny.en';
    this.port = Number(process.env.LOCAL_WHISPER_PORT || '50051');
    this.pythonPath = path.join(process.cwd(), 'venv', 'bin', 'python3');
    this.scriptPath = path.join(process.cwd(), 'src', 'voice', 'transcription_server.py');
    this.device = process.env.WHISPER_DEVICE || 'auto';
  }

  private async ensureDaemonRunning(): Promise<void> {
    if (spawnPromise) {
      return spawnPromise;
    }

    spawnPromise = (async () => {
      // 1. Read existing secret and ping
      let secret = readSavedSecret();
      let health = await checkDaemonHealth(this.port, secret);

      if (health.healthy) {
        if (health.status === 'error') {
          throw new Error(`Model loading failed: ${health.error}`);
        }
        daemonSecret = secret;
        return; // Already running and healthy
      }

      // If forbidden, it means a daemon is running with a different secret
      if (health.status === 'forbidden') {
        const pid = getPidOnPort(this.port);
        if (pid && isOurWhisperProcess(pid)) {
          terminateProcess(pid);
          // Wait a short moment for the port to release
          await new Promise((resolve) => setTimeout(resolve, 500));
          // Re-check health
          health = await checkDaemonHealth(this.port, secret);
          if (health.status === 'forbidden') {
            throw new Error(`Local Whisper port conflict: Port ${this.port} is already in use by another process.`);
          }
        } else {
          throw new Error(`Local Whisper port conflict: Port ${this.port} is already in use by another process.`);
        }
      }

      // Verify python runtime and script exist
      if (!fs.existsSync(this.pythonPath) || !fs.existsSync(this.scriptPath)) {
        throw new Error('Local Whisper transcription service is currently unavailable.');
      }

      // 2. Generate a new secret and write to file
      secret = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
      saveSecret(secret);
      daemonSecret = secret;

      // 3. Spawn daemon
      const child = spawn(
        this.pythonPath,
        [
          this.scriptPath,
          '--port', String(this.port),
          '--model', this.modelName,
          '--device', this.device,
          '--secret', secret,
        ],
        {
          detached: true,
          stdio: 'ignore',
        }
      );

      child.unref();
      daemonProcess = child;

      // Check if child exited immediately (port conflict, error)
      let childExited = false;
      let childExitCode: number | null = null;
      child.on('exit', (code) => {
        childExited = true;
        childExitCode = code;
        daemonProcess = null;
        spawnPromise = null;
      });

      // 4. Poll /health until status is 'ready'
      const start = Date.now();
      const timeoutMs = 25000; // 25s max timeout
      while (Date.now() - start < timeoutMs) {
        if (childExited) {
          throw new Error(`Local Whisper daemon exited unexpectedly with code ${childExitCode}.`);
        }

        health = await checkDaemonHealth(this.port, secret);
        if (health.healthy) {
          if (health.status === 'ready') {
            return; // Successfully loaded and ready!
          }
          if (health.status === 'error') {
            throw new Error(`Model loading failed: ${health.error}`);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Timeout waiting for ready status
      if (daemonProcess) {
        daemonProcess.kill('SIGKILL');
        daemonProcess = null;
      }
      spawnPromise = null;
      throw new Error('Local Whisper daemon failed to load within 25 seconds.');
    })();

    try {
      await spawnPromise;
    } catch (e) {
      spawnPromise = null; // Reset promise so subsequent requests can retry
      throw e;
    }
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

    // Ensure daemon is active and model is ready
    await this.ensureDaemonRunning();

    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/transcribe`, {
        method: 'POST',
        headers: {
          'Content-Type': mimeType || 'audio/wav',
          'X-Whisper-Secret': daemonSecret,
        },
        body: audio as unknown as BodyInit,
        signal: AbortSignal.timeout(15000), // 15-second timeout
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP error ${response.status}`);
      }

      const parsed = await response.json();

      const text = parsed.text || '';
      const normalized = normalizeTranscript(text);

      if (!normalized || normalized.length < 3) {
        throw new Error('Empty transcription: No text could be extracted from this audio.');
      }

      return {
        text: normalized,
        metadata: {
          model: `local-whisper-${this.modelName}`,
          mimeType: mimeType || 'audio/wav',
          audioSize: audio.length,
          local: true,
          duration: parsed.duration,
          language: parsed.language,
          device: parsed.device,
          compute: parsed.compute,
          latencyMs: parsed.latency_ms,
        },
      };
    } catch (error: unknown) {
      const err = error as Error;
      if (err.name === 'TimeoutError' || err.message?.includes('timeout') || err.message?.includes('aborted')) {
        throw new Error('Transcription request timed out after 15 seconds.');
      }

      const errMsg = err.message || 'An error occurred during transcription.';
      if (errMsg.includes('Empty transcription')) {
        throw err;
      }
      if (errMsg.includes('exceeds the maximum limit')) {
        throw new Error('Audio duration exceeds the maximum limit of 60 seconds.');
      }
      if (errMsg.includes('Invalid data found when processing input') || errMsg.includes('Invalid argument')) {
        throw new Error('Invalid audio format or corrupted payload.');
      }
      if (errMsg.includes('Local Whisper transcription service') || errMsg.includes('ENOENT') || errMsg.includes('fetch failed')) {
        throw new Error('Local Whisper transcription service is currently unavailable.');
      }
      if (errMsg.includes('busy')) {
        throw new Error('Transcription engine is busy. Please try again.');
      }

      throw new Error('An error occurred during transcription.');
    }
  }

  async getStatus(): Promise<{ healthy: boolean; status: string; port: number; model: string; device: string }> {
    const secret = readSavedSecret();
    const health = await checkDaemonHealth(this.port, secret);
    return {
      healthy: health.healthy,
      status: health.status,
      port: this.port,
      model: this.modelName,
      device: this.device,
    };
  }

  static resetDaemonState(): void {
    spawnPromise = null;
    daemonProcess = null;
    daemonSecret = '';
  }
}

// Register process exit handler to stop daemon spawned by this process
function cleanup() {
  if (daemonProcess) {
    try {
      daemonProcess.kill('SIGKILL');
    } catch {
      // Ignore
    }
    daemonProcess = null;
  }
  try {
    if (fs.existsSync(SECRET_FILE)) {
      fs.unlinkSync(SECRET_FILE);
    }
  } catch {
    // Ignore
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

export function normalizeTranscript(text: string): string {
  let trimmed = text.trim();
  if (!trimmed) return '';
  trimmed = trimmed.replace(/[ \t]+/g, ' ');
  trimmed = trimmed.replace(/[ \t]*\n[ \t]*/g, '\n');
  trimmed = trimmed.replace(/\n\s*\n+/g, '\n\n');
  return trimmed;
}
