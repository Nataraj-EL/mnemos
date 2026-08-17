export interface VoiceRequestDiagnostic {
  requestId: string;
  provider: 'cloud' | 'local';
  mimeBaseType: string;
  audioSize: number;
  duration?: number;
  latencyMs: number;
  status: 'success' | 'error';
  errorCategory?: string;
  timestamp: string;
}

export interface VoiceHealthInfo {
  provider: 'cloud' | 'local';
  localWhisperAvailable: boolean;
  daemonState: 'ready' | 'loading' | 'error' | 'none' | 'forbidden';
  supportedMimeTypes: string[];
  lastFailureCategory: string | null;
  latestRequest: VoiceRequestDiagnostic | null;
}

class VoiceDiagnosticsManager {
  private history: VoiceRequestDiagnostic[] = [];
  private lastFailureCategory: string | null = null;

  record(diag: Omit<VoiceRequestDiagnostic, 'timestamp'>) {
    const recordWithTime: VoiceRequestDiagnostic = {
      ...diag,
      timestamp: new Date().toISOString(),
    };
    this.history.unshift(recordWithTime);
    if (this.history.length > 50) {
      this.history.pop();
    }
    if (diag.status === 'error' && diag.errorCategory) {
      this.lastFailureCategory = diag.errorCategory;
    }
  }

  getHistory(): VoiceRequestDiagnostic[] {
    return [...this.history];
  }

  getLatest(): VoiceRequestDiagnostic | null {
    return this.history[0] || null;
  }

  getLastFailureCategory(): string | null {
    return this.lastFailureCategory;
  }

  clear() {
    this.history = [];
    this.lastFailureCategory = null;
  }
}

export const voiceDiagnostics = new VoiceDiagnosticsManager();
