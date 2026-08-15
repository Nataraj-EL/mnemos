'use client';
/* eslint-disable react-hooks/purity */

import { useEffect, useState } from 'react';
import { deriveLifecycleState } from '@/core/types';
import type { Memory as PackageMemory } from '@/core/types';

interface MemoryMetadata {
  source: string;
  confidence: number;
  importance: number;
  timestamp: string;
  status?: 'active' | 'superseded';
  [key: string]: unknown;
}

interface Memory {
  id: string;
  userId: string;
  type: string;
  content: string;
  metadata: MemoryMetadata;
  createdAt: string;
  updatedAt: string;
}

interface ContextItem {
  id: string;
  type: string;
  content: string;
  similarity: number;
  importance: number;
  score: number;
  reason: string;
}

interface ContextResult {
  query: string;
  items: ContextItem[];
  context: string;
  tokenCount: number;
}

interface EvalScenarioMetrics {
  retrievalRecall: number;
  contextPrecision: number;
  userIsolation: number;
  deduplicationRate: number;
  tokenCompliance: number;
}

interface EvalScenarioResult {
  scenarioId: string;
  name: string;
  passed: boolean;
  metrics: EvalScenarioMetrics;
  latencyMs: number;
  failureReason?: string;
}

interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  retrievalRecall: number;
  contextPrecision: number;
  isolationRate: number;
  deduplicationRate: number;
  tokenCompliance: number;
  averageLatency: number;
}

interface HealthResponse {
  status: string;
  timestamp: string;
  services: {
    app: string;
    database: string;
  };
}

const getLifecycleColor = (state: string) => {
  switch (state) {
    case 'core':
      return { bg: 'rgba(91, 138, 82, 0.15)', text: '#5b8a52', border: '#5b8a52' };
    case 'stable':
      return { bg: 'rgba(74, 114, 153, 0.15)', text: '#4a7299', border: '#4a7299' };
    case 'fading':
      return { bg: 'rgba(219, 145, 66, 0.15)', text: '#db9142', border: '#db9142' };
    case 'historical':
    default:
      return { bg: 'rgba(128, 128, 128, 0.15)', text: 'gray', border: 'gray' };
  }
};

const renderMarkdown = (text: string) => {
  if (!text) return null;
  const lines = text.split('\n');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {lines.map((line, idx) => {
        const isBullet = line.trim().startsWith('* ') || line.trim().startsWith('- ');
        let content = line.trim();
        if (isBullet) {
          content = content.replace(/^[\*\-]\s+/, '');
        }
        
        const parts = [];
        let match;
        let lastIndex = 0;
        const boldRegex = /\*\*([^\*]+)\*\*/g;
        
        while ((match = boldRegex.exec(content)) !== null) {
          const before = content.substring(lastIndex, match.index);
          if (before) parts.push(before);
          parts.push(<strong key={match.index} style={{ color: 'var(--primary)', fontWeight: 650 }}>{match[1]}</strong>);
          lastIndex = boldRegex.lastIndex;
        }
        
        const after = content.substring(lastIndex);
        if (after) parts.push(after);
        
        const lineEl = parts.length > 0 ? parts : content;
        
        if (isBullet) {
          return (
            <div key={idx} style={{ display: 'flex', gap: '0.5rem', paddingLeft: '0.75rem', fontSize: '0.85rem', lineHeight: '1.6', alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--primary)', fontSize: '0.8rem', marginTop: '0.1rem' }}>•</span>
              <span style={{ flex: 1 }}>{lineEl}</span>
            </div>
          );
        }
        
        if (!line.trim()) {
          return <div key={idx} style={{ height: '0.25rem' }} />;
        }
        
        return (
          <p key={idx} style={{ margin: 0, fontSize: '0.85rem', lineHeight: '1.6' }}>
            {lineEl}
          </p>
        );
      })}
    </div>
  );
};

export default function MemoryDashboard() {
  // Navigation & Workspace State Tabs
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<'workspace' | 'developer'>('workspace');
  const [activeIntelligenceTab, setActiveIntelligenceTab] = useState<'ask' | 'search' | 'context'>('ask');

  // Voice Transcription State
  const [isRecording, setIsRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const [transcribeLoading, setTranscribeLoading] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [transcribeError, setTranscribeError] = useState<string | null>(null);

  // Timer effect for voice recording
  useEffect(() => {
    if (!isRecording) return;
    const interval = setInterval(() => {
      setRecordingTime((prev) => prev + 1);
    }, 1000);
    return () => {
      clearInterval(interval);
      setRecordingTime(0);
    };
  }, [isRecording]);

  const startRecording = async () => {
    setTranscribeError(null);
    setTranscript('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      recorder.onstop = async () => {
        const audioBlob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        stream.getTracks().forEach((track) => track.stop());
        await uploadAudio(audioBlob);
      };

      recorder.start();
      setMediaRecorder(recorder);
      setIsRecording(true);
    } catch (err: unknown) {
      console.error('Failed to start recording:', err);
      setTranscribeError('Could not access microphone. Please check permissions.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      setIsRecording(false);
    }
  };

  const uploadAudio = async (blob: Blob) => {
    setTranscribeLoading(true);
    setTranscribeError(null);
    const start = Date.now();

    try {
      const formData = new FormData();
      formData.append('file', blob, 'recording.webm');

      // Use authorization header if public/local api key is set
      const headers: Record<string, string> = {};
      if (process.env.NEXT_PUBLIC_MNEMOS_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.NEXT_PUBLIC_MNEMOS_API_KEY}`;
      }

      const response = await fetch('/api/v1/voice/transcribe', {
        method: 'POST',
        headers,
        body: formData,
      });

      const data = await response.json();
      const latency = Date.now() - start;
      const reqId = data.requestId || 'req-' + Math.random().toString(36).substring(2, 9);

      setRequestMetrics((prev) => [
        {
          id: reqId,
          timestamp: new Date().toISOString(),
          endpoint: 'POST /api/v1/voice/transcribe',
          latency,
          status: response.ok ? '200 OK' : `${response.status} Error`,
        },
        ...prev,
      ]);

      if (!response.ok) {
        setTranscribeError(data.error || 'Failed to transcribe audio.');
      } else {
        setTranscript(data.data.text);
      }
    } catch (err: unknown) {
      console.error('Transcription upload failed:', err);
      setTranscribeError('An error occurred during transcription upload.');
    } finally {
      setTranscribeLoading(false);
    }
  };

  // Consolidation State
  const [loadingConsolidate, setLoadingConsolidate] = useState(false);
  const [consolidateMessage, setConsolidateMessage] = useState<string | null>(null);

  const handleConsolidate = async () => {
    if (!userId.trim()) return;
    setLoadingConsolidate(true);
    setConsolidateMessage(null);
    try {
      const res = await fetch('/api/memory/consolidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userId.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.status === 'success') {
        setConsolidateMessage(`Consolidation successful! Consolidated ${data.consolidatedCount} duplicate records.`);
        fetchMemories();
      } else {
        setConsolidateMessage(`Consolidation failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setConsolidateMessage(`Consolidation failed: ${errMsg}`);
    } finally {
      setLoadingConsolidate(false);
    }
  };

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loadingHealth, setLoadingHealth] = useState(true);
  const [healthError, setHealthError] = useState(false);

  // Ingestion form state
  const [userId, setUserId] = useState('user-123');
  const [contentInput, setContentInput] = useState('');
  const [ingestLoading, setIngestLoading] = useState(false);
  const [ingestMessage, setIngestMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Memories list state
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loadingMemories, setLoadingMemories] = useState(true);

  // Search State
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ memory: Memory; similarity: number }[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Mount State
  const [mounted, setMounted] = useState(false);

  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !userId.trim()) return;

    setSearchLoading(true);
    setSearchError(null);
    const start = Date.now();

    try {
      const response = await fetch(
        `/api/memory/search?userId=${encodeURIComponent(userId.trim())}&q=${encodeURIComponent(
          searchQuery.trim()
        )}`
      );
      const data = await response.json();
      const latency = Date.now() - start;
      const reqId = data.requestId || 'req-' + Math.random().toString(36).substring(2, 9);

      setRequestMetrics((prev) => [
        {
          id: reqId,
          timestamp: new Date().toISOString(),
          endpoint: 'POST /api/memory/search',
          latency,
          status: response.ok ? '200 OK' : `${response.status} Error`,
        },
        ...prev,
      ]);

      if (!response.ok) {
        setSearchError(data.error || 'Failed to execute search.');
      } else {
        setSearchResults(data.results || []);
      }
    } catch (err) {
      console.error('Search Error:', err);
      const latency = Date.now() - start;
      const reqId = 'req-' + Math.random().toString(36).substring(2, 9);
      setRequestMetrics((prev) => [
        {
          id: reqId,
          timestamp: new Date().toISOString(),
          endpoint: 'POST /api/memory/search',
          latency,
          status: '500 Error',
        },
        ...prev,
      ]);
      setSearchError('An error occurred during search.');
    } finally {
      setSearchLoading(false);
    }
  };

  // Context Assembly State
  const [contextQuery, setContextQuery] = useState('');
  const [contextLimit, setContextLimit] = useState(10);
  const [contextMaxTokens, setContextMaxTokens] = useState(1500);
  const [contextResult, setContextResult] = useState<ContextResult | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);

  const handleContextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contextQuery.trim() || !userId.trim()) return;

    setContextLoading(true);
    setContextError(null);
    setContextResult(null);
    const start = Date.now();

    try {
      const response = await fetch('/api/memory/context', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: userId.trim(),
          query: contextQuery.trim(),
          limit: Number(contextLimit),
          maxTokens: Number(contextMaxTokens),
        }),
      });

      const data = await response.json();
      const latency = Date.now() - start;
      const reqId = data.requestId || 'req-' + Math.random().toString(36).substring(2, 9);

      setRequestMetrics((prev) => [
        {
          id: reqId,
          timestamp: new Date().toISOString(),
          endpoint: 'POST /api/memory/context',
          latency,
          status: response.ok ? '200 OK' : `${response.status} Error`,
        },
        ...prev,
      ]);

      if (!response.ok) {
        setContextError(data.error || 'Failed to assemble context.');
      } else {
        setContextResult(data);
      }
    } catch (err) {
      console.error('Context Assembly Error:', err);
      const latency = Date.now() - start;
      const reqId = 'req-' + Math.random().toString(36).substring(2, 9);
      setRequestMetrics((prev) => [
        {
          id: reqId,
          timestamp: new Date().toISOString(),
          endpoint: 'POST /api/memory/context',
          latency,
          status: '500 Error',
        },
        ...prev,
      ]);
      setContextError('An error occurred during context assembly.');
    } finally {
      setContextLoading(false);
    }
  };

  // Contextual Response State
  const [responseQuery, setResponseQuery] = useState('');
  const [responseLimit, setResponseLimit] = useState(10);
  const [responseMaxTokens, setResponseMaxTokens] = useState(1500);
  const [responseResult, setResponseResult] = useState<{
    response: string;
    usedMemories: { id: string; type: string; similarity: number; score: number }[];
    contextTokenCount: number;
    governance?: {
      allowedCount: number;
      downrankedCount: number;
      excludedCount: number;
      conflictsDetectedCount: number;
      lowConfidenceCount: number;
      injectionBlockedCount: number;
      details: Record<string, { decision: 'ALLOW' | 'DOWNRANK' | 'EXCLUDE'; reasons: string[] }>;
    };
  } | null>(null);
  const [responseLoading, setResponseLoading] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);

  // Developer API & System Health Console
  const [healthData, setHealthData] = useState<{
    service: string;
    database: string;
    provider: string;
    authEnabled?: boolean;
    rateLimitMax?: number;
    rateLimitWindow?: number;
  } | null>(null);
  const [activeDocTab, setActiveDocTab] = useState<'ingest' | 'search' | 'context' | 'respond' | 'health'>('ingest');
  const [requestMetrics, setRequestMetrics] = useState<{
    id: string;
    timestamp: string;
    endpoint: string;
    latency: number;
    status: string;
  }[]>([]);

  const handleResponseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!responseQuery.trim() || !userId.trim()) return;

    setResponseLoading(true);
    setResponseError(null);
    setResponseResult(null);
    const start = Date.now();

    try {
      const response = await fetch('/api/memory/respond', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: userId.trim(),
          query: responseQuery.trim(),
          limit: Number(responseLimit),
          maxTokens: Number(responseMaxTokens),
        }),
      });

      const data = await response.json();
      const latency = Date.now() - start;
      const reqId = data.requestId || 'req-' + Math.random().toString(36).substring(2, 9);

      setRequestMetrics((prev) => [
        {
          id: reqId,
          timestamp: new Date().toISOString(),
          endpoint: 'POST /api/memory/respond',
          latency,
          status: response.ok ? '200 OK' : `${response.status} Error`,
        },
        ...prev,
      ]);

      if (!response.ok) {
        setResponseError(data.error || 'Failed to generate contextual response.');
      } else {
        setResponseResult(data);
      }
    } catch (err) {
      console.error('Response Generation Error:', err);
      const latency = Date.now() - start;
      const reqId = 'req-' + Math.random().toString(36).substring(2, 9);
      setRequestMetrics((prev) => [
        {
          id: reqId,
          timestamp: new Date().toISOString(),
          endpoint: 'POST /api/memory/respond',
          latency,
          status: '500 Error',
        },
        ...prev,
      ]);
      setResponseError('An error occurred during response generation.');
    } finally {
      setResponseLoading(false);
    }
  };

  // Evaluation State
  const [evalSummary, setEvalSummary] = useState<EvalSummary | null>(null);
  const [evalResults, setEvalResults] = useState<EvalScenarioResult[]>([]);
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  const handleRunEvaluation = async () => {
    setEvalLoading(true);
    setEvalError(null);
    setEvalSummary(null);
    setEvalResults([]);

    try {
      const response = await fetch('/api/evaluation/run', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) {
        console.warn('Server evaluation endpoint returned error. Running locally in browser...', data.error);
        const { EvaluationRunner } = await import('@/evaluation/runner');
        const runner = new EvaluationRunner();
        const localResult = await runner.runAll();
        setEvalSummary(localResult.summary);
        setEvalResults(localResult.results);
      } else {
        setEvalSummary(data.summary);
        setEvalResults(data.results);
      }
    } catch (err) {
      console.error('Failed to execute evaluation:', err);
      setEvalError('An unexpected error occurred during evaluation.');
    } finally {
      setEvalLoading(false);
    }
  };

  const fetchHealth = async () => {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) {
        setHealthError(true);
      } else {
        setHealthError(false);
      }
      const data = await response.json();
      setHealth(data);

      const v1Res = await fetch('/api/v1/memory/health');
      const v1Data = await v1Res.json();
      if (v1Data.status === 'success' || v1Data.data) {
        setHealthData(v1Data.data);
      } else {
        setHealthData({ service: 'healthy', database: 'unhealthy', provider: 'unhealthy' });
      }
    } catch (err) {
      console.error('Failed to fetch system status:', err);
      setHealthError(true);
      setHealth(null);
      setHealthData({ service: 'healthy', database: 'unhealthy', provider: 'unhealthy' });
    } finally {
      setLoadingHealth(false);
    }
  };

  const fetchMemories = async () => {
    if (!userId.trim()) return;
    try {
      setLoadingMemories(true);
      const response = await fetch(`/api/memory?userId=${encodeURIComponent(userId.trim())}`);
      if (response.ok) {
        const data = await response.json();
        setMemories(data.memories || []);
      }
    } catch (err) {
      console.error('Failed to fetch memories:', err);
    } finally {
      setLoadingMemories(false);
    }
  };

  useEffect(() => {
    setTimeout(() => {
      setMounted(true);
      fetchHealth();
    }, 0);
    const healthInterval = setInterval(fetchHealth, 15000);
    return () => clearInterval(healthInterval);
  }, []);

  useEffect(() => {
    setTimeout(() => {
      fetchMemories();
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const handleIngestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contentInput.trim() || !userId.trim()) return;

    setIngestLoading(true);
    setIngestMessage(null);
    const start = Date.now();

    try {
      const response = await fetch('/api/memory/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: userId.trim(),
          content: contentInput.trim(),
        }),
      });

      const data = await response.json();
      const latency = Date.now() - start;
      const reqId = data.requestId || 'req-' + Math.random().toString(36).substring(2, 9);

      setRequestMetrics((prev) => [
        {
          id: reqId,
          timestamp: new Date().toISOString(),
          endpoint: 'POST /api/memory/ingest',
          latency,
          status: response.ok ? '200 OK' : `${response.status} Error`,
        },
        ...prev,
      ]);

      if (!response.ok) {
        setIngestMessage({
          type: 'error',
          text: data.error || 'Failed to ingest memory.',
        });
      } else {
        setIngestMessage({
          type: 'success',
          text: `Successfully processed ingestion pipeline. Reconciled memory changes.`,
        });
        setContentInput('');
        fetchMemories();
      }
    } catch (err) {
      console.error('Ingestion Error:', err);
      const latency = Date.now() - start;
      const reqId = 'req-' + Math.random().toString(36).substring(2, 9);
      setRequestMetrics((prev) => [
        {
          id: reqId,
          timestamp: new Date().toISOString(),
          endpoint: 'POST /api/memory/ingest',
          latency,
          status: '500 Error',
        },
        ...prev,
      ]);
      setIngestMessage({
        type: 'error',
        text: 'An error occurred during submission.',
      });
    } finally {
      setIngestLoading(false);
    }
  };

  const requestCount = requestMetrics.length;
  const avgLatency = requestCount > 0
    ? Math.round(requestMetrics.reduce((sum, r) => sum + r.latency, 0) / requestCount)
    : 0;
  const errorCount = requestMetrics.filter(r => !r.status.includes('200') && !r.status.includes('OK')).length;

  const isDbConnected = health?.services.database === 'connected';
  const isAppHealthy = health?.status === 'healthy';

  const renderSpinner = () => (
    <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ marginRight: '0.35rem', display: 'inline-block', verticalAlign: 'middle' }}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" style={{ opacity: 0.25 }} />
      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @keyframes spin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
            .animate-spin {
              animation: spin 1s linear infinite;
            }
            .premium-btn {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              gap: 0.4rem;
              padding: 0.45rem 0.9rem;
              font-size: 0.8rem;
              font-weight: 600;
              border-radius: var(--radius-sm);
              border: 1px solid rgba(161, 70, 28, 0.25);
              cursor: pointer;
              transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
              box-shadow: 0 1px 2px rgba(161, 70, 28, 0.05);
              font-family: inherit;
              user-select: none;
            }
            .premium-btn-primary {
              background-color: var(--primary);
              color: #ffffff;
              border-color: var(--primary-hover);
            }
            .premium-btn-primary:hover:not(:disabled) {
              background-color: var(--primary-hover);
              transform: translateY(-1px);
              box-shadow: 0 4px 10px rgba(161, 70, 28, 0.15);
            }
            .premium-btn-primary:active:not(:disabled) {
              transform: translateY(1px);
              box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.1);
            }
            .premium-btn-primary:focus-visible {
              outline: none;
              box-shadow: 0 0 0 2px var(--background), 0 0 0 4px var(--primary);
            }
            .premium-btn:disabled {
              opacity: 0.5;
              cursor: not-allowed;
              transform: none !important;
              box-shadow: none !important;
            }
            .premium-btn-secondary {
              background-color: var(--surface);
              color: var(--text);
              border-color: var(--border);
            }
            .premium-btn-secondary:hover:not(:disabled) {
              background-color: var(--muted);
              border-color: var(--border);
              transform: translateY(-1px);
            }
            .premium-btn-secondary:active:not(:disabled) {
              transform: translateY(1px);
            }
            .premium-btn-secondary:focus-visible {
              outline: none;
              box-shadow: 0 0 0 2px var(--background), 0 0 0 3px var(--border);
            }
            .toggle-container {
              display: flex;
              gap: 0.25rem;
              background-color: var(--muted);
              padding: 0.25rem;
              border-radius: var(--radius-sm);
              border: 1px solid var(--border);
            }
            .toggle-button {
              padding: 0.4rem 0.8rem;
              border: none;
              background-color: transparent;
              color: var(--text);
              font-weight: 500;
              border-radius: var(--radius-xs);
              font-size: 0.8rem;
              cursor: pointer;
              transition: all 150ms ease;
              user-select: none;
              display: inline-flex;
              align-items: center;
              gap: 0.35rem;
            }
            .toggle-button:hover:not(.active) {
              background-color: rgba(38, 30, 26, 0.05);
            }
            .toggle-button.active {
              background-color: var(--surface);
              color: var(--primary);
              font-weight: 600;
              box-shadow: var(--shadow-sm);
            }
            .tabs-container {
              display: flex;
              gap: 0.25rem;
              background-color: var(--muted);
              padding: 0.25rem;
              border-radius: var(--radius-sm);
              border: 1px solid var(--border);
            }
            .tab-button {
              padding: 0.45rem 1rem;
              border: none;
              background-color: transparent;
              color: var(--text);
              font-weight: 500;
              border-radius: var(--radius-xs);
              font-size: 0.8rem;
              cursor: pointer;
              transition: all 150ms ease;
              user-select: none;
              display: inline-flex;
              align-items: center;
              gap: 0.35rem;
            }
            .tab-button:hover:not(.active) {
              background-color: rgba(38, 30, 26, 0.05);
            }
            .tab-button.active {
              background-color: var(--surface);
              color: var(--primary);
              font-weight: 600;
              box-shadow: var(--shadow-sm);
            }
            @keyframes pulse {
              0% { opacity: 0.6; }
              50% { opacity: 1; }
              100% { opacity: 0.6; }
            }
            .pulse {
              animation: pulse 1.5s infinite ease-in-out;
            }
          `,
        }}
      />

      {/* Navigation Bar */}
      <nav className="navbar">
        <div className="brand">
          <div className="brand-text">
            <span className="brand-name">Mnemos</span>
            <span className="brand-tagline">Persistent AI Memory</span>
          </div>
        </div>

        {/* View Toggle */}
        <div className="toggle-container">
          <button
            onClick={() => setActiveWorkspaceTab('workspace')}
            className={`toggle-button ${activeWorkspaceTab === 'workspace' ? 'active' : ''}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
              <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" />
            </svg>
            Product Workspace
          </button>
          <button
            onClick={() => setActiveWorkspaceTab('developer')}
            className={`toggle-button ${activeWorkspaceTab === 'developer' ? 'active' : ''}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
              <polyline points="4 17 10 11 4 5" /><line x1="12" x2="20" y1="19" y2="19" />
            </svg>
            Developer Console
          </button>
        </div>

        <div className="status-badge" id="system-status-container">
          <span
            className={`status-dot ${
              loadingHealth ? 'warning' : healthError ? 'error' : isAppHealthy ? 'success' : 'error'
            }`}
            id="status-indicator-dot"
          ></span>
          <span id="status-indicator-text">
            {loadingHealth
              ? 'Checking status...'
              : healthError
              ? 'Offline'
              : isAppHealthy
              ? 'Operational'
              : 'Degraded'}
          </span>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="container" style={{ flexGrow: 1, paddingTop: '1.5rem' }}>
        {/* Compact Hero/Config section */}
        <section style={{ marginBottom: '2rem', padding: '1.5rem', backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1.5rem' }}>
          <div>
            <h1 style={{ fontSize: '1.75rem', color: 'var(--primary)', marginBottom: '0.25rem', fontWeight: 700 }}>Mnemos</h1>
            <p style={{ fontSize: '0.85rem', opacity: 0.7, margin: 0, maxWidth: '600px' }}>
              Persistent Memory & Context Engine for Personal AI. Establishes long-term state, recall, and contextual continuity across conversations.
            </p>
          </div>
          
          {/* Status chips */}
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div className="status-badge" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}>
              <span>App:</span>
              <span className={`status-dot ${isAppHealthy ? 'success' : 'error'}`} style={{ width: '6px', height: '6px' }} />
              <strong>{loadingHealth ? 'LOADING' : isAppHealthy ? 'ONLINE' : 'OFFLINE'}</strong>
            </div>
            <div className="status-badge" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}>
              <span>Database:</span>
              <span className={`status-dot ${isDbConnected ? 'success' : 'error'}`} style={{ width: '6px', height: '6px' }} />
              <strong>{loadingHealth ? 'LOADING' : isDbConnected ? 'CONNECTED' : 'DISCONNECTED'}</strong>
            </div>
            <div className="status-badge" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}>
              <span>Memories:</span>
              <strong>{memories.length} Active</strong>
            </div>
          </div>
        </section>

        {activeWorkspaceTab === 'workspace' ? (
          /* ========================================== */
          /*         PRODUCT WORKSPACE VIEW             */
          /* ========================================== */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            
            {/* 1. MEMORY STORE (Ingest + Persisted Memories) */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem', alignItems: 'start' }}>
              
              {/* Ingestion Form */}
              <div className="card" style={{ padding: '1.25rem' }}>
                <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600 }}>Ingest Raw Interaction</h3>
                <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                  Submit texts to extract, index, and reconcile new persistent memories.
                </p>
                <form onSubmit={handleIngestSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem' }}>Workspace User Context</label>
                    <input
                      type="text"
                      value={userId}
                      onChange={(e) => setUserId(e.target.value)}
                      style={{ width: '100%', padding: '0.4rem 0.5rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                      required
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem' }}>Interaction Statement</label>
                    <textarea
                      rows={3}
                      value={contentInput}
                      onChange={(e) => setContentInput(e.target.value)}
                      placeholder="e.g. I prefer staging on Postgres and decided to host using Neon."
                      style={{ width: '100%', padding: '0.4rem 0.5rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text)', resize: 'vertical', fontFamily: 'inherit' }}
                      required
                    />
                  </div>
                  <button
                    type="submit"
                    className="premium-btn premium-btn-primary"
                    disabled={!mounted || ingestLoading || !contentInput.trim()}
                  >
                    {ingestLoading ? (
                      <>
                        {renderSpinner()}
                        Processing...
                      </>
                    ) : (
                      <>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
                          <path d="M5 12h14M12 5v14"/>
                        </svg>
                        Submit to Memory
                      </>
                    )}
                  </button>

                  {ingestMessage && (
                    <div style={{
                      padding: '0.5rem 0.75rem',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.75rem',
                      border: '1px solid',
                      borderColor: ingestMessage.type === 'success' ? 'var(--success)' : 'var(--error)',
                      backgroundColor: ingestMessage.type === 'success' ? 'rgba(91, 138, 82, 0.05)' : 'rgba(179, 74, 60, 0.05)',
                      color: ingestMessage.type === 'success' ? 'var(--success)' : 'var(--error)'
                    }}>
                      {ingestMessage.text}
                    </div>
                  )}
                </form>
              </div>

              {/* Voice Transcription */}
              <div className="card" style={{ padding: '1.25rem' }}>
                <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.25rem' }}>Voice Transcription</h3>
                <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                  Record voice interactions inside the browser to transcribe audio payload into plain text.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {isRecording ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem', backgroundColor: 'rgba(219, 91, 91, 0.05)', border: '1px solid #db5b5b', borderRadius: 'var(--radius-sm)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span className="status-dot error pulse" style={{ width: '8px', height: '8px' }}></span>
                        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--error)' }}>Recording Audio</span>
                      </div>
                      <span style={{ fontFamily: 'monospace', fontSize: '0.85rem', fontWeight: 600 }}>
                        {Math.floor(recordingTime / 60).toString().padStart(2, '0')}:
                        {(recordingTime % 60).toString().padStart(2, '0')}
                      </span>
                    </div>
                  ) : transcribeLoading ? (
                    <div style={{ padding: '0.5rem 0.75rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', opacity: 0.8, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {renderSpinner()}
                      <span>Transcribing recording file...</span>
                    </div>
                  ) : null}

                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {isRecording ? (
                      <button
                        onClick={stopRecording}
                        className="premium-btn"
                        style={{ backgroundColor: 'var(--error)', borderColor: '#db5b5b', color: '#fff', width: '100%' }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '0.25rem' }}>
                          <rect x="4" y="4" width="16" height="16" rx="2" />
                        </svg>
                        Stop Recording
                      </button>
                    ) : (
                      <button
                        onClick={startRecording}
                        className="premium-btn premium-btn-primary"
                        style={{ width: '100%' }}
                        disabled={transcribeLoading}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '0.25rem' }}>
                          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                          <line x1="12" x2="12" y1="19" y2="22" />
                        </svg>
                        Start Recording
                      </button>
                    )}
                  </div>

                  {transcribeError && (
                    <div style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--error)', backgroundColor: 'rgba(179, 74, 60, 0.05)', color: 'var(--error)', fontSize: '0.75rem' }}>
                      {transcribeError}
                    </div>
                  )}

                  {transcript && (
                    <div style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--primary)' }}>Transcript Output</span>
                        <button
                          onClick={() => setContentInput(transcript)}
                          className="premium-btn premium-btn-secondary"
                          style={{ padding: '0.2rem 0.4rem', fontSize: '0.7rem' }}
                        >
                          📋 Copy to Ingest Form
                        </button>
                      </div>
                      <div style={{ padding: '0.6rem 0.8rem', backgroundColor: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', lineHeight: '1.4', fontStyle: 'italic', color: 'var(--text)' }}>
                        {transcript}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Persisted Memories */}
              <div className="card" style={{ padding: '1.25rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 0 }}>Persisted Memories</h3>
                  <span className="badge" style={{ fontSize: '0.7rem' }}>Count: {memories.length}</span>
                </div>
                <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                  Active and historical memory entities cataloged for the active workspace context.
                </p>

                {loadingMemories && memories.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '1.5rem', fontSize: '0.8rem', opacity: 0.6 }}>Loading memories...</div>
                ) : memories.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '2rem', fontSize: '0.8rem', opacity: 0.6, border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    No memories persisted yet. Use the Ingestion panel on the left to extract and persist memories.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '380px', overflowY: 'auto', paddingRight: '0.25rem' }}>
                    {memories.map((memory) => (
                      <div key={memory.id} style={{
                        padding: '0.75rem',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)',
                        backgroundColor: memory.metadata.status === 'superseded' ? 'var(--muted)' : 'var(--surface)',
                        opacity: memory.metadata.status === 'superseded' ? 0.7 : 1,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                          <span className="badge" style={{ backgroundColor: 'var(--background)', color: 'var(--primary)', fontWeight: 'bold', fontSize: '0.65rem' }}>
                            {memory.type}
                          </span>
                          <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                            {(() => {
                              const lifecycle = deriveLifecycleState({
                                id: memory.id,
                                userId: memory.userId,
                                type: memory.type,
                                content: memory.content,
                                metadata: memory.metadata,
                                createdAt: new Date(memory.createdAt),
                                updatedAt: new Date(memory.updatedAt),
                              } as unknown as PackageMemory);
                              const colors = getLifecycleColor(lifecycle);
                              return (
                                <span className="badge" style={{
                                  backgroundColor: colors.bg,
                                  color: colors.text,
                                  borderColor: colors.border,
                                  fontSize: '0.65rem',
                                  textTransform: 'uppercase',
                                  fontWeight: 'bold',
                                  border: '1px solid'
                                }}>
                                  {lifecycle}
                                </span>
                              );
                            })()}
                            <span style={{ fontSize: '0.7rem', opacity: 0.8 }}>
                              Conf: <strong>{((memory.metadata.confidence as number) * 100).toFixed(0)}%</strong>
                            </span>
                            <span style={{ fontSize: '0.7rem', opacity: 0.8 }}>
                              Imp: <strong>{(memory.metadata.importance as number)}/10</strong>
                            </span>
                          </div>
                        </div>
                        <p style={{ fontWeight: 500, fontSize: '0.85rem', margin: 0 }}>{memory.content}</p>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', opacity: 0.5, marginTop: '0.4rem', borderTop: '1px solid var(--border)', paddingTop: '0.4rem' }}>
                          <span>Source: {memory.metadata.source}</span>
                          <span>Observed: {new Date((memory.metadata.timestamp as string) || memory.createdAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 2. MEMORY INTELLIGENCE */}
            <div className="card" style={{ padding: '1.25rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                <div className="tabs-container">
                  <button
                    onClick={() => setActiveIntelligenceTab('ask')}
                    className={`tab-button ${activeIntelligenceTab === 'ask' ? 'active' : ''}`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    Ask Mnemos
                  </button>
                  <button
                    onClick={() => setActiveIntelligenceTab('search')}
                    className={`tab-button ${activeIntelligenceTab === 'search' ? 'active' : ''}`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
                      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
                    </svg>
                    Semantic Search
                  </button>
                  <button
                    onClick={() => setActiveIntelligenceTab('context')}
                    className={`tab-button ${activeIntelligenceTab === 'context' ? 'active' : ''}`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
                      <path d="m12 3-10 9h18Z" /><path d="m2 17 10 4 10-4" /><path d="m2 12 10 4 10-4" />
                    </svg>
                    Context Assembly
                  </button>
                </div>
                <span className="badge" style={{ backgroundColor: 'rgba(161, 70, 28, 0.1)', color: 'var(--primary)', fontSize: '0.7rem' }}>
                  Intelligence Layer
                </span>
              </div>

              {/* TAB CONTENT: ASK MNEMOS */}
              {activeIntelligenceTab === 'ask' && (
                <div>
                  <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                    Query persistent memories. The system retrieves matching records, processes safety rules, and grounds generation in the compiled context.
                  </p>
                  
                  <form onSubmit={handleResponseSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1rem' }}>
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                      <div style={{ flexGrow: 1, minWidth: '240px' }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem' }}>Ask Mnemos</label>
                        <input
                          type="text"
                          placeholder="e.g. What is my favorite database stack or hosting choice?"
                          value={responseQuery}
                          onChange={(e) => setResponseQuery(e.target.value)}
                          style={{ width: '100%', padding: '0.4rem 0.6rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                          required
                        />
                      </div>
                      <div style={{ width: '90px' }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem' }}>Limit</label>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={responseLimit}
                          onChange={(e) => setResponseLimit(Number(e.target.value))}
                          style={{ width: '100%', padding: '0.4rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                          required
                        />
                      </div>
                      <div style={{ width: '110px' }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem' }}>Max Tokens</label>
                        <input
                          type="number"
                          min={1}
                          value={responseMaxTokens}
                          onChange={(e) => setResponseMaxTokens(Number(e.target.value))}
                          style={{ width: '100%', padding: '0.4rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                          required
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      className="premium-btn premium-btn-primary"
                      disabled={!mounted || responseLoading || !responseQuery.trim()}
                    >
                      {responseLoading ? (
                        <>
                          {renderSpinner()}
                          Synthesizing...
                        </>
                      ) : (
                        <>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
                            <polygon points="12 2 2 22 12 17 22 22 12 2"/>
                          </svg>
                          Generate Grounded Answer
                        </>
                      )}
                    </button>
                  </form>

                  {responseError && (
                    <div style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--error)', backgroundColor: 'rgba(179, 74, 60, 0.05)', color: 'var(--error)', fontSize: '0.75rem', marginBottom: '1rem' }}>
                      {responseError}
                    </div>
                  )}

                  {responseLoading ? (
                    <div style={{ textAlign: 'center', padding: '1.5rem', fontSize: '0.8rem', opacity: 0.6 }}>Running contextual synthesis pipeline...</div>
                  ) : responseResult && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                      <div className="card" style={{ borderLeft: '4px solid var(--primary)', padding: '1.25rem', backgroundColor: 'var(--surface)' }}>
                        <h4 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--primary)', borderBottom: '1px solid var(--border)', paddingBottom: '0.4rem' }}>
                          Grounded AI Response
                        </h4>
                        <div style={{ color: 'var(--text)' }}>
                          {renderMarkdown(responseResult.response)}
                        </div>
                      </div>

                      {responseResult.governance && (responseResult.governance.injectionBlockedCount > 0 || responseResult.governance.conflictsDetectedCount > 0) && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                          {responseResult.governance.injectionBlockedCount > 0 && (
                            <div style={{ padding: '0.5rem 0.75rem', backgroundColor: 'rgba(219, 91, 91, 0.05)', border: '1px solid var(--error)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', color: 'var(--error)' }}>
                              ⚠️ <strong>Security Guard:</strong> Blocked {responseResult.governance.injectionBlockedCount} candidate memory record(s) due to potential instruction injection patterns. Excluded from prompt context.
                            </div>
                          )}
                          {responseResult.governance.conflictsDetectedCount > 0 && (
                            <div style={{ padding: '0.5rem 0.75rem', backgroundColor: 'rgba(219, 145, 66, 0.05)', border: '1px solid #db9142', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', color: '#db9142' }}>
                              ⚡ <strong>Conflict Warning:</strong> Detected {responseResult.governance.conflictsDetectedCount} active competing fact(s). Selected preferred memory and safely excluded the superseded choice.
                            </div>
                          )}
                        </div>
                      )}

                      <div>
                        <h4 style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.4rem' }}>🔒 Supporting Memories Trace</h4>
                        {responseResult.usedMemories.length === 0 ? (
                          <div style={{ padding: '0.75rem', textAlign: 'center', opacity: 0.6, border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem' }}>
                            No matching memories were used as context.
                          </div>
                        ) : (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.5rem' }}>
                            {responseResult.usedMemories.map((used) => (
                              <div key={used.id} style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', fontSize: '0.75rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                                  <span className="badge" style={{ backgroundColor: 'var(--background)', color: 'var(--primary)', fontSize: '0.65rem' }}>
                                    {used.type}
                                  </span>
                                  <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>
                                    ID: {used.id.substring(0, 8)}...
                                  </span>
                                </div>
                                <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.7rem', opacity: 0.7, marginTop: '0.25rem' }}>
                                  <span>Sim: <strong>{used.similarity.toFixed(2)}</strong></span>
                                  <span>Score: <strong>{used.score.toFixed(3)}</strong></span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* TAB CONTENT: SEMANTIC SEARCH */}
              {activeIntelligenceTab === 'search' && (
                <div>
                  <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                    Query memories using cosine similarity matching. Enter a concept description to search.
                  </p>
                  
                  <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                    <input
                      type="text"
                      placeholder="e.g. database staging preferences..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      style={{ flexGrow: 1, minWidth: '220px', padding: '0.4rem 0.75rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                      required
                    />
                    <button
                      type="submit"
                      className="premium-btn premium-btn-primary"
                      disabled={!mounted || searchLoading || !searchQuery.trim()}
                    >
                      {searchLoading ? (
                        <>
                          {renderSpinner()}
                          Searching...
                        </>
                      ) : (
                        <>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
                            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
                          </svg>
                          Search Context
                        </>
                      )}
                    </button>
                  </form>

                  {searchError && (
                    <div style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--error)', backgroundColor: 'rgba(179, 74, 60, 0.05)', color: 'var(--error)', fontSize: '0.75rem', marginBottom: '1rem' }}>
                      {searchError}
                    </div>
                  )}

                  {searchLoading ? (
                    <div style={{ textAlign: 'center', padding: '1.5rem', fontSize: '0.8rem', opacity: 0.6 }}>Executing vector search...</div>
                  ) : searchResults.length === 0 ? (
                    searchQuery && (
                      <div style={{ textAlign: 'center', padding: '1.5rem', fontSize: '0.8rem', opacity: 0.6, border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)' }}>
                        No memories found matching your search.
                      </div>
                    )
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {searchResults.map((result) => (
                        <div key={result.memory.id} style={{ padding: '0.6rem 0.8rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', fontSize: '0.8rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
                            <span className="badge" style={{ backgroundColor: 'var(--background)', color: 'var(--primary)', fontSize: '0.65rem' }}>
                              {result.memory.type}
                            </span>
                            <span style={{ fontSize: '0.75rem', color: 'var(--primary)', fontWeight: 'bold' }}>
                              Similarity: {(result.similarity * 100).toFixed(1)}%
                            </span>
                          </div>
                          <p style={{ fontWeight: 500, margin: '0.25rem 0' }}>{result.memory.content}</p>
                          <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.5, fontSize: '0.7rem' }}>
                            <span>Source: {result.memory.metadata.source}</span>
                            <span>Observed: {new Date((result.memory.metadata.timestamp as string) || result.memory.createdAt).toLocaleDateString()}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* TAB CONTENT: CONTEXT ASSEMBLY */}
              {activeIntelligenceTab === 'context' && (
                <div>
                  <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                    Assemble, score, and token-slice prompt contexts according to token constraints.
                  </p>
                  
                  <form onSubmit={handleContextSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1rem' }}>
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                      <div style={{ flexGrow: 1, minWidth: '240px' }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem' }}>Query Topic</label>
                        <input
                          type="text"
                          placeholder="e.g. database configuration or staging..."
                          value={contextQuery}
                          onChange={(e) => setContextQuery(e.target.value)}
                          style={{ width: '100%', padding: '0.4rem 0.6rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                          required
                        />
                      </div>
                      <div style={{ width: '90px' }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem' }}>Limit</label>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={contextLimit}
                          onChange={(e) => setContextLimit(Number(e.target.value))}
                          style={{ width: '100%', padding: '0.4rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                          required
                        />
                      </div>
                      <div style={{ width: '110px' }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem' }}>Max Tokens</label>
                        <input
                          type="number"
                          min={1}
                          value={contextMaxTokens}
                          onChange={(e) => setContextMaxTokens(Number(e.target.value))}
                          style={{ width: '100%', padding: '0.4rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                          required
                        />
                      </div>
                    </div>
                    <button
                      type="submit"
                      className="premium-btn premium-btn-primary"
                      disabled={!mounted || contextLoading || !contextQuery.trim()}
                    >
                      {contextLoading ? (
                        <>
                          {renderSpinner()}
                          Assembling...
                        </>
                      ) : (
                        <>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
                            <path d="m12 3-10 9h18Z" /><path d="m2 17 10 4 10-4" /><path d="m2 12 10 4 10-4" />
                          </svg>
                          Assemble Prompt Context
                        </>
                      )}
                    </button>
                  </form>

                  {contextError && (
                    <div style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--error)', backgroundColor: 'rgba(179, 74, 60, 0.05)', color: 'var(--error)', fontSize: '0.75rem', marginBottom: '1rem' }}>
                      {contextError}
                    </div>
                  )}

                  {contextLoading ? (
                    <div style={{ textAlign: 'center', padding: '1.5rem', fontSize: '0.8rem', opacity: 0.6 }}>Running context selection heuristics...</div>
                  ) : contextResult && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                      <div>
                        <h4 style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.4rem', display: 'flex', justifyContent: 'space-between' }}>
                          <span>📄 Compiled Prompt Context Block</span>
                          <span className="badge" style={{ backgroundColor: 'var(--primary)', color: '#fff', fontSize: '0.7rem' }}>
                            Tokens: {contextResult.tokenCount}
                          </span>
                        </h4>
                        <pre style={{ padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--background)', color: 'var(--text)', fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'pre-wrap', maxHeight: '200px', overflowY: 'auto' }}>
                          {contextResult.context || '/* Empty Context Block */'}
                        </pre>
                      </div>

                      <div>
                        <h4 style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.4rem' }}>📋 Selected Memory Items</h4>
                        {contextResult.items.length === 0 ? (
                          <div style={{ padding: '0.75rem', textAlign: 'center', opacity: 0.6, border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem' }}>
                            No memories were selected under the token budget.
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                            {contextResult.items.map((item) => (
                              <div key={item.id} style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', fontSize: '0.75rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
                                  <span className="badge" style={{ backgroundColor: 'var(--background)', color: 'var(--primary)', fontSize: '0.65rem' }}>
                                    {item.type}
                                  </span>
                                  <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>
                                    ID: {item.id.substring(0, 8)}...
                                  </span>
                                </div>
                                <p style={{ fontWeight: 500, margin: '0.2rem 0' }}>{item.content}</p>
                                <div style={{ fontSize: '0.7rem', color: 'var(--primary)', opacity: 0.9, borderTop: '1px dotted var(--border)', paddingTop: '0.2, marginTop: 0.2rem' }}>
                                  ℹ️ {item.reason}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 3. MEMORY HEALTH & EVOLUTION TIMELINE */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem', alignItems: 'start' }}>
              
              {/* Memory Health card */}
              <div className="card" style={{ padding: '1.25rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600, marginBottom: 0 }}>Memory Health & Analytics</h3>
                  <button
                    onClick={handleConsolidate}
                    className="premium-btn premium-btn-primary"
                    disabled={loadingConsolidate || memories.length === 0}
                    style={{ padding: '0.35rem 0.7rem', fontSize: '0.75rem' }}
                  >
                    {loadingConsolidate ? (
                      <>
                        {renderSpinner()}
                        Consolidating...
                      </>
                    ) : (
                      <>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
                          <path d="m12 3-10 9h18Z" /><path d="M12 12v9" />
                        </svg>
                        Consolidate Duplicates
                      </>
                    )}
                  </button>
                </div>
                <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                  Cognitive classification metrics, confidence thresholds, and deduplication triggers.
                </p>

                {consolidateMessage && (
                  <div style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--success)', backgroundColor: 'rgba(91, 138, 82, 0.05)', color: 'var(--success)', fontSize: '0.75rem', marginBottom: '1rem' }}>
                    {consolidateMessage}
                  </div>
                )}

                {(() => {
                  if (memories.length === 0) {
                    return (
                      <div style={{ padding: '1.5rem', textAlign: 'center', opacity: 0.6, border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem' }}>
                        No health analytics available yet.
                      </div>
                    );
                  }

                  const stats = memories.reduce((acc, m) => {
                    const lf = deriveLifecycleState({
                      id: m.id,
                      userId: m.userId,
                      type: m.type,
                      content: m.content,
                      metadata: m.metadata,
                      createdAt: new Date(m.createdAt),
                      updatedAt: new Date(m.updatedAt)
                    } as unknown as PackageMemory);
                    acc[lf] = (acc[lf] || 0) + 1;
                    acc.totalConfidence += ((m.metadata.confidence as number) || 0.9);
                    acc.totalImportance += ((m.metadata.importance as number) || 5);
                    return acc;
                  }, { core: 0, stable: 0, fading: 0, historical: 0, totalConfidence: 0, totalImportance: 0 });

                  const avgConfidence = stats.totalConfidence / memories.length;
                  const avgImportance = stats.totalImportance / memories.length;

                  const sortedMemories = [...memories].sort((a, b) => {
                    const aR = (a.metadata.reinforcementCount as number) || 0;
                    const bR = (b.metadata.reinforcementCount as number) || 0;
                    if (bR !== aR) return bR - aR;
                    const aA = (a.metadata.accessCount as number) || 0;
                    const bA = (b.metadata.accessCount as number) || 0;
                    return bA - aA;
                  });
                  const topReinforced = sortedMemories.slice(0, 2);

                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', fontSize: '0.8rem' }}>
                        <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)' }}>
                          <span style={{ opacity: 0.7 }}>Core Memories:</span> <strong>{stats.core || 0}</strong>
                        </div>
                        <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)' }}>
                          <span style={{ opacity: 0.7 }}>Stable Memories:</span> <strong>{stats.stable || 0}</strong>
                        </div>
                        <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)' }}>
                          <span style={{ opacity: 0.7 }}>Fading Memories:</span> <strong>{stats.fading || 0}</strong>
                        </div>
                        <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)' }}>
                          <span style={{ opacity: 0.7 }}>Historical:</span> <strong>{stats.historical || 0}</strong>
                        </div>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', textAlign: 'center', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                        <div>
                          <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: 'var(--primary)' }}>
                            {(avgConfidence * 100).toFixed(0)}%
                          </div>
                          <div style={{ fontSize: '0.65rem', opacity: 0.6, textTransform: 'uppercase' }}>Avg Confidence</div>
                        </div>
                        <div>
                          <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: 'var(--primary)' }}>
                            {avgImportance.toFixed(1)}/10
                          </div>
                          <div style={{ fontSize: '0.65rem', opacity: 0.6, textTransform: 'uppercase' }}>Avg Importance</div>
                        </div>
                      </div>

                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                        <h4 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.4rem', color: 'var(--primary)' }}>Top Reinforced Memories</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                          {topReinforced.map((m) => (
                            <div key={m.id} style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--background)', fontSize: '0.75rem' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.7, marginBottom: '0.15rem' }}>
                                <span style={{ fontWeight: 600 }}>{m.type}</span>
                                <span>Reinforcement Hits: {(m.metadata.reinforcementCount as number) || 0}</span>
                              </div>
                              <p style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', margin: 0, fontStyle: 'italic' }}>
                                {m.content}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Memory Evolution */}
              <div className="card" style={{ padding: '1.25rem' }}>
                <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600 }}>Memory Evolution</h3>
                <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                  Timeline tracking memory revisions, supersessions, and temporal state relationships.
                </p>

                {(() => {
                  const activeWithHistory = memories.filter(
                    (m) => (m.metadata.status || 'active') !== 'superseded' && m.metadata.supersedes
                  );

                  if (activeWithHistory.length === 0) {
                    return (
                      <div style={{ padding: '2rem', textAlign: 'center', opacity: 0.6, border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', lineHeight: '1.5' }}>
                        No memory versions yet. When a memory changes, Mnemos preserves the previous version and shows its evolution here.
                      </div>
                    );
                  }

                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '350px', overflowY: 'auto' }}>
                      {activeWithHistory.map((current) => {
                        const chain: typeof memories = [current];
                        let curr = current;
                        const visited = new Set<string>([curr.id]);

                        while (curr.metadata.supersedes && typeof curr.metadata.supersedes === 'string') {
                          const parentId = curr.metadata.supersedes;
                          if (visited.has(parentId)) break;
                          visited.add(parentId);

                          const parent = memories.find((m) => m.id === parentId);
                          if (!parent) break;
                          chain.push(parent);
                          curr = parent;
                        }

                        return (
                          <div key={current.id} style={{ padding: '0.6rem 0.8rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.25rem', marginBottom: '0.4rem', fontWeight: 600 }}>
                              <span style={{ color: 'var(--primary)' }}>Type: {current.type}</span>
                              <span style={{ opacity: 0.5 }}>Revisions: {chain.length}</span>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', paddingLeft: '0.75rem', borderLeft: '2px solid var(--border)', position: 'relative' }}>
                              {chain.map((version, idx) => {
                                const isActive = idx === 0;
                                return (
                                  <div key={version.id} style={{ fontSize: '0.75rem' }}>
                                    <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                                      <strong style={{ color: isActive ? 'var(--success)' : 'var(--error)' }}>
                                        {isActive ? 'Active' : 'Superseded'}
                                      </strong>
                                      <span style={{ opacity: 0.5 }}>ID: {version.id.substring(0, 8)}...</span>
                                    </div>
                                    <p style={{ margin: '0.15rem 0', fontWeight: isActive ? 600 : 400, color: 'var(--text)' }}>
                                      {version.content}
                                    </p>
                                    <span style={{ opacity: 0.5, fontSize: '0.65rem' }}>
                                      {version.metadata.validFrom ? `From: ${new Date(version.metadata.validFrom as string).toLocaleDateString()}` : `Observed: ${new Date((version.metadata.timestamp as string) || version.createdAt).toLocaleDateString()}`}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        ) : (
          /* ========================================== */
          /*         DEVELOPER CONSOLE VIEW             */
          /* ========================================== */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            
            {/* System health and Security settings */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem', alignItems: 'start' }}>
              
              {/* System Diagnostics */}
              <div className="card" style={{ padding: '1.25rem' }}>
                <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600 }}>Diagnostic Health States</h3>
                <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                  Diagnostics detailing status of local Neon database and external Gemini endpoints.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.8rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
                    <span>Runtime Service</span>
                    <strong style={{ color: healthData?.service === 'healthy' ? 'var(--success)' : 'var(--error)' }}>
                      {healthData?.service ? healthData.service.toUpperCase() : 'HEALTHY'}
                    </strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
                    <span>Neon Database Client</span>
                    <strong style={{ color: healthData?.database === 'healthy' ? 'var(--success)' : 'var(--error)' }}>
                      {healthData?.database ? healthData.database.toUpperCase() : 'HEALTHY'}
                    </strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.4rem 0' }}>
                    <span>Gemini Core Provider</span>
                    <strong style={{ color: healthData?.provider === 'healthy' ? 'var(--success)' : 'var(--error)' }}>
                      {healthData?.provider ? healthData.provider.toUpperCase() : 'HEALTHY'}
                    </strong>
                  </div>
                </div>
              </div>

              {/* Security Audits */}
              <div className="card" style={{ padding: '1.25rem' }}>
                <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600 }}>Security & Performance Audits</h3>
                <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                  Active API key parameters, rate limiting quotas, and timing latency statistics.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.8rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
                    <span>API Credentials Verification</span>
                    <strong style={{ color: healthData?.authEnabled ? 'var(--success)' : 'var(--error)' }}>
                      {healthData?.authEnabled ? 'ENABLED (Production)' : 'DISABLED (Local Dev)'}
                    </strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
                    <span>In-Memory Rate Limiter</span>
                    <strong>
                      {healthData?.rateLimitMax ? `${healthData.rateLimitMax} req / ${healthData.rateLimitWindow}s` : '100 req / 60s'}
                    </strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.4rem 0', borderBottom: '1px solid var(--border)' }}>
                    <span>Average Trace Latency</span>
                    <strong>{avgLatency > 0 ? `${avgLatency} ms` : 'N/A'}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.4rem 0' }}>
                    <span>Recent Request Errors</span>
                    <strong style={{ color: errorCount > 0 ? 'var(--error)' : 'var(--success)' }}>{errorCount}</strong>
                  </div>
                </div>
              </div>
            </div>

            {/* REST API and Telemetry logger */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem', alignItems: 'start' }}>
              
              {/* Route reference docs */}
              <div className="card" style={{ padding: '1.25rem' }}>
                <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>API Reference (REST v1)</h3>
                
                <div style={{ display: 'flex', gap: '0.2rem', marginBottom: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.4rem', overflowX: 'auto' }}>
                  {(['ingest', 'search', 'context', 'respond', 'health'] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setActiveDocTab(tab)}
                      style={{
                        padding: '0.3rem 0.5rem',
                        border: 'none',
                        backgroundColor: activeDocTab === tab ? 'var(--surface)' : 'transparent',
                        color: activeDocTab === tab ? 'var(--primary)' : 'var(--text)',
                        fontWeight: activeDocTab === tab ? 600 : 400,
                        borderRadius: 'var(--radius-sm)',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        borderBottom: activeDocTab === tab ? '2px solid var(--primary)' : 'none',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {tab.toUpperCase()}
                    </button>
                  ))}
                </div>

                {activeDocTab === 'ingest' && (
                  <div style={{ fontSize: '0.75rem' }}>
                    <h4 style={{ fontWeight: 600, marginBottom: '0.25rem' }}>POST /api/v1/memory/ingest</h4>
                    <p style={{ opacity: 0.7, marginBottom: '0.5rem' }}>Extracts and reconciles memory interaction records.</p>
                    <pre style={{ padding: '0.5rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-sm)', overflowX: 'auto', border: '1px solid var(--border)', marginBottom: '0.5rem' }}>
{`curl -X POST http://localhost:3000/api/v1/memory/ingest \\
  -H "Content-Type: application/json" \\
  -d '{
    "userId": "user-123",
    "content": "I prefer using PostgreSQL."
  }'`}
                    </pre>
                  </div>
                )}

                {activeDocTab === 'search' && (
                  <div style={{ fontSize: '0.75rem' }}>
                    <h4 style={{ fontWeight: 600, marginBottom: '0.25rem' }}>POST /api/v1/memory/search</h4>
                    <p style={{ opacity: 0.7, marginBottom: '0.5rem' }}>Cosine similarity vector matching over active memories.</p>
                    <pre style={{ padding: '0.5rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-sm)', overflowX: 'auto', border: '1px solid var(--border)', marginBottom: '0.5rem' }}>
{`curl -X POST http://localhost:3000/api/v1/memory/search \\
  -H "Content-Type: application/json" \\
  -d '{
    "userId": "user-123",
    "query": "preferred DB",
    "limit": 5
  }'`}
                    </pre>
                  </div>
                )}

                {activeDocTab === 'context' && (
                  <div style={{ fontSize: '0.75rem' }}>
                    <h4 style={{ fontWeight: 600, marginBottom: '0.25rem' }}>POST /api/v1/memory/context</h4>
                    <p style={{ opacity: 0.7, marginBottom: '0.5rem' }}>Retrieve, governance filter, and slice formatted prompt context.</p>
                    <pre style={{ padding: '0.5rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-sm)', overflowX: 'auto', border: '1px solid var(--border)', marginBottom: '0.5rem' }}>
{`curl -X POST http://localhost:3000/api/v1/memory/context \\
  -H "Content-Type: application/json" \\
  -d '{
    "userId": "user-123",
    "query": "database choice",
    "limit": 10,
    "maxTokens": 1500
  }'`}
                    </pre>
                  </div>
                )}

                {activeDocTab === 'respond' && (
                  <div style={{ fontSize: '0.75rem' }}>
                    <h4 style={{ fontWeight: 600, marginBottom: '0.25rem' }}>POST /api/v1/memory/respond</h4>
                    <p style={{ opacity: 0.7, marginBottom: '0.5rem' }}>Generate grounded LLM responses under user memory context rules.</p>
                    <pre style={{ padding: '0.5rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-sm)', overflowX: 'auto', border: '1px solid var(--border)', marginBottom: '0.5rem' }}>
{`curl -X POST http://localhost:3000/api/v1/memory/respond \\
  -H "Content-Type: application/json" \\
  -d '{
    "userId": "user-123",
    "query": "SQLite or PostgreSQL?",
    "limit": 5
  }'`}
                    </pre>
                  </div>
                )}

                {activeDocTab === 'health' && (
                  <div style={{ fontSize: '0.75rem' }}>
                    <h4 style={{ fontWeight: 600, marginBottom: '0.25rem' }}>GET /api/v1/memory/health</h4>
                    <p style={{ opacity: 0.7, marginBottom: '0.5rem' }}>Diagnostic health values of the database and provider clients.</p>
                    <pre style={{ padding: '0.5rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-sm)', overflowX: 'auto', border: '1px solid var(--border)', marginBottom: '0.5rem' }}>
{`curl -X GET http://localhost:3000/api/v1/memory/health`}
                    </pre>
                  </div>
                )}
              </div>

              {/* Telemetry Trace */}
              <div className="card" style={{ padding: '1.25rem' }}>
                <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600 }}>Live Telemetry Tracer</h3>
                <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                  Real-time network logging captures API executions.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '250px', overflowY: 'auto' }}>
                  {requestMetrics.length === 0 ? (
                    <div style={{ padding: '1.5rem', textAlign: 'center', opacity: 0.5, border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem' }}>
                      No recent telemetry tracks captured.
                    </div>
                  ) : (
                    requestMetrics.map((metric) => (
                      <div key={metric.id} style={{ padding: '0.5rem 0.6rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: 'var(--surface)', fontSize: '0.7rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.15rem', fontWeight: 600 }}>
                          <span style={{ color: 'var(--primary)' }}>{metric.endpoint}</span>
                          <span style={{ color: metric.status.includes('OK') || metric.status.includes('200') ? 'var(--success)' : 'var(--error)' }}>
                            {metric.status}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.6 }}>
                          <span>Latency: <strong>{metric.latency} ms</strong></span>
                          <span>ID: <code>{metric.id.substring(0, 10)}...</code></span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Evaluation benchmarks */}
            <div className="card" style={{ padding: '1.25rem' }}>
              <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600 }}>Scenario Benchmark Evaluation</h3>
              <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                Run the synthetic evaluation benchmark dataset to audit recall, precision, and isolation limits.
              </p>
              
              <button
                onClick={handleRunEvaluation}
                className="premium-btn premium-btn-primary"
                disabled={evalLoading}
              >
                {evalLoading ? (
                  <>
                    {renderSpinner()}
                    Executing...
                  </>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
                      <path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>
                    </svg>
                    Run Scenario Benchmarks
                  </>
                )}
              </button>

              {evalError && (
                <div style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--error)', backgroundColor: 'rgba(179, 74, 60, 0.05)', color: 'var(--error)', fontSize: '0.75rem', marginBottom: '1rem' }}>
                  {evalError}
                </div>
              )}

              {evalLoading ? (
                <div style={{ textAlign: 'center', padding: '1.5rem', fontSize: '0.8rem', opacity: 0.6 }}>Executing benchmark scenarios...</div>
              ) : evalSummary && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {/* Summary Stats */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '0.75rem', fontSize: '0.75rem', textAlign: 'center' }}>
                    <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)' }}>
                      <span style={{ opacity: 0.6, display: 'block' }}>Total Scenarios</span>
                      <strong>{evalSummary.total}</strong>
                    </div>
                    <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'rgba(91, 138, 82, 0.05)' }}>
                      <span style={{ color: 'var(--success)', display: 'block' }}>Passed</span>
                      <strong style={{ color: 'var(--success)' }}>{evalSummary.passed}</strong>
                    </div>
                    <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'rgba(179, 74, 60, 0.05)' }}>
                      <span style={{ color: 'var(--error)', display: 'block' }}>Failed</span>
                      <strong style={{ color: 'var(--error)' }}>{evalSummary.failed}</strong>
                    </div>
                    <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)' }}>
                      <span style={{ opacity: 0.6, display: 'block' }}>Recall Rate</span>
                      <strong>{(evalSummary.retrievalRecall * 100).toFixed(0)}%</strong>
                    </div>
                    <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)' }}>
                      <span style={{ opacity: 0.6, display: 'block' }}>Precision</span>
                      <strong>{(evalSummary.contextPrecision * 100).toFixed(0)}%</strong>
                    </div>
                    <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)' }}>
                      <span style={{ opacity: 0.6, display: 'block' }}>Isolation</span>
                      <strong>{(evalSummary.isolationRate * 100).toFixed(0)}%</strong>
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '250px', overflowY: 'auto' }}>
                    {evalResults.map((result) => (
                      <div key={result.scenarioId} style={{ padding: '0.4rem 0.6rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)', fontSize: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <strong>{result.name}</strong>
                          <div style={{ opacity: 0.6, fontSize: '0.65rem', marginTop: '0.1rem' }}>
                            Recall: {(result.metrics.retrievalRecall * 100).toFixed(0)}% | Latency: {result.latencyMs} ms
                          </div>
                        </div>
                        <span style={{ color: result.passed ? 'var(--success)' : 'var(--error)', fontWeight: 600 }}>
                          {result.passed ? 'PASSED' : 'FAILED'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="footer" style={{ padding: '1.5rem', textAlign: 'center', borderTop: '1px solid var(--border)', fontSize: '0.8rem', opacity: 0.8 }}>
        <div>
          © 2026 Nataraj EL. All Rights Reserved.
        </div>
      </footer>
    </div>
  );
}
