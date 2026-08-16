'use client';
/* eslint-disable react-hooks/purity */

import { useEffect, useState } from 'react';
import { deriveLifecycleState } from '@/core/types';
import type { Memory as PackageMemory } from '@/core/types';
import type { Conversation } from '@/conversation/types';
import type { EvalScenarioResult, EvalSummary, TuningResult, TuningBenchmarkSummary } from '@/evaluation/types';

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
  const getGroundingStatus = (usedMemories: unknown[] = [], usedConversations: unknown[] = []) => {
    const memCount = usedMemories.length;
    const convCount = usedConversations.length;
    
    if (memCount > 0 && convCount > 0) {
      return {
        label: `Fully Grounded by ${memCount} memories + ${convCount} past conversations`,
        color: '#10b981', // green
        bgColor: 'rgba(16, 185, 129, 0.05)',
        borderColor: 'rgba(16, 185, 129, 0.2)',
      };
    } else if (memCount > 0 || convCount > 0) {
      const typeLabel = memCount > 0 
        ? `${memCount} memor${memCount === 1 ? 'y' : 'ies'}` 
        : `${convCount} past conversation${convCount === 1 ? '' : 's'}`;
      return {
        label: `Partially Grounded by ${typeLabel}`,
        color: '#3b82f6', // blue
        bgColor: 'rgba(59, 130, 246, 0.05)',
        borderColor: 'rgba(59, 130, 246, 0.2)',
      };
    } else {
      return {
        label: 'No relevant context found',
        color: '#ef4444', // red
        bgColor: 'rgba(239, 68, 68, 0.05)',
        borderColor: 'rgba(239, 68, 68, 0.2)',
      };
    }
  };

  const formatProvenanceDate = (timestamp?: string) => {
    if (!timestamp) return '';
    try {
      const d = new Date(timestamp);
      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    } catch {
      return '';
    }
  };

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

  // Voice Grounded Query States
  const [voiceMode, setVoiceMode] = useState<'transcribe' | 'ask'>('transcribe');
  const [voiceResponseText, setVoiceResponseText] = useState<string | null>(null);
  const [voiceUsedMemories, setVoiceUsedMemories] = useState<{ id: string; type: string; similarity: number; score: number; content?: string; confidence?: number; lifecycleState?: string; conversationId?: string; sourceType?: string; sourceTimestamp?: string }[]>([]);
  const [voiceUsedConversations, setVoiceUsedConversations] = useState<{ id: string; conversationId?: string; createdAt: string; text: string; matchedSnippet?: string; similarity?: number }[]>([]);
  const [voiceContextTokenCount, setVoiceContextTokenCount] = useState<number>(0);

  // Conversation persistence states
  const [recordingStart, setRecordingStart] = useState<number>(0);
  const [recordingEnd, setRecordingEnd] = useState<number>(0);
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Sprint 17 unified session state
  const [voiceSessionState, setVoiceSessionState] = useState<'idle' | 'recording' | 'processing' | 'transcribing' | 'review' | 'saving' | 'saved' | 'error'>('idle');

  // Sprint 19 UX Integration states
  const [savedConversationId, setSavedConversationId] = useState<string | null>(null);
  const [extractionState, setExtractionState] = useState<'idle' | 'extracting' | 'extracted' | 'extraction-error'>('idle');
  const [extractionResultCount, setExtractionResultCount] = useState<number | null>(null);
  const [extractionError, setExtractionError] = useState<string | null>(null);
  
  const [expandedCitations, setExpandedCitations] = useState<Record<string, boolean>>({});

  // Voice Session History States (Sprint 28)
  interface VoiceSessionEntry {
    id: string;
    transcript: string;
    response: string | null;
    usedMemories: { id: string; type: string; similarity: number; score: number; content?: string; confidence?: number; lifecycleState?: string; conversationId?: string; sourceType?: string; sourceTimestamp?: string }[];
    usedConversations: { id: string; conversationId?: string; createdAt: string; text: string; matchedSnippet?: string; similarity?: number }[];
    contextTokenCount: number;
    timestamp: string;
    isSaved?: boolean;
    conversationId?: string;
    savedAt?: string;
    startedAt?: string;
    endedAt?: string;
    durationSeconds?: number;
  }

  const [voiceHistory, setVoiceHistory] = useState<VoiceSessionEntry[]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [activeQueryText, setActiveQueryText] = useState('');
  
  const [activeResponseText, setActiveResponseText] = useState<string | null>(null);
  const [activeUsedMemories, setActiveUsedMemories] = useState<{ id: string; type: string; similarity: number; score: number; content?: string; confidence?: number; lifecycleState?: string; conversationId?: string; sourceType?: string; sourceTimestamp?: string }[]>([]);
  const [activeUsedConversations, setActiveUsedConversations] = useState<{ id: string; conversationId?: string; createdAt: string; text: string; matchedSnippet?: string; similarity?: number }[]>([]);
  const [activeContextTokenCount, setActiveContextTokenCount] = useState<number>(0);

  const handleSelectHistoryEntry = (id: string) => {
    // Save current active state before switching
    if (selectedHistoryId === null) {
      setActiveQueryText(transcript);
      setActiveResponseText(voiceResponseText);
      setActiveUsedMemories(voiceUsedMemories);
      setActiveUsedConversations(voiceUsedConversations);
      setActiveContextTokenCount(voiceContextTokenCount);
    }

    const entry = voiceHistory.find((e) => e.id === id);
    if (entry) {
      setSelectedHistoryId(id);
      setTranscript(entry.transcript);
      setVoiceResponseText(entry.response);
      setVoiceUsedMemories(entry.usedMemories);
      setVoiceUsedConversations(entry.usedConversations);
      setVoiceContextTokenCount(entry.contextTokenCount);
      setVoiceSessionState('review');
    }
  };

  const handleReturnToCurrentQuery = () => {
    setSelectedHistoryId(null);
    setTranscript(activeQueryText);
    setVoiceResponseText(activeResponseText);
    setVoiceUsedMemories(activeUsedMemories);
    setVoiceUsedConversations(activeUsedConversations);
    setVoiceContextTokenCount(activeContextTokenCount);

    setActiveQueryText('');
    setActiveResponseText(null);
    setActiveUsedMemories([]);
    setActiveUsedConversations([]);
    setActiveContextTokenCount(0);

    setVoiceSessionState('review');
  };

  const handleClearVoiceSessionWithWarning = () => {
    const hasUnsavedWork = voiceHistory.length > 0 || (transcript && voiceSessionState !== 'saved');
    if (hasUnsavedWork) {
      if (!confirm('Are you sure you want to clear this voice session? All temporary session history and current transcription query will be lost.')) {
        return;
      }
    }
    resetVoiceSession();
    setVoiceHistory([]);
    setSelectedHistoryId(null);
    setActiveQueryText('');
    setActiveResponseText(null);
    setActiveUsedMemories([]);
    setActiveUsedConversations([]);
    setActiveContextTokenCount(0);
  };

  const handleSwitchVoiceMode = (mode: 'transcribe' | 'ask') => {
    if (voiceMode === mode) return;
    const hasUnsavedWork = voiceHistory.length > 0 || (transcript && voiceSessionState !== 'saved');
    if (hasUnsavedWork) {
      if (!confirm('Are you sure you want to change voice modes? All temporary session history and current transcription query will be lost.')) {
        return;
      }
    }
    resetVoiceSession();
    setVoiceHistory([]);
    setSelectedHistoryId(null);
    setActiveQueryText('');
    setActiveResponseText(null);
    setActiveUsedMemories([]);
    setActiveUsedConversations([]);
    setActiveContextTokenCount(0);
    setVoiceMode(mode);
  };

  const [historySavingId, setHistorySavingId] = useState<string | null>(null);
  const [historySaveError, setHistorySaveError] = useState<Record<string, string>>({});

  const handleSaveHistoryEntry = async (entryId: string) => {
    const entry = voiceHistory.find((e) => e.id === entryId);
    if (!entry) return;
    if (entry.isSaved) return;

    setHistorySavingId(entryId);
    setHistorySaveError((prev) => ({ ...prev, [entryId]: '' }));

    try {
      const payload = {
        userId: userId.trim(),
        transcript: `Question: ${entry.transcript}\nAnswer: ${entry.response || ''}`,
        startedAt: entry.startedAt || new Date(entry.timestamp).toISOString(),
        endedAt: entry.endedAt || new Date(entry.timestamp).toISOString(),
        durationSeconds: entry.durationSeconds || 0,
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (process.env.NEXT_PUBLIC_MNEMOS_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.NEXT_PUBLIC_MNEMOS_API_KEY}`;
      }

      const response = await fetch('/api/v1/conversations', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (response.ok && data.status === 'success') {
        const conversationId = data.data.conversation.id;

        // Atomically link to the history entry
        setVoiceHistory((prev) =>
          prev.map((e) =>
            e.id === entryId
              ? { ...e, isSaved: true, conversationId, savedAt: new Date().toISOString() }
              : e
          )
        );

        fetchConversations();
      } else {
        setHistorySaveError((prev) => ({
          ...prev,
          [entryId]: data.error || 'Failed to save conversation.'
        }));
      }
    } catch (err) {
      console.error('Failed to save history entry conversation:', err);
      setHistorySaveError((prev) => ({
        ...prev,
        [entryId]: 'An unexpected error occurred while saving.'
      }));
    } finally {
      setHistorySavingId(null);
    }
  };

  const toggleCitation = (key: string) => {
    setExpandedCitations((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleVoiceAskAgain = () => {
    setTranscript('');
    setVoiceResponseText(null);
    setVoiceUsedMemories([]);
    setVoiceUsedConversations([]);
    setVoiceContextTokenCount(0);
    setVoiceSessionState('idle');
    setSelectedHistoryId(null);
    setActiveQueryText('');
    setActiveResponseText(null);
    setActiveUsedMemories([]);
    setActiveUsedConversations([]);
    setActiveContextTokenCount(0);
  };

  const handleSubmitEditedVoiceQuery = async () => {
    if (transcribeLoading || saveLoading) return;
    if (!transcript || !transcript.trim()) return;

    setTranscribeLoading(true);
    setVoiceSessionState('transcribing');
    setTranscribeError(null);
    setVoiceResponseText(null);
    setVoiceUsedMemories([]);
    setVoiceUsedConversations([]);
    setVoiceContextTokenCount(0);
    const start = Date.now();

    try {
      const response = await fetch('/api/memory/respond', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: userId.trim(),
          query: transcript.trim(),
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
        let msg = 'Failed to generate response.';
        if (data.error) {
          const errLower = data.error.toLowerCase();
          if (errLower.includes('api_key') || errLower.includes('api key') || errLower.includes('provider') || errLower.includes('unavailable')) {
            msg = 'Grounded response service is temporarily unavailable.';
          } else if (errLower.includes('limit') || errLower.includes('token') || errLower.includes('budget')) {
            msg = 'The query exceeds resource limits or context token budgets.';
          } else {
            msg = data.error;
          }
        }
        setTranscribeError(msg);
        setVoiceSessionState('error');
      } else {
        setVoiceResponseText(data.response);
        setVoiceUsedMemories(data.usedMemories || []);
        setVoiceUsedConversations(data.usedConversations || []);
        setVoiceContextTokenCount(data.contextTokenCount || 0);
        setVoiceSessionState('review');

        // Add to temporary session history
        const durationSeconds = recordingStart && recordingEnd ? Math.max(0, Math.round((recordingEnd - recordingStart) / 1000)) : 0;
        const newEntry: VoiceSessionEntry = {
          id: 'vse-' + Math.random().toString(36).substring(2, 9),
          transcript: transcript.trim(),
          response: data.response,
          usedMemories: data.usedMemories || [],
          usedConversations: data.usedConversations || [],
          contextTokenCount: data.contextTokenCount || 0,
          timestamp: new Date().toISOString(),
          startedAt: recordingStart ? new Date(recordingStart).toISOString() : new Date().toISOString(),
          endedAt: recordingEnd ? new Date(recordingEnd).toISOString() : new Date().toISOString(),
          durationSeconds,
        };
        setSelectedHistoryId(newEntry.id);
        setVoiceHistory((prev) => {
          const updated = [...prev, newEntry];
          if (updated.length > 20) {
            updated.shift();
          }
          return updated;
        });
      }
    } catch (err) {
      console.error('Failed to submit edited voice query:', err);
      setTranscribeError('An error occurred during query generation.');
      setVoiceSessionState('error');
    } finally {
      setTranscribeLoading(false);
    }
  };

  const resetVoiceSession = () => {
    setTranscript('');
    setIsRecording(false);
    setMediaRecorder(null);
    setRecordingTime(0);
    setRecordingStart(0);
    setRecordingEnd(0);
    setTranscribeLoading(false);
    setTranscribeError(null);
    setVoiceResponseText(null);
    setVoiceUsedMemories([]);
    setVoiceUsedConversations([]);
    setVoiceContextTokenCount(0);
    setSaveMessage(null);
    setVoiceSessionState('idle');
    setSavedConversationId(null);
    setExtractionState('idle');
    setExtractionResultCount(null);
    setExtractionError(null);
  };

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [timelineSearch, setTimelineSearch] = useState('');
  const [timelineFilterMode, setTimelineFilterMode] = useState<'all' | 'has-summary' | 'has-memories' | 'recent'>('all');
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [selectedConvTab, setSelectedConvTab] = useState<'transcript' | 'summary' | 'memories'>('transcript');
  const [conversationMemories, setConversationMemories] = useState<Memory[]>([]);
  const [loadingConversationMemories, setLoadingConversationMemories] = useState(false);

  // Extraction UI States
  const [extractLoading, setExtractLoading] = useState(false);
  const [extractResult, setExtractResult] = useState<{ count: number; message: string } | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);

  const handleExtractMemories = async (id: string) => {
    if (!userId.trim()) return;
    setExtractLoading(true);
    setExtractError(null);
    setExtractResult(null);
    const start = Date.now();
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (process.env.NEXT_PUBLIC_MNEMOS_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.NEXT_PUBLIC_MNEMOS_API_KEY}`;
      }

      const response = await fetch(`/api/v1/conversations/${id}/intelligence`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: userId.trim(),
          operation: 'extract-memories'
        }),
      });

      const data = await response.json();
      const latency = Date.now() - start;
      const reqId = data.requestId || 'req-' + Math.random().toString(36).substring(2, 9);

      setRequestMetrics((prev) => [
        {
          id: reqId,
          timestamp: new Date().toISOString(),
          endpoint: `POST /api/v1/conversations/${id}/intelligence (extract-memories)`,
          latency,
          status: response.ok ? '200 OK' : `${response.status} Error`,
        },
        ...prev,
      ]);

      if (response.ok && data.status === 'success') {
        setExtractResult({
          count: data.data.extractedCount,
          message: `Successfully extracted ${data.data.extractedCount} candidate memories!`,
        });
        fetchMemories();
        fetchConversationMemories(id);
      } else {
        setExtractError(data.error || 'Failed to extract memories.');
      }
    } catch (err) {
      console.error('Failed to extract memories:', err);
      setExtractError('An unexpected error occurred.');
    } finally {
      setExtractLoading(false);
    }
  };

  const [summarizeLoading, setSummarizeLoading] = useState(false);
  const [summarizeError, setSummarizeError] = useState<string | null>(null);

  const handleSummarizeConversation = async (id: string) => {
    if (!userId.trim()) return;
    setSummarizeLoading(true);
    setSummarizeError(null);
    const start = Date.now();
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (process.env.NEXT_PUBLIC_MNEMOS_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.NEXT_PUBLIC_MNEMOS_API_KEY}`;
      }

      const response = await fetch(`/api/v1/conversations/${id}/intelligence`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: userId.trim(),
          operation: 'summarize'
        }),
      });

      const data = await response.json();
      const latency = Date.now() - start;
      const reqId = data.requestId || 'req-' + Math.random().toString(36).substring(2, 9);

      setRequestMetrics((prev) => [
        {
          id: reqId,
          timestamp: new Date().toISOString(),
          endpoint: `POST /api/v1/conversations/${id}/intelligence (summarize)`,
          latency,
          status: response.ok ? '200 OK' : `${response.status} Error`,
        },
        ...prev,
      ]);

      if (response.ok && data.status === 'success') {
        setSelectedConversation((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            summary: data.data.summary,
          };
        });
        fetchConversations();
      } else {
        setSummarizeError(data.error || 'Failed to generate summary.');
      }
    } catch (err) {
      console.error('Failed to generate summary:', err);
      setSummarizeError('An unexpected error occurred.');
    } finally {
      setSummarizeLoading(false);
    }
  };

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

  const fetchConversations = async () => {
    if (!userId.trim()) return;
    setLoadingConversations(true);
    try {
      const headers: Record<string, string> = {};
      if (process.env.NEXT_PUBLIC_MNEMOS_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.NEXT_PUBLIC_MNEMOS_API_KEY}`;
      }
      const response = await fetch(`/api/v1/conversations?userId=${encodeURIComponent(userId.trim())}`, {
        headers
      });
      const data = await response.json();
      if (response.ok && data.status === 'success') {
        setConversations(data.data.conversations || []);
      }
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
    } finally {
      setLoadingConversations(false);
    }
  };

  const handleSaveConversation = async () => {
    if (!transcript || !transcript.trim() || !userId.trim()) return;
    if (voiceSessionState === 'saving' || voiceSessionState === 'saved') return;

    setVoiceSessionState('saving');
    setSaveLoading(true);
    setSaveMessage(null);
    try {
      const durationSeconds = recordingStart && recordingEnd ? Math.max(0, Math.round((recordingEnd - recordingStart) / 1000)) : 0;
      
      const payload = {
        userId: userId.trim(),
        transcript: transcript.trim(),
        startedAt: recordingStart ? new Date(recordingStart).toISOString() : new Date().toISOString(),
        endedAt: recordingEnd ? new Date(recordingEnd).toISOString() : new Date().toISOString(),
        durationSeconds,
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (process.env.NEXT_PUBLIC_MNEMOS_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.NEXT_PUBLIC_MNEMOS_API_KEY}`;
      }

      const response = await fetch('/api/v1/conversations', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (response.ok && data.status === 'success') {
        const conversationId = data.data.conversation.id;
        setSaveMessage({ type: 'success', text: `Conversation saved successfully!` });
        setVoiceSessionState('saved');

        // Atomically link to current history entry
        if (selectedHistoryId) {
          setVoiceHistory((prev) =>
            prev.map((e) =>
              e.id === selectedHistoryId
                ? { ...e, isSaved: true, conversationId, savedAt: new Date().toISOString() }
                : e
            )
          );
        } else if (voiceHistory.length > 0) {
          const lastEntry = voiceHistory[voiceHistory.length - 1];
          if (lastEntry && lastEntry.transcript === transcript) {
            setVoiceHistory((prev) =>
              prev.map((e, idx) =>
                idx === prev.length - 1
                  ? { ...e, isSaved: true, conversationId, savedAt: new Date().toISOString() }
                  : e
              )
            );
          }
        }

        fetchConversations();
      } else {
        setSaveMessage({ type: 'error', text: data.error || 'Failed to save conversation. Please try again.' });
        setVoiceSessionState('error');
      }
    } catch (err) {
      console.error('Failed to save conversation:', err);
      setSaveMessage({ type: 'error', text: 'An unexpected error occurred while saving. Please retry.' });
      setVoiceSessionState('error');
    } finally {
      setSaveLoading(false);
    }
  };

  const performExtraction = async (conversationId: string) => {
    setExtractionState('extracting');
    setExtractionError(null);
    setExtractionResultCount(null);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (process.env.NEXT_PUBLIC_MNEMOS_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.NEXT_PUBLIC_MNEMOS_API_KEY}`;
      }

      const response = await fetch(`/api/v1/conversations/${conversationId}/intelligence`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: userId.trim(),
          operation: 'extract-memories'
        }),
      });

      const data = await response.json();
      if (response.ok && data.status === 'success') {
        setExtractionResultCount(data.data.extractedCount);
        setExtractionState('extracted');
        fetchMemories();
      } else {
        setExtractionError(data.error || 'Failed to extract memories.');
        setExtractionState('extraction-error');
      }
    } catch (err) {
      console.error('Failed to extract memories:', err);
      setExtractionError('An unexpected error occurred during extraction.');
      setExtractionState('extraction-error');
    }
  };

  const handleSaveAndExtractMemories = async () => {
    if (!transcript || !transcript.trim() || !userId.trim()) return;
    if (voiceSessionState === 'saving' || voiceSessionState === 'saved') return;
    if (extractionState === 'extracting') return;

    setVoiceSessionState('saving');
    setSaveLoading(true);
    setSaveMessage(null);
    setExtractionState('idle');
    setExtractionResultCount(null);
    setExtractionError(null);

    let conversationId: string | null = null;

    try {
      const durationSeconds = recordingStart && recordingEnd ? Math.max(0, Math.round((recordingEnd - recordingStart) / 1000)) : 0;
      
      const payload = {
        userId: userId.trim(),
        transcript: transcript.trim(),
        startedAt: recordingStart ? new Date(recordingStart).toISOString() : new Date().toISOString(),
        endedAt: recordingEnd ? new Date(recordingEnd).toISOString() : new Date().toISOString(),
        durationSeconds,
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (process.env.NEXT_PUBLIC_MNEMOS_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.NEXT_PUBLIC_MNEMOS_API_KEY}`;
      }

      const response = await fetch('/api/v1/conversations', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (response.ok && data.status === 'success') {
        conversationId = data.data.conversation.id;
        setSavedConversationId(conversationId);
        setSaveMessage({ type: 'success', text: 'Conversation Saved' });
        setVoiceSessionState('saved');

        // Atomically link to current history entry
        if (selectedHistoryId) {
          setVoiceHistory((prev) =>
            prev.map((e) =>
              e.id === selectedHistoryId
                ? { ...e, isSaved: true, conversationId: conversationId!, savedAt: new Date().toISOString() }
                : e
            )
          );
        } else if (voiceHistory.length > 0) {
          const lastEntry = voiceHistory[voiceHistory.length - 1];
          if (lastEntry && lastEntry.transcript === transcript) {
            setVoiceHistory((prev) =>
              prev.map((e, idx) =>
                idx === prev.length - 1
                  ? { ...e, isSaved: true, conversationId: conversationId!, savedAt: new Date().toISOString() }
                  : e
              )
            );
          }
        }

        fetchConversations();
      } else {
        setSaveMessage({ type: 'error', text: data.error || 'Failed to save conversation.' });
        setVoiceSessionState('error');
        setSaveLoading(false);
        return;
      }
    } catch (err) {
      console.error('Failed to save conversation:', err);
      setSaveMessage({ type: 'error', text: 'An unexpected error occurred while saving. Please retry.' });
      setVoiceSessionState('error');
      setSaveLoading(false);
      return;
    }

    setSaveLoading(false);

    if (conversationId) {
      await performExtraction(conversationId);
    }
  };

  const handleRetryExtractionAfterSave = async () => {
    if (!savedConversationId || !userId.trim()) return;
    if (extractionState === 'extracting') return;
    await performExtraction(savedConversationId);
  };

  const fetchConversationMemories = async (convId: string) => {
    if (!userId.trim() || !convId) return;
    setLoadingConversationMemories(true);
    try {
      const response = await fetch(`/api/memory?userId=${encodeURIComponent(userId.trim())}&conversationId=${encodeURIComponent(convId)}`);
      const data = await response.json();
      if (response.ok && data.status === 'success') {
        // Safety: Enforce both user ID and conversation ID match expected values
        const verifiedMemories = (data.memories || []).filter((m: Memory) => 
          m.userId === userId.trim() && m.metadata.conversationId === convId
        );
        setConversationMemories(verifiedMemories);
      }
    } catch (err) {
      console.error('Failed to fetch conversation memories:', err);
    } finally {
      setLoadingConversationMemories(false);
    }
  };

  const handleSelectConversation = async (id: string) => {
    if (!userId.trim()) return;
    try {
      const headers: Record<string, string> = {};
      if (process.env.NEXT_PUBLIC_MNEMOS_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.NEXT_PUBLIC_MNEMOS_API_KEY}`;
      }
      const response = await fetch(`/api/v1/conversations/${id}?userId=${encodeURIComponent(userId.trim())}`, {
        headers
      });
      const data = await response.json();
      if (response.ok && data.status === 'success') {
        setSelectedConversation(data.data.conversation);
        setSelectedConvTab('transcript');
        fetchConversationMemories(id);
      }
    } catch (err) {
      console.error('Failed to fetch conversation details:', err);
    }
  };

  const startRecording = async () => {
    if (transcribeLoading || saveLoading || voiceSessionState === 'saving' || voiceSessionState === 'transcribing' || voiceSessionState === 'processing') {
      return;
    }
    setTranscribeError(null);
    setTranscript('');
    setSaveMessage(null);
    setVoiceResponseText(null);
    setVoiceUsedMemories([]);
    setVoiceUsedConversations([]);
    setVoiceContextTokenCount(0);
    setSavedConversationId(null);
    setExtractionState('idle');
    setExtractionResultCount(null);
    setExtractionError(null);
    setRecordingStart(Date.now());
    setRecordingEnd(0);
    setVoiceSessionState('recording');
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
        const endTime = Date.now();
        setRecordingEnd(endTime);
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
      setVoiceSessionState('error');
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
    setVoiceSessionState('processing');
    setTranscribeError(null);
    setVoiceResponseText(null);
    setVoiceUsedMemories([]);
    setVoiceContextTokenCount(0);
    const start = Date.now();

    const transcribingTimeout = setTimeout(() => {
      setVoiceSessionState((current) => current === 'processing' ? 'transcribing' : current);
    }, 1500);

    try {
      const formData = new FormData();
      formData.append('file', blob, 'recording.webm');
      formData.append('userId', userId.trim());

      // Use authorization header if public/local api key is set
      const headers: Record<string, string> = {};
      if (process.env.NEXT_PUBLIC_MNEMOS_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.NEXT_PUBLIC_MNEMOS_API_KEY}`;
      }

      const endpoint = voiceMode === 'ask' ? '/api/v1/voice/respond' : '/api/v1/voice/transcribe';
      const response = await fetch(endpoint, {
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
          endpoint: `POST ${endpoint}`,
          latency,
          status: response.ok ? '200 OK' : `${response.status} Error`,
        },
        ...prev,
      ]);

      if (!response.ok) {
        let msg = 'Failed to process voice action.';
        if (data.error) {
          const errLower = data.error.toLowerCase();
          if (errLower.includes('api_key') || errLower.includes('api key') || errLower.includes('provider') || errLower.includes('unavailable')) {
            msg = 'Voice service is temporarily unavailable.';
          } else if (errLower.includes('transcribe') || errLower.includes('transcription') || errLower.includes('audio') || errLower.includes('speech') || errLower.includes('format')) {
            msg = 'Transcription failed. Please check your microphone and try again.';
          } else if (errLower.includes('database') || errLower.includes('sql') || errLower.includes('persistence')) {
            msg = 'Database connection issue. Unable to process request.';
          } else {
            msg = 'Unable to process voice request. Please try again.';
          }
        }
        setTranscribeError(msg);
        setVoiceSessionState('error');
      } else {
        if (voiceMode === 'ask') {
          setTranscript(data.data.transcript);
          setVoiceResponseText(data.data.response);
          setVoiceUsedMemories(data.data.usedMemories || []);
          setVoiceUsedConversations(data.data.usedConversations || []);
          setVoiceContextTokenCount(data.data.contextTokenCount || 0);
          setVoiceSessionState('review');

          // Add to temporary session history
          const durationSeconds = recordingStart && recordingEnd ? Math.max(0, Math.round((recordingEnd - recordingStart) / 1000)) : 0;
          const newEntry: VoiceSessionEntry = {
            id: 'vse-' + Math.random().toString(36).substring(2, 9),
            transcript: data.data.transcript,
            response: data.data.response,
            usedMemories: data.data.usedMemories || [],
            usedConversations: data.data.usedConversations || [],
            contextTokenCount: data.data.contextTokenCount || 0,
            timestamp: new Date().toISOString(),
            startedAt: recordingStart ? new Date(recordingStart).toISOString() : new Date().toISOString(),
            endedAt: recordingEnd ? new Date(recordingEnd).toISOString() : new Date().toISOString(),
            durationSeconds,
          };
          setSelectedHistoryId(newEntry.id);
          setVoiceHistory((prev) => {
            const updated = [...prev, newEntry];
            if (updated.length > 20) {
              updated.shift();
            }
            return updated;
          });
        } else {
          setTranscript(data.data.text);
          setVoiceSessionState('review');
        }
      }
    } catch (err: unknown) {
      console.error('Voice processing upload failed:', err);
      setTranscribeError('An error occurred during voice upload.');
      setVoiceSessionState('error');
    } finally {
      clearTimeout(transcribingTimeout);
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
    usedMemories: { id: string; type: string; similarity: number; score: number; content?: string; confidence?: number; lifecycleState?: string; conversationId?: string; sourceType?: string; sourceTimestamp?: string }[];
    contextTokenCount: number;
    usedConversations?: { id: string; conversationId?: string; createdAt: string; text: string; matchedSnippet?: string; similarity?: number }[];
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
        let msg = 'Failed to generate contextual response.';
        if (data.error) {
          const errLower = data.error.toLowerCase();
          if (errLower.includes('api_key') || errLower.includes('api key') || errLower.includes('provider') || errLower.includes('unavailable')) {
            msg = 'Grounded response service is temporarily unavailable.';
          } else if (errLower.includes('database') || errLower.includes('sql') || errLower.includes('persistence')) {
            msg = 'Database connection issue. Unable to retrieve context.';
          } else {
            msg = 'Unable to generate response. Please try again.';
          }
        }
        setResponseError(msg);
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
  const [expandedScenarioId, setExpandedScenarioId] = useState<string | null>(null);
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [baselineLabel, setBaselineLabel] = useState<string | null>(null);

  const [historyRuns, setHistoryRuns] = useState<import('@/evaluation/types').EvaluationRunRecord[]>([]);
  const [selectedBaseRunId, setSelectedBaseRunId] = useState<string>('');
  const [selectedTargetRunId, setSelectedTargetRunId] = useState<string>('');
  const [runsComparison, setRunsComparison] = useState<import('@/evaluation/regression').RegressionSummary | null>(null);
  const [evalInsights, setEvalInsights] = useState<import('@/evaluation/insights').EvaluationInsightsSummary | null>(null);
  const [evalRecommendations, setEvalRecommendations] = useState<import('@/evaluation/types').EvaluationRecommendation[]>([]);

  const fetchRecommendations = async () => {
    try {
      const response = await fetch('/api/evaluation/recommendations');
      if (response.ok) {
        const data = await response.json();
        setEvalRecommendations(data.recommendations || []);
      } else {
        const { EvaluationRecommendationsManager } = await import('@/evaluation/recommendations');
        setEvalRecommendations(EvaluationRecommendationsManager.generateRecommendations());
      }
    } catch (err) {
      console.error('Failed to fetch recommendations:', err);
      try {
        const { EvaluationRecommendationsManager } = await import('@/evaluation/recommendations');
        setEvalRecommendations(EvaluationRecommendationsManager.generateRecommendations());
      } catch (e) {
        console.error('Local fallback recommendations failed:', e);
      }
    }
  };

  const fetchInsights = async () => {
    try {
      const response = await fetch('/api/evaluation/insights');
      if (response.ok) {
        const data = await response.json();
        setEvalInsights(data);
      } else {
        const { EvaluationInsightsManager } = await import('@/evaluation/insights');
        setEvalInsights(EvaluationInsightsManager.generateInsights());
      }
    } catch (err) {
      console.error('Failed to fetch insights:', err);
      try {
        const { EvaluationInsightsManager } = await import('@/evaluation/insights');
        setEvalInsights(EvaluationInsightsManager.generateInsights());
      } catch (e) {
        console.error('Local fallback insights failed:', e);
      }
    }
  };

  const fetchHistory = async () => {
    try {
      const response = await fetch('/api/evaluation/history');
      if (response.ok) {
        const data = await response.json();
        setHistoryRuns(data);
      } else {
        const { EvaluationHistoryManager } = await import('@/evaluation/history');
        setHistoryRuns(EvaluationHistoryManager.listRuns());
      }
    } catch (err) {
      console.error('Failed to fetch history:', err);
      try {
        const { EvaluationHistoryManager } = await import('@/evaluation/history');
        setHistoryRuns(EvaluationHistoryManager.listRuns());
      } catch (e) {
        console.error('Local fallback failed:', e);
      }
    }
  };

  const handleDeleteHistoryRun = async (id: string) => {
    try {
      const response = await fetch(`/api/evaluation/history?id=${id}`, { method: 'DELETE' });
      if (response.ok) {
        await fetchHistory();
        await fetchInsights();
        await fetchRecommendations();
      } else {
        const { EvaluationHistoryManager } = await import('@/evaluation/history');
        EvaluationHistoryManager.deleteRun(id);
        await fetchHistory();
        await fetchInsights();
        await fetchRecommendations();
      }
    } catch (err) {
      console.error('Failed to delete history run:', err);
      try {
        const { EvaluationHistoryManager } = await import('@/evaluation/history');
        EvaluationHistoryManager.deleteRun(id);
        await fetchHistory();
        await fetchInsights();
        await fetchRecommendations();
      } catch (e) {
        console.error('Local delete failed:', e);
      }
    }
  };

  const handleClearHistory = async () => {
    try {
      const response = await fetch('/api/evaluation/history', { method: 'DELETE' });
      if (response.ok) {
        await fetchHistory();
        await fetchInsights();
        await fetchRecommendations();
        setRunsComparison(null);
      } else {
        const { EvaluationHistoryManager } = await import('@/evaluation/history');
        EvaluationHistoryManager.clearHistory();
        await fetchHistory();
        await fetchInsights();
        await fetchRecommendations();
        setRunsComparison(null);
      }
    } catch (err) {
      console.error('Failed to clear history:', err);
      try {
        const { EvaluationHistoryManager } = await import('@/evaluation/history');
        EvaluationHistoryManager.clearHistory();
        await fetchHistory();
        await fetchInsights();
        await fetchRecommendations();
        setRunsComparison(null);
      } catch (e) {
        console.error('Local clear failed:', e);
      }
    }
  };

  const handleCompareHistoryRuns = async () => {
    if (!selectedBaseRunId || !selectedTargetRunId) return;
    try {
      const response = await fetch('/api/evaluation/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRunId: selectedBaseRunId, targetRunId: selectedTargetRunId }),
      });
      if (response.ok) {
        const data = await response.json();
        setRunsComparison(data.comparison);
      } else {
        const { EvaluationHistoryManager } = await import('@/evaluation/history');
        const { compareSummaries } = await import('@/evaluation/regression');
        const baseRun = EvaluationHistoryManager.getRun(selectedBaseRunId);
        const targetRun = EvaluationHistoryManager.getRun(selectedTargetRunId);
        if (baseRun && targetRun) {
          const comp = compareSummaries(targetRun.summary, baseRun.summary);
          setRunsComparison(comp);
        }
      }
    } catch (err) {
      console.error('Failed to compare history runs:', err);
      try {
        const { EvaluationHistoryManager } = await import('@/evaluation/history');
        const { compareSummaries } = await import('@/evaluation/regression');
        const baseRun = EvaluationHistoryManager.getRun(selectedBaseRunId);
        const targetRun = EvaluationHistoryManager.getRun(selectedTargetRunId);
        if (baseRun && targetRun) {
          const comp = compareSummaries(targetRun.summary, baseRun.summary);
          setRunsComparison(comp);
        }
      } catch (e) {
        console.error('Local comparison failed:', e);
      }
    }
  };

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
        
        const { compareSummaries, BaselineManager } = await import('@/evaluation/regression');
        const baseline = BaselineManager.getBaseline();
        const regression = compareSummaries(localResult.summary, baseline);
        if (!baseline) {
          BaselineManager.setBaseline(localResult.summary);
        }
        setBaselineLabel(BaselineManager.getLabel());
        
        const { EvaluationHistoryManager } = await import('@/evaluation/history');
        EvaluationHistoryManager.addRun(localResult.summary);
        await fetchHistory();
        await fetchInsights();
        await fetchRecommendations();

        setEvalSummary({
          ...localResult.summary,
          regression,
        });
        setEvalResults(localResult.results);
      } else {
        setEvalSummary(data.summary);
        setEvalResults(data.results);
        if (data.summary?.regression?.baselineLabel) {
          setBaselineLabel(data.summary.regression.baselineLabel);
        } else {
          setBaselineLabel(new Date().toISOString());
        }
        await fetchHistory();
        await fetchInsights();
        await fetchRecommendations();
      }
    } catch (err) {
      console.error('Failed to execute evaluation:', err);
      setEvalError('An unexpected error occurred during evaluation.');
    } finally {
      setEvalLoading(false);
    }
  };

  const handleSetBaseline = async () => {
    if (!evalSummary) return;
    try {
      const response = await fetch('/api/evaluation/baseline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(evalSummary),
      });
      const data = await response.json();
      if (response.ok) {
        setBaselineLabel(data.label);
        const { compareSummaries } = await import('@/evaluation/regression');
        const regression = compareSummaries(evalSummary, evalSummary);
        setEvalSummary({
          ...evalSummary,
          regression,
        });
      } else {
        const { BaselineManager, compareSummaries } = await import('@/evaluation/regression');
        BaselineManager.setBaseline(evalSummary);
        setBaselineLabel(BaselineManager.getLabel());
        const regression = compareSummaries(evalSummary, evalSummary);
        setEvalSummary({
          ...evalSummary,
          regression,
        });
      }
    } catch (err) {
      console.error('Failed to set baseline:', err);
    }
  };

  // A/B Experiment State
  const [controlSemanticWeight, setControlSemanticWeight] = useState(0.7);
  const [controlLexicalWeight, setControlLexicalWeight] = useState(0.3);
  const [controlMinSim, setControlMinSim] = useState(0.5);
  const [controlMaxConvSnippets, setControlMaxConvSnippets] = useState(10);

  const [candidateSemanticWeight, setCandidateSemanticWeight] = useState(0.5);
  const [candidateLexicalWeight, setCandidateLexicalWeight] = useState(0.5);
  const [candidateMinSim, setCandidateMinSim] = useState(0.4);
  const [candidateMaxConvSnippets, setCandidateMaxConvSnippets] = useState(12);

  const [experimentResult, setExperimentResult] = useState<import('@/evaluation/types').ExperimentResult | null>(null);
  const [experimentLoading, setExperimentLoading] = useState(false);
  const [experimentError, setExperimentError] = useState<string | null>(null);

  const handleRunExperiment = async () => {
    setExperimentLoading(true);
    setExperimentError(null);
    setExperimentResult(null);

    const controlConfig = {
      semanticWeight: controlSemanticWeight,
      lexicalWeight: controlLexicalWeight,
      minSimilarity: controlMinSim,
      diversityThreshold: 0.3,
      maxConversationSnippets: controlMaxConvSnippets,
    };

    const candidateConfig = {
      semanticWeight: candidateSemanticWeight,
      lexicalWeight: candidateLexicalWeight,
      minSimilarity: candidateMinSim,
      diversityThreshold: 0.3,
      maxConversationSnippets: candidateMaxConvSnippets,
    };

    try {
      const response = await fetch('/api/evaluation/experiment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ controlConfig, candidateConfig }),
      });
      const data = await response.json();
      if (response.ok) {
        setExperimentResult(data);
        await fetchExperimentHistory();
        await fetchExperimentInsights();
      } else {
        console.warn('Server experiment endpoint failed. Running locally in browser...', data.error);
        if (data.error && data.error.includes('already in progress')) {
          setExperimentError(data.error);
          return;
        }

        const { EvaluationExperimentRunner } = await import('@/evaluation/experiment');
        const localResult = await EvaluationExperimentRunner.runExperiment(controlConfig, candidateConfig);
        const { ExperimentHistoryManager } = await import('@/evaluation/experimentHistory');
        ExperimentHistoryManager.addRecord(localResult);
        setExperimentResult(localResult);
        await fetchExperimentHistory();
        await fetchExperimentInsights();
      }
    } catch (err: unknown) {
      console.error('Failed to run A/B experiment:', err);
      try {
        const { EvaluationExperimentRunner } = await import('@/evaluation/experiment');
        const localResult = await EvaluationExperimentRunner.runExperiment(controlConfig, candidateConfig);
        const { ExperimentHistoryManager } = await import('@/evaluation/experimentHistory');
        ExperimentHistoryManager.addRecord(localResult);
        setExperimentResult(localResult);
        await fetchExperimentHistory();
        await fetchExperimentInsights();
      } catch (e: unknown) {
        setExperimentError(e instanceof Error ? e.message : 'An unexpected error occurred during the A/B experiment.');
      }
    } finally {
      setExperimentLoading(false);
    }
  };

  // A/B Experiment History State
  const [experimentHistory, setExperimentHistory] = useState<import('@/evaluation/types').ExperimentRunRecord[]>([]);
  const [expHistoryLoading, setExpHistoryLoading] = useState(false);
  const [expHistoryError, setExpHistoryError] = useState<string | null>(null);

  // A/B Experiment Insights State
  const [experimentInsights, setExperimentInsights] = useState<import('@/evaluation/types').ExperimentInsights | null>(null);
  const [expInsightsLoading, setExpInsightsLoading] = useState(false);
  const [expInsightsError, setExpInsightsError] = useState<string | null>(null);

  // A/B Configuration Promotion State
  const [promotedConfigStatus, setPromotedConfigStatus] = useState<import('@/evaluation/types').PromotedConfigStatus | null>(null);
  const [promotedLoading, setPromotedLoading] = useState(false);
  const [promotedError, setPromotedError] = useState<string | null>(null);

  // A/B Configuration Promotion History State
  const [promotionHistory, setPromotionHistory] = useState<import('@/evaluation/types').PromotionHistoryRecord[]>([]);
  const [promotionHistoryLoading, setPromotionHistoryLoading] = useState(false);
  const [promotionHistoryError, setPromotionHistoryError] = useState<string | null>(null);

  const fetchPromotionHistory = async () => {
    setPromotionHistoryLoading(true);
    setPromotionHistoryError(null);
    try {
      const response = await fetch('/api/evaluation/config/history');
      if (response.ok) {
        const data = await response.json();
        setPromotionHistory(data);
      } else {
        const { PromotionHistoryManager } = await import('@/evaluation/promotionHistory');
        setPromotionHistory(PromotionHistoryManager.listRecords());
      }
    } catch (err) {
      console.error('Failed to fetch promotion history:', err);
      try {
        const { PromotionHistoryManager } = await import('@/evaluation/promotionHistory');
        setPromotionHistory(PromotionHistoryManager.listRecords());
      } catch (e) {
        console.error('Local promotion history fallback failed:', e);
        setPromotionHistoryError('Failed to load promotion history.');
      }
    } finally {
      setPromotionHistoryLoading(false);
    }
  };

  const handleClearPromotionHistory = async () => {
    const confirmClear = confirm('Are you sure you want to clear the configuration change history audit trail?');
    if (!confirmClear) return;

    setPromotionHistoryLoading(true);
    setPromotionHistoryError(null);
    try {
      const response = await fetch('/api/evaluation/config/history', { method: 'DELETE' });
      if (response.ok) {
        setPromotionHistory([]);
      } else {
        const { PromotionHistoryManager } = await import('@/evaluation/promotionHistory');
        PromotionHistoryManager.clearHistory();
        setPromotionHistory([]);
      }
    } catch (err) {
      console.error('Failed to clear promotion history:', err);
      try {
        const { PromotionHistoryManager } = await import('@/evaluation/promotionHistory');
        PromotionHistoryManager.clearHistory();
        setPromotionHistory([]);
      } catch (e) {
        console.error('Local clear promotion history failed:', e);
      }
    } finally {
      setPromotionHistoryLoading(false);
    }
  };

  const fetchPromotedConfigStatus = async () => {
    setPromotedLoading(true);
    setPromotedError(null);
    try {
      const response = await fetch('/api/evaluation/config');
      if (response.ok) {
        const data = await response.json();
        setPromotedConfigStatus(data);
      } else {
        const { EvaluationConfigPromotionManager } = await import('@/evaluation/promotion');
        setPromotedConfigStatus({
          hasPromotedConfig: EvaluationConfigPromotionManager.hasPromotedConfig(),
          currentConfig: EvaluationConfigPromotionManager.getCurrentConfig(),
          previousConfig: EvaluationConfigPromotionManager.getPreviousConfig(),
        });
      }
    } catch (err) {
      console.error('Failed to fetch promoted config status:', err);
      try {
        const { EvaluationConfigPromotionManager } = await import('@/evaluation/promotion');
        setPromotedConfigStatus({
          hasPromotedConfig: EvaluationConfigPromotionManager.hasPromotedConfig(),
          currentConfig: EvaluationConfigPromotionManager.getCurrentConfig(),
          previousConfig: EvaluationConfigPromotionManager.getPreviousConfig(),
        });
      } catch (e) {
        console.error('Local promotion status fallback failed:', e);
        setPromotedError('Failed to load promoted configuration status.');
      }
    } finally {
      setPromotedLoading(false);
    }
  };

  const handlePromoteConfig = async (config: import('@/evaluation/types').TuningConfig) => {
    const confirmPromote = confirm('Are you sure you want to promote this configuration for subsequent evaluation runs?\nThis will overwrite the active evaluation configuration.');
    if (!confirmPromote) return;

    setPromotedLoading(true);
    setPromotedError(null);
    try {
      const response = await fetch('/api/evaluation/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      const data = await response.json();
      if (response.ok) {
        setPromotedConfigStatus(data);
        await fetchExperimentInsights();
        await fetchPromotionHistory();
      } else {
        const { EvaluationConfigPromotionManager } = await import('@/evaluation/promotion');
        EvaluationConfigPromotionManager.promote(config);
        setPromotedConfigStatus({
          hasPromotedConfig: EvaluationConfigPromotionManager.hasPromotedConfig(),
          currentConfig: EvaluationConfigPromotionManager.getCurrentConfig(),
          previousConfig: EvaluationConfigPromotionManager.getPreviousConfig(),
        });
        await fetchExperimentInsights();
        await fetchPromotionHistory();
      }
    } catch (err) {
      console.error('Failed to promote configuration:', err);
      try {
        const { EvaluationConfigPromotionManager } = await import('@/evaluation/promotion');
        EvaluationConfigPromotionManager.promote(config);
        setPromotedConfigStatus({
          hasPromotedConfig: EvaluationConfigPromotionManager.hasPromotedConfig(),
          currentConfig: EvaluationConfigPromotionManager.getCurrentConfig(),
          previousConfig: EvaluationConfigPromotionManager.getPreviousConfig(),
        });
        await fetchExperimentInsights();
        await fetchPromotionHistory();
      } catch (e: unknown) {
        console.error('Local promotion failed:', e);
        setPromotedError(e instanceof Error ? e.message : 'Failed to promote configuration.');
      }
    } finally {
      setPromotedLoading(false);
    }
  };

  const handleRollbackConfig = async () => {
    const confirmRollback = confirm('Are you sure you want to rollback to the previous configuration?');
    if (!confirmRollback) return;

    setPromotedLoading(true);
    setPromotedError(null);
    try {
      const response = await fetch('/api/evaluation/config', { method: 'DELETE' });
      const data = await response.json();
      if (response.ok) {
        setPromotedConfigStatus(data);
        await fetchExperimentInsights();
        await fetchPromotionHistory();
      } else {
        const { EvaluationConfigPromotionManager } = await import('@/evaluation/promotion');
        EvaluationConfigPromotionManager.rollback();
        setPromotedConfigStatus({
          hasPromotedConfig: EvaluationConfigPromotionManager.hasPromotedConfig(),
          currentConfig: EvaluationConfigPromotionManager.getCurrentConfig(),
          previousConfig: EvaluationConfigPromotionManager.getPreviousConfig(),
        });
        await fetchExperimentInsights();
        await fetchPromotionHistory();
      }
    } catch (err) {
      console.error('Failed to rollback configuration:', err);
      try {
        const { EvaluationConfigPromotionManager } = await import('@/evaluation/promotion');
        EvaluationConfigPromotionManager.rollback();
        setPromotedConfigStatus({
          hasPromotedConfig: EvaluationConfigPromotionManager.hasPromotedConfig(),
          currentConfig: EvaluationConfigPromotionManager.getCurrentConfig(),
          previousConfig: EvaluationConfigPromotionManager.getPreviousConfig(),
        });
        await fetchExperimentInsights();
        await fetchPromotionHistory();
      } catch (e: unknown) {
        console.error('Local rollback failed:', e);
        setPromotedError(e instanceof Error ? e.message : 'Failed to rollback configuration.');
      }
    } finally {
      setPromotedLoading(false);
    }
  };

  const [baseExpId, setBaseExpId] = useState('');
  const [targetExpId, setTargetExpId] = useState('');
  const [expComparisonResult, setExpComparisonResult] = useState<{ comparison: import('@/evaluation/regression').RegressionSummary } | null>(null);
  const [expComparisonLoading, setExpComparisonLoading] = useState(false);
  const [expComparisonError, setExpComparisonError] = useState<string | null>(null);

  const fetchExperimentHistory = async () => {
    setExpHistoryLoading(true);
    setExpHistoryError(null);
    try {
      const response = await fetch('/api/evaluation/experiments/history');
      if (response.ok) {
        const data = await response.json();
        setExperimentHistory(data);
      } else {
        const { ExperimentHistoryManager } = await import('@/evaluation/experimentHistory');
        setExperimentHistory(ExperimentHistoryManager.listRecords());
      }
    } catch (err) {
      console.error('Failed to fetch experiment history:', err);
      try {
        const { ExperimentHistoryManager } = await import('@/evaluation/experimentHistory');
        setExperimentHistory(ExperimentHistoryManager.listRecords());
      } catch (e) {
        console.error('Local fallback failed:', e);
        setExpHistoryError('Failed to load experiment history.');
      }
    } finally {
      setExpHistoryLoading(false);
    }
  };

  const fetchExperimentInsights = async () => {
    setExpInsightsLoading(true);
    setExpInsightsError(null);
    try {
      const response = await fetch('/api/evaluation/experiments/insights');
      if (response.ok) {
        const data = await response.json();
        setExperimentInsights(data);
      } else {
        const { ExperimentInsightsManager } = await import('@/evaluation/experimentInsights');
        setExperimentInsights(ExperimentInsightsManager.generateInsights());
      }
    } catch (err) {
      console.error('Failed to fetch experiment insights:', err);
      try {
        const { ExperimentInsightsManager } = await import('@/evaluation/experimentInsights');
        setExperimentInsights(ExperimentInsightsManager.generateInsights());
      } catch (e) {
        console.error('Local insights fallback failed:', e);
        setExpInsightsError('Failed to load experiment insights.');
      }
    } finally {
      setExpInsightsLoading(false);
    }
  };

  const handleDeleteExperiment = async (id: string) => {
    try {
      const response = await fetch(`/api/evaluation/experiments/history?id=${id}`, { method: 'DELETE' });
      if (response.ok) {
        await fetchExperimentHistory();
        await fetchExperimentInsights();
      } else {
        const { ExperimentHistoryManager } = await import('@/evaluation/experimentHistory');
        ExperimentHistoryManager.deleteRecord(id);
        await fetchExperimentHistory();
        await fetchExperimentInsights();
      }
    } catch (err) {
      console.error('Failed to delete experiment:', err);
      try {
        const { ExperimentHistoryManager } = await import('@/evaluation/experimentHistory');
        ExperimentHistoryManager.deleteRecord(id);
        await fetchExperimentHistory();
        await fetchExperimentInsights();
      } catch (e) {
        console.error('Local delete failed:', e);
      }
    }
  };

  const handleClearExperimentHistory = async () => {
    try {
      const response = await fetch('/api/evaluation/experiments/history', { method: 'DELETE' });
      if (response.ok) {
        await fetchExperimentHistory();
        await fetchExperimentInsights();
      } else {
        const { ExperimentHistoryManager } = await import('@/evaluation/experimentHistory');
        ExperimentHistoryManager.clearHistory();
        await fetchExperimentHistory();
        await fetchExperimentInsights();
      }
    } catch (err) {
      console.error('Failed to clear experiment history:', err);
      try {
        const { ExperimentHistoryManager } = await import('@/evaluation/experimentHistory');
        ExperimentHistoryManager.clearHistory();
        await fetchExperimentHistory();
        await fetchExperimentInsights();
      } catch (e) {
        console.error('Local clear failed:', e);
      }
    }
  };

  const handleCompareExperiments = async () => {
    if (!baseExpId || !targetExpId) return;
    setExpComparisonLoading(true);
    setExpComparisonError(null);
    setExpComparisonResult(null);
    try {
      const response = await fetch('/api/evaluation/experiments/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseExperimentId: baseExpId, targetExperimentId: targetExpId }),
      });
      const data = await response.json();
      if (response.ok) {
        setExpComparisonResult(data);
      } else {
        setExpComparisonError(data.error || 'Failed to compare experiments.');
      }
    } catch (err: unknown) {
      console.error('Failed to compare experiments:', err);
      try {
        const { ExperimentHistoryManager } = await import('@/evaluation/experimentHistory');
        const { compareSummaries } = await import('@/evaluation/regression');
        const base = ExperimentHistoryManager.getRecord(baseExpId);
        const target = ExperimentHistoryManager.getRecord(targetExpId);
        if (!base || !target) {
          setExpComparisonError('Selected experiments not found in history.');
        } else {
          const comp = compareSummaries(target.candidateSummary, base.candidateSummary);
          setExpComparisonResult({ comparison: comp });
        }
      } catch (e: unknown) {
        setExpComparisonError(e instanceof Error ? e.message : 'An unexpected error occurred.');
      }
    } finally {
      setExpComparisonLoading(false);
    }
  };

  // Parameter Tuning State
  const [tuningSummary, setTuningSummary] = useState<TuningBenchmarkSummary | null>(null);
  const [tuningLoading, setTuningLoading] = useState(false);
  const [tuningError, setTuningError] = useState<string | null>(null);
  const [tuningMode, setTuningMode] = useState<'mock' | 'real'>('real');

  const handleRunTuning = async () => {
    setTuningLoading(true);
    setTuningError(null);
    setTuningSummary(null);

    try {
      const response = await fetch('/api/evaluation/tune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ benchmarkMode: tuningMode }),
      });
      const data = await response.json();
      if (!response.ok) {
        setTuningError(data.error || 'Failed to execute parameter optimization.');
      } else {
        setTuningSummary(data);
      }
    } catch (err) {
      console.error('Failed to execute parameter tuning:', err);
      setTuningError('An unexpected error occurred during tuning.');
    } finally {
      setTuningLoading(false);
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
      fetchHistory();
      fetchInsights();
      fetchRecommendations();
      fetchExperimentHistory();
      fetchExperimentInsights();
      fetchPromotedConfigStatus();
      fetchPromotionHistory();
    }, 0);
    const healthInterval = setInterval(fetchHealth, 15000);
    return () => clearInterval(healthInterval);
  }, []);

  useEffect(() => {
    setTimeout(() => {
      fetchMemories();
      fetchConversations();
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
                  
                  {/* Mode Selector */}
                  <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem', backgroundColor: 'var(--background)', padding: '0.2rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                    <button
                      onClick={() => handleSwitchVoiceMode('transcribe')}
                      className={`premium-btn ${voiceMode === 'transcribe' ? 'premium-btn-primary' : 'premium-btn-secondary'}`}
                      style={{ flex: 1, padding: '0.3rem', fontSize: '0.75rem', border: 'none', boxShadow: 'none' }}
                      type="button"
                      disabled={voiceSessionState === 'recording' || voiceSessionState === 'transcribing' || voiceSessionState === 'saving' || voiceSessionState === 'processing'}
                    >
                      📝 Transcribe Only
                    </button>
                    <button
                      onClick={() => handleSwitchVoiceMode('ask')}
                      className={`premium-btn ${voiceMode === 'ask' ? 'premium-btn-primary' : 'premium-btn-secondary'}`}
                      style={{ flex: 1, padding: '0.3rem', fontSize: '0.75rem', border: 'none', boxShadow: 'none' }}
                      type="button"
                      disabled={voiceSessionState === 'recording' || voiceSessionState === 'transcribing' || voiceSessionState === 'saving' || voiceSessionState === 'processing'}
                    >
                      💬 Ask by Voice
                    </button>
                  </div>

                  {/* Pulsing microphone recording indicator */}
                  {voiceSessionState === 'recording' && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', padding: '1rem', backgroundColor: 'rgba(219, 91, 91, 0.03)', border: '1px dashed #db5b5b', borderRadius: 'var(--radius-sm)', position: 'relative', overflow: 'hidden' }}>
                      <style>{`
                        @keyframes voicePulse {
                          0% { transform: scale(0.85); opacity: 0.5; }
                          50% { transform: scale(1.15); opacity: 0.15; }
                          100% { transform: scale(0.85); opacity: 0.5; }
                        }
                      `}</style>
                      <div style={{
                        position: 'absolute',
                        width: '80px',
                        height: '80px',
                        borderRadius: '50%',
                        backgroundColor: 'rgba(219, 91, 91, 0.1)',
                        animation: 'voicePulse 1.5s infinite ease-in-out',
                        zIndex: 0
                      }}></div>
                      <div style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '50%',
                        backgroundColor: '#db5b5b',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#fff',
                        zIndex: 1,
                        boxShadow: '0 0 12px rgba(219, 91, 91, 0.4)'
                      }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                          <line x1="12" x2="12" y1="19" y2="22" />
                        </svg>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', zIndex: 1, marginTop: '0.25rem' }}>
                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--error)' }}>Capturing Audio...</span>
                      </div>
                      <span style={{ fontFamily: 'monospace', fontSize: '1rem', fontWeight: 600, color: 'var(--text)', zIndex: 1 }}>
                        {Math.floor(recordingTime / 60).toString().padStart(2, '0')}:
                        {(recordingTime % 60).toString().padStart(2, '0')}
                      </span>
                    </div>
                  )}

                  {voiceSessionState === 'processing' && (
                    <div style={{ padding: '0.5rem 0.75rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', opacity: 0.8, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {renderSpinner()}
                      <span>Preparing Whisper...</span>
                    </div>
                  )}

                  {voiceSessionState === 'transcribing' && (
                    <div style={{ padding: '0.5rem 0.75rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', opacity: 0.8, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {renderSpinner()}
                      <span>{voiceMode === 'ask' ? 'Processing grounded query...' : 'Transcribing recording file...'}</span>
                    </div>
                  )}

                  {voiceSessionState === 'saving' && (
                    <div style={{ padding: '0.5rem 0.75rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', opacity: 0.8, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {renderSpinner()}
                      <span>Saving conversation details...</span>
                    </div>
                  )}

                  {/* Audio trigger controls */}
                  {voiceSessionState !== 'transcribing' && voiceSessionState !== 'saving' && voiceSessionState !== 'processing' && (
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      {voiceSessionState === 'recording' ? (
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
                          disabled={false}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '0.25rem' }}>
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" x2="12" y1="19" y2="22" />
                          </svg>
                          {voiceMode === 'ask' ? 'Ask by Voice' : 'Start Recording'}
                        </button>
                      )}
                    </div>
                  )}

                  {transcribeError && (
                    <div style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--error)', backgroundColor: 'rgba(179, 74, 60, 0.05)', color: 'var(--error)', fontSize: '0.75rem' }}>
                      {transcribeError}
                    </div>
                  )}

                  {/* Transcript editable card */}
                  {(voiceSessionState === 'review' || voiceSessionState === 'saving' || voiceSessionState === 'saved' || voiceSessionState === 'error') && transcript !== undefined && (
                    <div style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--primary)' }}>
                          {voiceMode === 'ask' ? 'Edit Question' : 'Transcript Output'}
                        </span>
                        {voiceMode === 'transcribe' && (
                          <button
                            onClick={() => setContentInput(transcript)}
                            className="premium-btn premium-btn-secondary"
                            style={{ padding: '0.2rem 0.4rem', fontSize: '0.7rem' }}
                            disabled={voiceSessionState === 'saving' || extractionState === 'extracting'}
                          >
                            📋 Copy to Ingest Form
                          </button>
                        )}
                      </div>
                      
                      <textarea
                        value={transcript}
                        onChange={(e) => {
                          setTranscript(e.target.value);
                          if (voiceSessionState === 'error') {
                            setVoiceSessionState('review');
                          }
                        }}
                        readOnly={selectedHistoryId !== null || voiceSessionState === 'saving' || voiceSessionState === 'saved' || extractionState === 'extracting' || (voiceMode === 'ask' && transcribeLoading)}
                        style={{
                          width: '100%',
                          minHeight: '120px',
                          padding: '0.6rem 0.8rem',
                          backgroundColor: 'var(--background)',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: '0.8rem',
                          lineHeight: '1.45',
                          color: 'var(--text)',
                          fontFamily: 'inherit',
                          resize: 'vertical'
                        }}
                      />

                      <div style={{ fontSize: '0.65rem', opacity: 0.6, alignSelf: 'flex-end', marginTop: '-0.25rem' }}>
                        Characters: {transcript.length} / 10,000 ({Math.max(0, 10000 - transcript.length)} remaining)
                      </div>

                      {selectedHistoryId !== null ? (
                        <div style={{ display: 'flex', gap: '0.5rem', width: '100%', marginTop: '0.25rem' }}>
                          <button
                            onClick={handleReturnToCurrentQuery}
                            className="premium-btn premium-btn-primary"
                            style={{ width: '100%' }}
                            type="button"
                          >
                            ✍️ Return to Current Query
                          </button>
                        </div>
                      ) : voiceMode === 'ask' ? (
                        <div style={{ display: 'flex', gap: '0.5rem', width: '100%', marginTop: '0.25rem' }}>
                          <button
                            onClick={resetVoiceSession}
                            className="premium-btn premium-btn-secondary"
                            style={{ flex: 1 }}
                            disabled={transcribeLoading || saveLoading}
                            type="button"
                          >
                            ✕ Clear
                          </button>
                          
                          <button
                            onClick={handleSubmitEditedVoiceQuery}
                            className="premium-btn premium-btn-primary"
                            disabled={transcribeLoading || saveLoading || !transcript || !transcript.trim()}
                            style={{ flex: 2 }}
                            type="button"
                          >
                            {transcribeLoading ? (
                              <>
                                {renderSpinner()}
                                Generating...
                              </>
                            ) : (
                              'Get Answer'
                            )}
                          </button>
                        </div>
                      ) : voiceSessionState === 'saved' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%', marginTop: '0.25rem' }}>
                          <div style={{
                            padding: '0.5rem 0.75rem',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: '0.75rem',
                            border: '1px solid var(--success)',
                            backgroundColor: 'rgba(91, 138, 82, 0.05)',
                            color: 'var(--success)',
                            textAlign: 'center',
                            fontWeight: 600
                          }}>
                            ✓ Conversation Saved
                          </div>

                          {extractionState === 'extracting' && (
                            <div style={{ padding: '0.5rem 0.75rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', opacity: 0.8, display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'center' }}>
                              {renderSpinner()}
                              <span>Extracting memories...</span>
                            </div>
                          )}

                          {extractionState === 'extracted' && extractionResultCount !== null && (
                            <div style={{
                              padding: '0.5rem 0.75rem',
                              borderRadius: 'var(--radius-sm)',
                              fontSize: '0.75rem',
                              border: '1px solid var(--success)',
                              backgroundColor: 'rgba(91, 138, 82, 0.05)',
                              color: 'var(--success)',
                              textAlign: 'center',
                              fontWeight: 600
                            }}>
                              ✓ Memories Extracted: {extractionResultCount}
                            </div>
                          )}

                          {extractionState === 'extraction-error' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                              <div style={{
                                padding: '0.5rem 0.75rem',
                                borderRadius: 'var(--radius-sm)',
                                fontSize: '0.75rem',
                                border: '1px solid var(--error)',
                                backgroundColor: 'rgba(179, 74, 60, 0.05)',
                                color: 'var(--error)',
                                textAlign: 'center'
                              }}>
                                Conversation Saved — Extraction Failed
                                {extractionError && <div style={{ fontSize: '0.7rem', marginTop: '0.2rem', opacity: 0.8 }}>{extractionError}</div>}
                              </div>
                              <button
                                onClick={handleRetryExtractionAfterSave}
                                className="premium-btn premium-btn-primary"
                                style={{ width: '100%' }}
                                type="button"
                              >
                                🔄 Retry Extraction
                              </button>
                            </div>
                          )}

                          <button
                            onClick={resetVoiceSession}
                            className="premium-btn premium-btn-secondary"
                            style={{ width: '100%' }}
                            disabled={extractionState === 'extracting'}
                            type="button"
                          >
                            Clear & Start New Recording
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: '0.5rem', width: '100%', marginTop: '0.25rem' }}>
                          <button
                            onClick={resetVoiceSession}
                            className="premium-btn premium-btn-secondary"
                            style={{ flex: 1 }}
                            disabled={voiceSessionState === 'saving' || extractionState === 'extracting'}
                            type="button"
                          >
                            ✕ Clear
                          </button>
                          
                          <button
                            onClick={handleSaveConversation}
                            className="premium-btn premium-btn-secondary"
                            disabled={saveLoading || !transcript || !transcript.trim() || voiceSessionState === 'saving' || extractionState === 'extracting'}
                            style={{ flex: 2 }}
                            type="button"
                          >
                            {voiceSessionState === 'saving' && !savedConversationId ? (
                              <>
                                {renderSpinner()}
                                Saving...
                              </>
                            ) : (
                              'Save'
                            )}
                          </button>

                          <button
                            onClick={handleSaveAndExtractMemories}
                            className="premium-btn premium-btn-primary"
                            disabled={saveLoading || !transcript || !transcript.trim() || voiceSessionState === 'saving' || extractionState === 'extracting'}
                            style={{ flex: 3 }}
                            type="button"
                          >
                            {voiceSessionState === 'saving' || extractionState === 'extracting' ? (
                              <>
                                {renderSpinner()}
                                Processing...
                              </>
                            ) : (
                              'Save & Extract Memories'
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {voiceMode === 'ask' && voiceResponseText && (
                    <div style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {voiceResponseText && (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                            <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--primary)' }}>🧠 Grounded Response:</span>
                            {/* Grounding Status badge */}
                            {(() => {
                              const status = getGroundingStatus(voiceUsedMemories, voiceUsedConversations);
                              return (
                                <span style={{
                                  fontSize: '0.65rem',
                                  fontWeight: 600,
                                  color: status.color,
                                  backgroundColor: status.bgColor,
                                  border: `1px solid ${status.borderColor}`,
                                  padding: '0.15rem 0.4rem',
                                  borderRadius: '12px'
                                }}>
                                  {status.label}
                                </span>
                              );
                            })()}
                          </div>
                          <div style={{ padding: '0.6rem 0.8rem', backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', lineHeight: '1.45', color: 'var(--text)' }}>
                            {voiceResponseText}
                          </div>
                        </div>
                      )}

                      {/* Sources block */}
                      <div style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                        <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--primary)', display: 'block', marginBottom: '0.35rem' }}>
                          📚 Sources Used ({voiceContextTokenCount} tokens):
                        </span>
                        
                        {(voiceUsedMemories.length === 0 && voiceUsedConversations.length === 0) ? (
                          <div style={{ padding: '0.5rem', textAlign: 'center', opacity: 0.6, border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', color: 'var(--text)' }}>
                            No relevant memory found
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                            {/* Voice Memories */}
                            {voiceUsedMemories.map((m, idx) => {
                              const key = `vmem-${idx}`;
                              const isExpanded = !!expandedCitations[key];
                              return (
                                <div key={key} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--background)', overflow: 'hidden' }}>
                                  <button
                                    type="button"
                                    onClick={() => toggleCitation(key)}
                                    aria-expanded={isExpanded}
                                    aria-controls={`content-${key}`}
                                    style={{
                                      width: '100%',
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      padding: '0.4rem 0.6rem',
                                      backgroundColor: 'rgba(59, 130, 246, 0.03)',
                                      border: 'none',
                                      cursor: 'pointer',
                                      textAlign: 'left',
                                      fontSize: '0.75rem',
                                      fontWeight: 600,
                                      color: '#3b82f6',
                                    }}
                                  >
                                    <span>🧠 Persistent Memory ({m.type})</span>
                                    <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>
                                      {isExpanded ? '▼' : '▶'}
                                    </span>
                                  </button>
                                  {isExpanded && (
                                    <div id={`content-${key}`} style={{ padding: '0.5rem 0.6rem', borderTop: '1px solid var(--border)', fontSize: '0.75rem' }}>
                                      <div style={{ fontStyle: 'italic', color: 'var(--text)', marginBottom: '0.35rem' }}>
                                        &ldquo;{m.content}&rdquo;
                                      </div>
                                      <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.65rem', opacity: 0.7 }}>
                                        <span>Confidence: <strong>{((m.confidence || 0.9) * 100).toFixed(0)}%</strong></span>
                                        <span>Lifecycle: <strong style={{ textTransform: 'capitalize' }}>{m.lifecycleState || 'stable'}</strong></span>
                                      </div>
                                      {m.conversationId && m.sourceType === 'conversation' && m.sourceTimestamp && (
                                        <div style={{ marginTop: '0.4rem', borderTop: '1px dashed var(--border)', paddingTop: '0.4rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                          <span style={{ fontSize: '0.65rem', opacity: 0.8 }}>
                                            From conversation · {formatProvenanceDate(m.sourceTimestamp)}
                                          </span>
                                          <button
                                            type="button"
                                            onClick={() => handleSelectConversation(m.conversationId!)}
                                            style={{
                                              fontSize: '0.65rem',
                                              color: 'var(--primary)',
                                              background: 'none',
                                              border: 'none',
                                              cursor: 'pointer',
                                              padding: 0,
                                              textDecoration: 'underline',
                                              fontWeight: 600,
                                            }}
                                          >
                                            View Source Conversation
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}

                            {/* Voice Conversations */}
                            {voiceUsedConversations.map((c, idx) => {
                              const key = `vconv-${idx}`;
                              const isExpanded = !!expandedCitations[key];
                              return (
                                <div key={key} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--background)', overflow: 'hidden' }}>
                                  <button
                                    type="button"
                                    onClick={() => toggleCitation(key)}
                                    aria-expanded={isExpanded}
                                    aria-controls={`content-${key}`}
                                    style={{
                                      width: '100%',
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      padding: '0.4rem 0.6rem',
                                      backgroundColor: 'rgba(16, 185, 129, 0.03)',
                                      border: 'none',
                                      cursor: 'pointer',
                                      textAlign: 'left',
                                      fontSize: '0.75rem',
                                      fontWeight: 600,
                                      color: '#10b981',
                                    }}
                                  >
                                    <span>💬 Past Conversation ({new Date(c.createdAt).toLocaleDateString()})</span>
                                    <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>
                                      {isExpanded ? '▼' : '▶'}
                                    </span>
                                  </button>
                                  {isExpanded && (
                                    <div id={`content-${key}`} style={{ padding: '0.5rem 0.6rem', borderTop: '1px solid var(--border)', fontSize: '0.75rem' }}>
                                      <div style={{ fontStyle: 'italic', color: 'var(--text)', marginBottom: '0.35rem' }}>
                                        &ldquo;{c.matchedSnippet || c.text}&rdquo;
                                      </div>
                                      <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.65rem', opacity: 0.7 }}>
                                        {c.similarity !== undefined && c.similarity !== null ? (
                                          <span>Similarity: <strong>{(c.similarity * 100).toFixed(0)}%</strong></span>
                                        ) : (
                                          <span style={{ color: 'var(--primary)' }}>Relevance: Keyword Match</span>
                                        )}
                                        <span>Date/Time: <strong>{new Date(c.createdAt).toLocaleDateString()} {new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong></span>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                        <button
                          onClick={handleVoiceAskAgain}
                          className="premium-btn premium-btn-primary"
                          style={{ flex: 1 }}
                          type="button"
                        >
                          🔄 Ask Another
                        </button>
                        <button
                          onClick={handleClearVoiceSessionWithWarning}
                          className="premium-btn premium-btn-secondary"
                          style={{ flex: 1 }}
                          type="button"
                        >
                          ❌ Clear Session
                        </button>
                      </div>
                    </div>
                  )}

                  {saveMessage && (
                    <div style={{
                      padding: '0.5rem 0.75rem',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.75rem',
                      border: '1px solid',
                      borderColor: saveMessage.type === 'success' ? 'var(--success)' : 'var(--error)',
                      backgroundColor: saveMessage.type === 'success' ? 'rgba(91, 138, 82, 0.05)' : 'rgba(179, 74, 60, 0.05)',
                      color: saveMessage.type === 'success' ? 'var(--success)' : 'var(--error)'
                    }}>
                      {saveMessage.text}
                    </div>
                  )}

                  {/* Current Session History (Sprint 28/29) */}
                  {voiceHistory.length > 0 && (
                    <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <h4 style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--primary)', margin: 0 }}>
                          Current Session ({voiceHistory.length})
                        </h4>
                        <button
                          onClick={handleClearVoiceSessionWithWarning}
                          className="premium-btn premium-btn-secondary"
                          style={{ padding: '0.15rem 0.35rem', fontSize: '0.65rem', border: 'none', boxShadow: 'none' }}
                          type="button"
                        >
                          Clear Session
                        </button>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '180px', overflowY: 'auto', paddingRight: '0.2rem' }}>
                        {voiceHistory.map((entry, idx) => {
                          const isSelected = selectedHistoryId === entry.id;
                          return (
                            <div
                              key={entry.id}
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                padding: '0.5rem 0.6rem',
                                backgroundColor: isSelected ? 'rgba(99, 102, 241, 0.08)' : 'var(--background)',
                                border: `1px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                                borderRadius: 'var(--radius-sm)',
                                width: '100%',
                                transition: 'all 0.15s ease',
                              }}
                            >
                              <button
                                onClick={() => handleSelectHistoryEntry(entry.id)}
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  alignItems: 'flex-start',
                                  textAlign: 'left',
                                  background: 'none',
                                  border: 'none',
                                  padding: 0,
                                  cursor: 'pointer',
                                  width: '100%',
                                  fontSize: '0.75rem',
                                }}
                                type="button"
                              >
                                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', fontWeight: 600, opacity: 0.9, marginBottom: '0.15rem' }}>
                                  <span>
                                    Q{idx + 1}: {entry.transcript.slice(0, 24)}{entry.transcript.length > 24 ? '...' : ''}
                                    {entry.isSaved && (
                                      <span style={{ marginLeft: '0.4rem', fontSize: '0.6rem', color: 'var(--success)', fontWeight: 'bold' }}>
                                        ✓ Saved
                                      </span>
                                    )}
                                  </span>
                                  <span style={{ fontSize: '0.6rem', opacity: 0.6 }}>
                                    {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                  </span>
                                </div>
                                <span style={{ opacity: 0.7, fontSize: '0.7rem', color: 'var(--text)' }}>
                                  {entry.response ? `${entry.response.slice(0, 40)}${entry.response.length > 40 ? '...' : ''}` : 'No response'}
                                </span>
                              </button>

                              {/* Save/Open/Retry Actions Row */}
                              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.35rem', borderTop: '1px solid var(--border)', paddingTop: '0.35rem', justifyContent: 'flex-end', alignItems: 'center' }}>
                                {entry.isSaved ? (
                                  <button
                                    onClick={() => handleSelectConversation(entry.conversationId!)}
                                    className="premium-btn premium-btn-secondary"
                                    style={{ padding: '0.15rem 0.35rem', fontSize: '0.65rem' }}
                                    type="button"
                                  >
                                    📂 Open Conversation
                                  </button>
                                ) : (
                                  <>
                                    {historySaveError[entry.id] && (
                                      <span style={{ fontSize: '0.65rem', color: 'var(--error)', alignSelf: 'center', marginRight: 'auto' }}>
                                        Failed
                                      </span>
                                    )}
                                    <button
                                      onClick={() => handleSaveHistoryEntry(entry.id)}
                                      className="premium-btn premium-btn-primary"
                                      style={{ padding: '0.15rem 0.35rem', fontSize: '0.65rem' }}
                                      disabled={historySavingId === entry.id}
                                      type="button"
                                    >
                                      {historySavingId === entry.id ? 'Saving...' : historySaveError[entry.id] ? 'Retry Save' : '💾 Save'}
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Conversation Timeline & Intelligence (Sprint 30/31) */}
                  <div style={{ marginTop: '1.25rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                    
                    {/* Intelligence Summary Panel */}
                    {(() => {
                      const now = new Date();
                      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                      const calendarWindowStart = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);

                      const totalSaved = conversations.length;
                      const hasSummary = conversations.filter(c => c.summary).length;
                      const hasMemories = conversations.filter(c => memories.some(m => m.metadata?.conversationId === c.id)).length;
                      const recentActivity = conversations.filter(c => new Date(c.createdAt) >= calendarWindowStart).length;

                      // Sparkline activity (last 7 days)
                      const last7Days = Array.from({ length: 7 }, (_, i) => {
                        const d = new Date(startOfToday.getTime());
                        d.setDate(d.getDate() - (6 - i));
                        return d;
                      });

                      const dailyCounts = last7Days.map((dayDate) => {
                        const nextDay = new Date(dayDate.getTime() + 24 * 60 * 60 * 1000);
                        const count = conversations.filter((c) => {
                          const cDate = new Date(c.createdAt);
                          return cDate >= dayDate && cDate < nextDay;
                        }).length;
                        return { date: dayDate, count };
                      });

                      const maxCount = Math.max(...dailyCounts.map(d => d.count), 1);
                      const totalActivityCount = dailyCounts.reduce((acc, curr) => acc + curr.count, 0);

                      // Memory growth rate
                      const hasTimestamps = memories.length > 0 && memories.every(m => m.createdAt || m.metadata?.timestamp);
                      const newMemoriesCount = hasTimestamps ? memories.filter(m => new Date(m.createdAt || m.metadata?.timestamp) >= calendarWindowStart).length : 0;
                      const growthText = hasTimestamps ? `+${newMemoriesCount} new` : '—';

                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: '0.75rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h4 style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--primary)', margin: 0 }}>
                              Conversation Intelligence
                            </h4>
                          </div>

                          {/* Stats Grid */}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.4rem' }}>
                            <button
                              onClick={() => setTimelineFilterMode(timelineFilterMode === 'all' ? 'all' : 'all')}
                              className="premium-btn"
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                padding: '0.4rem',
                                borderRadius: 'var(--radius-sm)',
                                backgroundColor: timelineFilterMode === 'all' ? 'rgba(99, 102, 241, 0.08)' : 'var(--background)',
                                border: `1px solid ${timelineFilterMode === 'all' ? 'var(--primary)' : 'var(--border)'}`,
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                              }}
                              type="button"
                            >
                              <span style={{ fontSize: '0.6rem', opacity: 0.6 }}>Saved Available</span>
                              <strong style={{ fontSize: '0.95rem' }}>{totalSaved}</strong>
                            </button>

                            <button
                              onClick={() => setTimelineFilterMode(timelineFilterMode === 'has-summary' ? 'all' : 'has-summary')}
                              className="premium-btn"
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                padding: '0.4rem',
                                borderRadius: 'var(--radius-sm)',
                                backgroundColor: timelineFilterMode === 'has-summary' ? 'rgba(99, 102, 241, 0.08)' : 'var(--background)',
                                border: `1px solid ${timelineFilterMode === 'has-summary' ? 'var(--primary)' : 'var(--border)'}`,
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                              }}
                              type="button"
                            >
                              <span style={{ fontSize: '0.6rem', opacity: 0.6 }}>Has Summary</span>
                              <strong style={{ fontSize: '0.95rem' }}>{hasSummary}</strong>
                            </button>

                            <button
                              onClick={() => setTimelineFilterMode(timelineFilterMode === 'has-memories' ? 'all' : 'has-memories')}
                              className="premium-btn"
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                padding: '0.4rem',
                                borderRadius: 'var(--radius-sm)',
                                backgroundColor: timelineFilterMode === 'has-memories' ? 'rgba(99, 102, 241, 0.08)' : 'var(--background)',
                                border: `1px solid ${timelineFilterMode === 'has-memories' ? 'var(--primary)' : 'var(--border)'}`,
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                              }}
                              type="button"
                            >
                              <span style={{ fontSize: '0.6rem', opacity: 0.6 }}>Extracted</span>
                              <strong style={{ fontSize: '0.95rem' }}>{hasMemories}</strong>
                            </button>

                            <button
                              onClick={() => setTimelineFilterMode(timelineFilterMode === 'recent' ? 'all' : 'recent')}
                              className="premium-btn"
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                padding: '0.4rem',
                                borderRadius: 'var(--radius-sm)',
                                backgroundColor: timelineFilterMode === 'recent' ? 'rgba(99, 102, 241, 0.08)' : 'var(--background)',
                                border: `1px solid ${timelineFilterMode === 'recent' ? 'var(--primary)' : 'var(--border)'}`,
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                              }}
                              type="button"
                            >
                              <span style={{ fontSize: '0.6rem', opacity: 0.6 }}>Recent (7d)</span>
                              <strong style={{ fontSize: '0.95rem' }}>{recentActivity}</strong>
                            </button>
                          </div>

                          {/* Visualization row: Activity & Memory Growth */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.4rem 0.5rem', backgroundColor: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', gap: '0.5rem' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                              <span style={{ fontSize: '0.6rem', opacity: 0.6 }}>Memory Growth (7d)</span>
                              <span style={{ fontSize: '0.75rem', fontWeight: 'bold', color: hasTimestamps ? 'var(--success)' : 'inherit' }}>
                                {growthText}
                              </span>
                            </div>
                            
                            {/* Activity Sparkline */}
                            <div
                              aria-label={`Recent activity chart: ${totalActivityCount} conversations in last 7 days`}
                              style={{ display: 'flex', gap: '0.2rem', alignItems: 'flex-end', height: '24px', paddingLeft: '0.5rem', borderLeft: '1px solid var(--border)' }}
                            >
                              {dailyCounts.map((d, i) => {
                                const heightPercent = (d.count / maxCount) * 100;
                                return (
                                  <div
                                    key={i}
                                    title={`${d.date.toLocaleDateString()}: ${d.count} conversations`}
                                    style={{
                                      width: '6px',
                                      height: `${Math.max(15, heightPercent)}%`,
                                      backgroundColor: d.count > 0 ? 'var(--primary)' : 'var(--border)',
                                      borderRadius: '1px',
                                      transition: 'height 0.15s ease',
                                    }}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Timeline Input & List block */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
                      <h4 style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--primary)', margin: 0 }}>
                        Conversation Timeline
                      </h4>
                      {timelineFilterMode !== 'all' && (
                        <button
                          onClick={() => setTimelineFilterMode('all')}
                          style={{
                            fontSize: '0.6rem',
                            color: 'var(--primary)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: 0,
                          }}
                          type="button"
                        >
                          ✕ Clear Filter ({timelineFilterMode})
                        </button>
                      )}
                    </div>

                    <input
                      type="text"
                      placeholder="🔍 Search timeline..."
                      value={timelineSearch}
                      onChange={(e) => setTimelineSearch(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.35rem 0.55rem',
                        fontSize: '0.75rem',
                        backgroundColor: 'var(--background)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)',
                        color: 'var(--text)',
                        marginBottom: '0.6rem',
                        outline: 'none',
                      }}
                    />

                    {(() => {
                      const now = new Date();
                      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                      const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
                      const calendarWindowStart = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);

                      const filtered = conversations.filter((conv) => {
                        // 1. Text Search Filter Composed
                        if (timelineSearch.trim()) {
                          const q = timelineSearch.toLowerCase();
                          const matchesText = (conv.transcript && conv.transcript.toLowerCase().includes(q)) ||
                                              (conv.summary && conv.summary.toLowerCase().includes(q));
                          if (!matchesText) return false;
                        }
                        // 2. Metric Filter Composed
                        if (timelineFilterMode === 'has-summary') {
                          return !!conv.summary;
                        }
                        if (timelineFilterMode === 'has-memories') {
                          return memories.some((m) => m.metadata?.conversationId === conv.id);
                        }
                        if (timelineFilterMode === 'recent') {
                          return new Date(conv.createdAt) >= calendarWindowStart;
                        }
                        return true;
                      });

                      const today: Conversation[] = [];
                      const yesterday: Conversation[] = [];
                      const earlier: Conversation[] = [];

                      // Sort newest -> oldest
                      const sorted = [...filtered].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

                      sorted.forEach((c) => {
                        const cDate = new Date(c.createdAt);
                        if (cDate >= startOfToday) {
                          today.push(c);
                        } else if (cDate >= startOfYesterday) {
                          yesterday.push(c);
                        } else {
                          earlier.push(c);
                        }
                      });

                      const renderItem = (c: Conversation) => {
                        const isSelected = selectedConversation?.id === c.id;
                        const durationStr = c.durationSeconds ? `${c.durationSeconds}s` : null;
                        const hasExtractedMemories = memories.some((m) => m.metadata?.conversationId === c.id);

                        return (
                          <button
                            key={c.id}
                            onClick={() => handleSelectConversation(c.id)}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'flex-start',
                              textAlign: 'left',
                              padding: '0.45rem 0.55rem',
                              backgroundColor: isSelected ? 'rgba(99, 102, 241, 0.08)' : 'var(--background)',
                              border: `1px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                              borderRadius: 'var(--radius-sm)',
                              cursor: 'pointer',
                              width: '100%',
                              transition: 'all 0.15s ease',
                              gap: '0.2rem',
                            }}
                            type="button"
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: '0.75rem', fontWeight: 600, opacity: 0.9 }}>
                              <span style={{ color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginRight: '0.5rem' }}>
                                {c.transcript.slice(0, 32)}{c.transcript.length > 32 ? '...' : ''}
                              </span>
                              <span style={{ fontSize: '0.65rem', opacity: 0.6, whiteSpace: 'nowrap' }}>
                                {new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>

                            <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', fontSize: '0.65rem' }}>
                              {durationStr && (
                                <span className="badge" style={{ backgroundColor: 'rgba(99, 102, 241, 0.05)', color: 'var(--primary)', border: '1px solid rgba(99, 102, 241, 0.1)', padding: '0.05rem 0.2rem' }}>
                                  ⏱️ {durationStr}
                                </span>
                              )}
                              {c.summary && (
                                <span className="badge" style={{ backgroundColor: 'rgba(16, 185, 129, 0.05)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.1)', padding: '0.05rem 0.2rem' }}>
                                  📝 Has Summary
                                </span>
                              )}
                              {hasExtractedMemories && (
                                <span className="badge" style={{ backgroundColor: 'rgba(245, 158, 11, 0.05)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.1)', padding: '0.05rem 0.2rem' }}>
                                  🧠 Memories Available
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      };

                      if (loadingConversations && conversations.length === 0) {
                        return (
                          <div style={{ fontSize: '0.75rem', opacity: 0.6, padding: '1rem 0', textAlign: 'center' }}>
                            {renderSpinner()} Loading timeline...
                          </div>
                        );
                      }

                      if (filtered.length === 0) {
                        return (
                          <div style={{ fontSize: '0.75rem', opacity: 0.6, padding: '1rem 0', textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)' }}>
                            No matching timeline conversations found.
                          </div>
                        );
                      }

                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', maxHeight: '200px', overflowY: 'auto', paddingRight: '0.15rem' }}>
                          {today.length > 0 && (
                            <div>
                              <div style={{ fontSize: '0.65rem', fontWeight: 'bold', textTransform: 'uppercase', opacity: 0.5, letterSpacing: '0.05em', marginBottom: '0.25rem' }}>
                                Today
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                {today.map(renderItem)}
                              </div>
                            </div>
                          )}

                          {yesterday.length > 0 && (
                            <div>
                              <div style={{ fontSize: '0.65rem', fontWeight: 'bold', textTransform: 'uppercase', opacity: 0.5, letterSpacing: '0.05em', marginBottom: '0.25rem', marginTop: '0.4rem' }}>
                                Yesterday
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                {yesterday.map(renderItem)}
                              </div>
                            </div>
                          )}

                          {earlier.length > 0 && (
                            <div>
                              <div style={{ fontSize: '0.65rem', fontWeight: 'bold', textTransform: 'uppercase', opacity: 0.5, letterSpacing: '0.05em', marginBottom: '0.25rem', marginTop: '0.4rem' }}>
                                Earlier
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                {earlier.map(renderItem)}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
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
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '0.75rem' }}>
                          <h4 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--primary)', margin: 0 }}>
                            Grounded AI Response
                          </h4>
                          {/* Grounding Status badge */}
                          {(() => {
                            const status = getGroundingStatus(responseResult.usedMemories, responseResult.usedConversations);
                            return (
                              <span style={{
                                fontSize: '0.65rem',
                                fontWeight: 600,
                                color: status.color,
                                backgroundColor: status.bgColor,
                                border: `1px solid ${status.borderColor}`,
                                padding: '0.15rem 0.4rem',
                                borderRadius: '12px'
                              }}>
                                {status.label}
                              </span>
                            );
                          })()}
                        </div>
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

                      <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--primary)', display: 'block', marginBottom: '0.4rem' }}>
                          📚 Sources Used ({responseResult.contextTokenCount || 0} tokens):
                        </span>
                        
                        {(!responseResult.usedMemories || responseResult.usedMemories.length === 0) &&
                         (!responseResult.usedConversations || responseResult.usedConversations.length === 0) ? (
                          <div style={{ padding: '0.75rem', textAlign: 'center', opacity: 0.6, border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', color: 'var(--text)' }}>
                            No relevant memory found
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                            {/* Persistent Memories */}
                            {responseResult.usedMemories && responseResult.usedMemories.map((used, idx) => {
                              const key = `tmem-${idx}`;
                              const isExpanded = !!expandedCitations[key];
                              return (
                                <div key={key} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)', overflow: 'hidden' }}>
                                  <button
                                    type="button"
                                    onClick={() => toggleCitation(key)}
                                    aria-expanded={isExpanded}
                                    aria-controls={`content-${key}`}
                                    style={{
                                      width: '100%',
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      padding: '0.4rem 0.6rem',
                                      backgroundColor: 'rgba(59, 130, 246, 0.03)',
                                      border: 'none',
                                      cursor: 'pointer',
                                      textAlign: 'left',
                                      fontSize: '0.75rem',
                                      fontWeight: 600,
                                      color: '#3b82f6',
                                    }}
                                  >
                                    <span>🧠 Persistent Memory ({used.type})</span>
                                    <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>
                                      {isExpanded ? '▼' : '▶'}
                                    </span>
                                  </button>
                                  {isExpanded && (
                                    <div id={`content-${key}`} style={{ padding: '0.5rem 0.6rem', borderTop: '1px solid var(--border)', fontSize: '0.75rem' }}>
                                      <div style={{ fontStyle: 'italic', color: 'var(--text)', marginBottom: '0.35rem' }}>
                                        &ldquo;{used.content}&rdquo;
                                      </div>
                                      <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.65rem', opacity: 0.7 }}>
                                        <span>Confidence: <strong>{((used.confidence || 0.9) * 100).toFixed(0)}%</strong></span>
                                        <span>Lifecycle: <strong style={{ textTransform: 'capitalize' }}>{used.lifecycleState || 'stable'}</strong></span>
                                      </div>
                                      {used.conversationId && used.sourceType === 'conversation' && used.sourceTimestamp && (
                                        <div style={{ marginTop: '0.4rem', borderTop: '1px dashed var(--border)', paddingTop: '0.4rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                          <span style={{ fontSize: '0.65rem', opacity: 0.8 }}>
                                            From conversation · {formatProvenanceDate(used.sourceTimestamp)}
                                          </span>
                                          <button
                                            type="button"
                                            onClick={() => handleSelectConversation(used.conversationId!)}
                                            style={{
                                              fontSize: '0.65rem',
                                              color: 'var(--primary)',
                                              background: 'none',
                                              border: 'none',
                                              cursor: 'pointer',
                                              padding: 0,
                                              textDecoration: 'underline',
                                              fontWeight: 600,
                                            }}
                                          >
                                            View Source Conversation
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}

                            {/* Past Conversations */}
                            {responseResult.usedConversations && responseResult.usedConversations.map((used, idx) => {
                              const key = `tconv-${idx}`;
                              const isExpanded = !!expandedCitations[key];
                              return (
                                <div key={key} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)', overflow: 'hidden' }}>
                                  <button
                                    type="button"
                                    onClick={() => toggleCitation(key)}
                                    aria-expanded={isExpanded}
                                    aria-controls={`content-${key}`}
                                    style={{
                                      width: '100%',
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      padding: '0.4rem 0.6rem',
                                      backgroundColor: 'rgba(16, 185, 129, 0.03)',
                                      border: 'none',
                                      cursor: 'pointer',
                                      textAlign: 'left',
                                      fontSize: '0.75rem',
                                      fontWeight: 600,
                                      color: '#10b981',
                                    }}
                                  >
                                    <span>💬 Past Conversation ({new Date(used.createdAt).toLocaleDateString()})</span>
                                    <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>
                                      {isExpanded ? '▼' : '▶'}
                                    </span>
                                  </button>
                                  {isExpanded && (
                                    <div id={`content-${key}`} style={{ padding: '0.5rem 0.6rem', borderTop: '1px solid var(--border)', fontSize: '0.75rem' }}>
                                      <div style={{ fontStyle: 'italic', color: 'var(--text)', marginBottom: '0.35rem' }}>
                                        &ldquo;{used.matchedSnippet || used.text}&rdquo;
                                      </div>
                                      <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.65rem', opacity: 0.7 }}>
                                        {used.similarity !== undefined && used.similarity !== null ? (
                                          <span>Similarity: <strong>{(used.similarity * 100).toFixed(0)}%</strong></span>
                                        ) : (
                                          <span style={{ color: 'var(--primary)' }}>Relevance: Keyword Match</span>
                                        )}
                                        <span>Date/Time: <strong>{new Date(used.createdAt).toLocaleDateString()} {new Date(used.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong></span>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
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
                            {contextResult.items.map((item: { id: string; type: string; content: string; reason?: string }) => (
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
                    <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)' }}>
                      <span style={{ opacity: 0.6, display: 'block' }}>Relevance</span>
                      <strong>{((evalSummary.relevance ?? 1) * 100).toFixed(0)}%</strong>
                    </div>
                    <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)' }}>
                      <span style={{ opacity: 0.6, display: 'block' }}>Faithfulness</span>
                      <strong>{((evalSummary.faithfulness ?? 1) * 100).toFixed(0)}%</strong>
                    </div>
                    <div style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)' }}>
                      <span style={{ opacity: 0.6, display: 'block' }}>Citations</span>
                      <strong>{((evalSummary.citationCorrectness ?? 1) * 100).toFixed(0)}%</strong>
                    </div>
                  </div>

                  {/* Pipeline Performance Summary (Session Only) */}
                  {(() => {
                    const successCount = evalResults.filter(r => r.passed).length;
                    const failureCount = evalResults.length - successCount;

                    const totalLatencies: number[] = [];
                    const retrievalLatencies: number[] = [];
                    const generationLatencies: number[] = [];
                    const guardrailLatencies: number[] = [];

                    let cacheHits = 0;
                    let cacheSamples = 0;
                    let fallbackHits = 0;
                    let fallbackSamples = 0;
                    let retryCount = 0;
                    let timeoutCount = 0;

                    for (const r of evalResults) {
                      if (r.latencyMs !== undefined) {
                        totalLatencies.push(r.latencyMs);
                      }
                      const timings = r.diagnostics?.timings;
                      if (timings) {
                        const retrievalTime = (timings.prepLatencyMs || 0) + (timings.memoryRetrievalLatencyMs || 0) + (timings.conversationRetrievalLatencyMs || 0);
                        retrievalLatencies.push(retrievalTime);
                        
                        if (timings.generationLatencyMs !== undefined) {
                          generationLatencies.push(timings.generationLatencyMs);
                        }
                        if (timings.guardrailLatencyMs !== undefined) {
                          guardrailLatencies.push(timings.guardrailLatencyMs);
                        }
                      }
                      // Health Diagnostics
                      const health = r.diagnostics?.health;
                      if (health) {
                        if (health.memoryCacheHit !== undefined) {
                          cacheSamples++;
                          if (health.memoryCacheHit) cacheHits++;
                        }
                        if (health.conversationCacheHit !== undefined) {
                          cacheSamples++;
                          if (health.conversationCacheHit) cacheHits++;
                        }
                        if (health.memoryFallbackUsed !== undefined) {
                          fallbackSamples++;
                          if (health.memoryFallbackUsed) fallbackHits++;
                        }
                        if (health.conversationFallbackUsed !== undefined) {
                          fallbackSamples++;
                          if (health.conversationFallbackUsed) fallbackHits++;
                        }
                        if (health.retryOccurred) {
                          retryCount++;
                        }
                        if (health.timeoutOccurred) {
                          timeoutCount++;
                        }
                      }
                    }

                    const cacheHitRate = cacheSamples > 0 ? (cacheHits / cacheSamples) : 0;
                    const fallbackRate = fallbackSamples > 0 ? (fallbackHits / fallbackSamples) : 0;
                    const retryRate = evalResults.length > 0 ? (retryCount / evalResults.length) : 0;
                    const successRate = evalResults.length > 0 ? (successCount / evalResults.length) : 0;

                    const avg = (arr: number[]) => arr.length > 0 ? `${Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)} ms` : '—';
                    const p95 = (arr: number[]) => {
                      if (arr.length === 0) return '—';
                      const sorted = [...arr].sort((a, b) => a - b);
                      const idx = Math.ceil(0.95 * sorted.length) - 1;
                      return `${sorted[Math.max(0, idx)]} ms`;
                    };

                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                        {/* Timings Performance */}
                        <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem' }}>
                            <span style={{ fontSize: '1rem' }}>⚡</span>
                            <strong style={{ fontSize: '0.8rem', color: 'var(--primary)' }}>Evaluation Benchmark Performance Results (Session Only)</strong>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem', fontSize: '0.7rem' }}>
                            <div style={{ padding: '0.4rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' }}>
                              <span style={{ opacity: 0.6, display: 'block' }}>Total Latency</span>
                              Avg: <strong>{avg(totalLatencies)}</strong> | p95: <strong>{p95(totalLatencies)}</strong>
                            </div>
                            <div style={{ padding: '0.4rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' }}>
                              <span style={{ opacity: 0.6, display: 'block' }}>Retrieval Latency</span>
                              Avg: <strong>{avg(retrievalLatencies)}</strong> | p95: <strong>{p95(retrievalLatencies)}</strong>
                            </div>
                            <div style={{ padding: '0.4rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' }}>
                              <span style={{ opacity: 0.6, display: 'block' }}>Generation Latency</span>
                              Avg: <strong>{avg(generationLatencies)}</strong> | p95: <strong>{p95(generationLatencies)}</strong>
                            </div>
                            <div style={{ padding: '0.4rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' }}>
                              <span style={{ opacity: 0.6, display: 'block' }}>Guardrail Latency</span>
                              Avg: <strong>{avg(guardrailLatencies)}</strong> | p95: <strong>{p95(guardrailLatencies)}</strong>
                            </div>
                            <div style={{ padding: '0.4rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)', gridColumn: 'span 1' }}>
                              <span style={{ opacity: 0.6, display: 'block' }}>Success / Failure Count</span>
                              Passed: <strong style={{ color: 'var(--success)' }}>{successCount}</strong> | Failed: <strong style={{ color: 'var(--error)' }}>{failureCount}</strong>
                            </div>
                          </div>
                        </div>

                        {/* Pipeline Health */}
                        <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem' }}>
                            <span style={{ fontSize: '1rem' }}>🏥</span>
                            <strong style={{ fontSize: '0.8rem', color: 'var(--primary)' }}>Pipeline Health Dashboard (Session Only)</strong>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.75rem', fontSize: '0.7rem' }}>
                            <div style={{ padding: '0.4rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' }}>
                              <span style={{ opacity: 0.6, display: 'block' }}>Success Rate</span>
                              <strong>{(successRate * 100).toFixed(0)}%</strong>
                            </div>
                            <div style={{ padding: '0.4rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' }}>
                              <span style={{ opacity: 0.6, display: 'block' }}>Cache Hit Rate</span>
                              <strong>{cacheSamples > 0 ? `${(cacheHitRate * 100).toFixed(0)}%` : '—'}</strong>
                            </div>
                            <div style={{ padding: '0.4rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' }}>
                              <span style={{ opacity: 0.6, display: 'block' }}>Fallback Rate</span>
                              <strong>{fallbackSamples > 0 ? `${(fallbackRate * 100).toFixed(0)}%` : '—'}</strong>
                            </div>
                            <div style={{ padding: '0.4rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' }}>
                              <span style={{ opacity: 0.6, display: 'block' }}>Retry Rate</span>
                              <strong>{(retryRate * 100).toFixed(0)}%</strong>
                            </div>
                            <div style={{ padding: '0.4rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' }}>
                              <span style={{ opacity: 0.6, display: 'block' }}>Timeout Count</span>
                              <strong>{timeoutCount}</strong>
                            </div>
                          </div>
                        </div>

                        {/* Regression Audit Check */}
                        {evalSummary?.regression && (
                          <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <span style={{ fontSize: '1rem' }}>📈</span>
                                <strong style={{ fontSize: '0.8rem', color: 'var(--primary)' }}>Regression Audit Check Summary</strong>
                              </div>
                              <button
                                onClick={handleSetBaseline}
                                style={{
                                  padding: '0.2rem 0.5rem',
                                  fontSize: '0.65rem',
                                  backgroundColor: 'var(--surface)',
                                  color: 'var(--text)',
                                  border: '1px solid var(--border)',
                                  borderRadius: 'var(--radius-xs)',
                                  cursor: 'pointer',
                                }}
                              >
                                🎯 Set Current Run as Baseline
                              </button>
                            </div>

                            {!evalSummary.regression.baselineAvailable ? (
                              <div style={{ padding: '0.5rem', fontSize: '0.75rem', opacity: 0.8, backgroundColor: 'rgba(0,0,0,0.15)', borderRadius: 'var(--radius-xs)', border: '1px dashed var(--border)' }}>
                                ℹ️ No baseline available yet. This run has been configured as the session baseline. Later runs will compare against it.
                              </div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.4rem 0.5rem', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', border: '1px solid var(--border)', fontSize: '0.75rem' }}>
                                  <span>
                                    Baseline Timestamp/Label: <code>{baselineLabel || evalSummary.regression.baselineLabel || 'Unknown Baseline'}</code>
                                  </span>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontWeight: 600 }}>
                                    <span>Overall Status:</span>
                                    {evalSummary.regression.status === 'pass' && (
                                      <span style={{ color: 'var(--success)' }}>✓ PASS (No regressions detected)</span>
                                    )}
                                    {evalSummary.regression.status === 'warning' && (
                                      <span style={{ color: 'orange' }}>⚠ WARNING (Tolerable regressions detected)</span>
                                    )}
                                    {evalSummary.regression.status === 'fail' && (
                                      <span style={{ color: 'var(--error)' }}>✗ FAIL (Critical quality regressions detected)</span>
                                    )}
                                  </div>
                                </div>

                                {evalSummary.regression.failedThresholds && evalSummary.regression.failedThresholds.length > 0 && (
                                  <div style={{ fontSize: '0.7rem', color: 'var(--error)', padding: '0.25rem 0.5rem', backgroundColor: 'rgba(179, 74, 60, 0.05)', borderRadius: 'var(--radius-xs)', border: '1px solid rgba(179, 74, 60, 0.15)' }}>
                                    ⚠️ Regressions exceeding tolerances: <strong>{evalSummary.regression.failedThresholds.join(', ')}</strong>
                                  </div>
                                )}

                                <div style={{ overflowX: 'auto' }}>
                                  <table style={{ width: '100%', fontSize: '0.7rem', textAlign: 'left', borderCollapse: 'collapse', marginTop: '0.25rem' }}>
                                    <thead>
                                      <tr style={{ borderBottom: '1px solid var(--border)', opacity: 0.6 }}>
                                        <th style={{ padding: '0.35rem' }}>Metric</th>
                                        <th style={{ padding: '0.35rem' }}>Current</th>
                                        <th style={{ padding: '0.35rem' }}>Baseline</th>
                                        <th style={{ padding: '0.35rem' }}>Delta (Abs)</th>
                                        <th style={{ padding: '0.35rem' }}>Delta (%)</th>
                                        <th style={{ padding: '0.35rem' }}>Regression Status</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {Object.entries(evalSummary.regression.deltas).map(([metric, delta]) => {
                                        const valCurrent = (evalSummary as unknown as Record<string, number | undefined>)[metric];
                                        
                                        const formatMetric = (metricName: string, val: number) => {
                                          if (metricName === 'averageLatency') return `${Math.round(val)} ms`;
                                          if (metricName === 'timeoutCount') return `${val}`;
                                          return `${(val * 100).toFixed(0)}%`;
                                        };

                                        const displayCurrent = valCurrent !== undefined ? formatMetric(metric, valCurrent) : 'N/A';
                                        let displayBaseline = 'N/A';
                                        
                                        if (delta.type !== 'notComparable' && delta.absolute !== undefined && valCurrent !== undefined) {
                                          const valBaseline = valCurrent - delta.absolute;
                                          displayBaseline = formatMetric(metric, valBaseline);
                                        }

                                        let deltaTypeLabel = '—';
                                        let deltaTypeColor = 'var(--text)';
                                        if (delta.type === 'improvement') {
                                          deltaTypeLabel = '▲ Improvement';
                                          deltaTypeColor = 'var(--success)';
                                        } else if (delta.type === 'regression') {
                                          deltaTypeLabel = '▼ Regression';
                                          deltaTypeColor = 'var(--error)';
                                        } else if (delta.type === 'unchanged') {
                                          deltaTypeLabel = '— Unchanged';
                                          deltaTypeColor = 'var(--text)';
                                        } else if (delta.type === 'notComparable') {
                                          deltaTypeLabel = 'N/A Not Comparable';
                                          deltaTypeColor = 'var(--text)';
                                        }

                                        const formatDeltaAbsolute = (metricName: string, val: number) => {
                                          const sign = val > 0 ? '+' : '';
                                          if (metricName === 'averageLatency') return `${sign}${Math.round(val)} ms`;
                                          if (metricName === 'timeoutCount') return `${sign}${val}`;
                                          return `${sign}${(val * 100).toFixed(0)}%`;
                                        };

                                        const absoluteText = delta.absolute !== undefined ? formatDeltaAbsolute(metric, delta.absolute) : 'N/A';
                                        const percentageText = delta.percentage !== undefined ? `${delta.percentage > 0 ? '+' : ''}${delta.percentage.toFixed(0)}%` : 'N/A';

                                        return (
                                          <tr key={metric} style={{ borderBottom: '1px solid var(--border)', opacity: 0.9 }}>
                                            <td style={{ padding: '0.35rem', fontWeight: 600 }}>{metric}</td>
                                            <td style={{ padding: '0.35rem' }}>{displayCurrent}</td>
                                            <td style={{ padding: '0.35rem' }}>{displayBaseline}</td>
                                            <td style={{ padding: '0.35rem', color: deltaTypeColor }}>{absoluteText}</td>
                                            <td style={{ padding: '0.35rem', color: deltaTypeColor }}>{percentageText}</td>
                                            <td style={{ padding: '0.35rem', color: deltaTypeColor, fontWeight: 600 }}>{deltaTypeLabel}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '250px', overflowY: 'auto' }}>
                    {evalResults.map((result) => (
                      <div key={result.scenarioId} style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)', fontSize: '0.75rem' }}>
                        <div
                          style={{ padding: '0.4rem 0.6rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                          onClick={() => setExpandedScenarioId(expandedScenarioId === result.scenarioId ? null : result.scenarioId)}
                        >
                          <div>
                            <strong>{result.name}</strong>
                            <div style={{ opacity: 0.6, fontSize: '0.65rem', marginTop: '0.1rem' }}>
                              Recall: {(result.metrics.retrievalRecall * 100).toFixed(0)}% | Grounding: {((result.metrics.faithfulness ?? 1) * 100).toFixed(0)}% | Citation: {((result.metrics.citationCorrectness ?? 1) * 100).toFixed(0)}% | Latency: {result.latencyMs} ms
                            </div>
                          </div>
                          <span style={{ color: result.passed ? 'var(--success)' : 'var(--error)', fontWeight: 600 }}>
                            {result.passed ? 'PASSED' : 'FAILED'}
                          </span>
                        </div>

                        {expandedScenarioId === result.scenarioId && result.diagnostics?.timings && (
                          <div style={{ padding: '0.5rem 0.6rem', borderTop: '1px solid var(--border)', backgroundColor: 'rgba(0,0,0,0.15)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.4rem', fontSize: '0.7rem' }}>
                            <div>Prep Latency: <strong>{result.diagnostics.timings.prepLatencyMs} ms</strong></div>
                            <div>Memory Retrieval: <strong>{result.diagnostics.timings.memoryRetrievalLatencyMs} ms</strong></div>
                            <div>Conversation Retrieval: <strong>{result.diagnostics.timings.conversationRetrievalLatencyMs} ms</strong></div>
                            <div>Assembly Latency: <strong>{result.diagnostics.timings.assemblyLatencyMs} ms</strong></div>
                            <div>Generation Latency: <strong>{result.diagnostics.timings.generationLatencyMs} ms</strong></div>
                            <div>Guardrail Latency: <strong>{result.diagnostics.timings.guardrailLatencyMs} ms</strong></div>
                            <div>Total Latency: <strong>{result.diagnostics.timings.totalLatencyMs} ms</strong></div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Evaluation Insights & Trend Analysis */}
              {evalInsights && (
                <div>
                  <hr style={{ border: '0', borderTop: '1px solid var(--border)', margin: '1.5rem 0 1.25rem 0' }} />
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem' }}>
                    <span style={{ fontSize: '1.1rem' }}>💡</span>
                    <h4 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--primary)', margin: 0 }}>Evaluation Insights & Trend Analysis</h4>
                  </div>

                  {evalInsights.status === 'insufficient' ? (
                    <div style={{ padding: '1rem', textAlign: 'center', fontSize: '0.75rem', opacity: 0.8, border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'rgba(0,0,0,0.1)' }}>
                      ℹ️ Insufficient history: run at least 2 benchmarks to generate insights and trend analysis.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.4rem 0.5rem', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', border: '1px solid var(--border)', fontSize: '0.75rem' }}>
                        <span>
                          Comparing Latest: <code>{evalInsights.latestTimestamp ? new Date(evalInsights.latestTimestamp).toLocaleTimeString() : 'Unknown'}</code> vs Previous: <code>{evalInsights.previousTimestamp ? new Date(evalInsights.previousTimestamp).toLocaleTimeString() : 'Unknown'}</code>
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontWeight: 600 }}>
                          <span>Overall Trend:</span>
                          {evalInsights.status === 'improving' && (
                            <span style={{ color: 'var(--success)' }}>📈 Improving (Positive trends outweigh regressions)</span>
                          )}
                          {evalInsights.status === 'degrading' && (
                            <span style={{ color: 'var(--error)' }}>📉 Degrading (Regressive trends outweigh improvements)</span>
                          )}
                          {evalInsights.status === 'stable' && (
                            <span style={{ color: 'var(--text)', opacity: 0.8 }}>📊 Stable (No significant overall shifts)</span>
                          )}
                        </div>
                      </div>

                      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                        <table style={{ width: '100%', fontSize: '0.7rem', textAlign: 'left', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ backgroundColor: 'var(--surface)', borderBottom: '1px solid var(--border)', opacity: 0.8 }}>
                              <th style={{ padding: '0.4rem 0.5rem' }}>Metric</th>
                              <th style={{ padding: '0.4rem 0.5rem' }}>Delta (Abs)</th>
                              <th style={{ padding: '0.4rem 0.5rem' }}>Trend Direction</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(evalInsights.trends).map(([metric, trend]) => {
                              let directionText = '— Stable';
                              let directionColor = 'var(--text)';

                              if (trend.type === 'improving') {
                                directionText = '▲ Improving';
                                directionColor = 'var(--success)';
                              } else if (trend.type === 'degrading') {
                                directionText = '▼ Degrading';
                                directionColor = 'var(--error)';
                              } else if (trend.type === 'notComparable') {
                                directionText = 'N/A Not Comparable';
                                directionColor = 'var(--text)';
                              }

                              const formatDeltaVal = (metricName: string, val: number | undefined) => {
                                if (val === undefined) return 'N/A';
                                const sign = val > 0 ? '+' : '';
                                if (metricName === 'averageLatency') return `${sign}${Math.round(val)} ms`;
                                if (metricName === 'timeoutCount') return `${sign}${val}`;
                                return `${sign}${(val * 100).toFixed(0)}%`;
                              };

                              const deltaDisplay = trend.delta !== undefined ? formatDeltaVal(metric, trend.delta) : 'N/A';

                              return (
                                <tr key={metric} style={{ borderBottom: '1px solid var(--border)' }}>
                                  <td style={{ padding: '0.4rem 0.5rem', fontWeight: 600 }}>{metric}</td>
                                  <td style={{ padding: '0.4rem 0.5rem', color: directionColor }}>{deltaDisplay}</td>
                                  <td style={{ padding: '0.4rem 0.5rem', color: directionColor, fontWeight: 600 }}>{directionText}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Evaluation Recommendations Panel */}
              {historyRuns.length >= 2 && evalRecommendations.length > 0 && (
                <div>
                  <hr style={{ border: '0', borderTop: '1px solid var(--border)', margin: '1.5rem 0 1.25rem 0' }} />
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem' }}>
                    <span style={{ fontSize: '1.1rem' }}>🛠️</span>
                    <h4 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--primary)', margin: 0 }}>Adaptive Recommendations (Advisory Only)</h4>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {evalRecommendations.map((rec) => {
                      let severityBadgeColor = 'var(--text)';
                      let severityBadgeBg = 'rgba(255, 255, 255, 0.05)';
                      let severityLabel = 'INFO';
                      if (rec.severity === 'critical') {
                        severityBadgeColor = 'var(--error)';
                        severityBadgeBg = 'rgba(179, 74, 60, 0.15)';
                        severityLabel = 'CRITICAL';
                      } else if (rec.severity === 'warning') {
                        severityBadgeColor = 'orange';
                        severityBadgeBg = 'rgba(255, 165, 0, 0.1)';
                        severityLabel = 'WARNING';
                      }

                      return (
                        <div key={rec.id} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--surface)' }}>
                          <span style={{ 
                            fontSize: '0.65rem', 
                            fontWeight: 'bold', 
                            padding: '0.15rem 0.35rem', 
                            borderRadius: 'var(--radius-xs)', 
                            color: severityBadgeColor, 
                            backgroundColor: severityBadgeBg,
                            border: `1px solid ${severityBadgeColor}`,
                            textTransform: 'uppercase',
                            minWidth: '70px',
                            textAlign: 'center'
                          }}>
                            {severityLabel}
                          </span>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.7rem' }}>
                            <div>
                              Metric: <strong>{rec.metric}</strong> (Value: <code>{rec.value}</code>
                              {rec.trend && (
                                <span style={{ marginLeft: '0.5rem', opacity: 0.7 }}>
                                  Trend: <code>{rec.trend}</code>
                                </span>
                              )}
                              )
                            </div>
                            <div style={{ opacity: 0.9 }}>
                              Action: <strong>{rec.action}</strong>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Evaluation Run History & Compare Panel */}
              <hr style={{ border: '0', borderTop: '1px solid var(--border)', margin: '1.5rem 0 1.25rem 0' }} />
              
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span style={{ fontSize: '1.1rem' }}>📜</span>
                  <h4 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--primary)', margin: 0 }}>Evaluation Run History</h4>
                </div>
                {historyRuns.length > 0 && (
                  <button
                    onClick={handleClearHistory}
                    style={{
                      padding: '0.2rem 0.5rem',
                      fontSize: '0.65rem',
                      backgroundColor: 'rgba(179, 74, 60, 0.1)',
                      color: 'var(--error)',
                      border: '1px solid rgba(179, 74, 60, 0.2)',
                      borderRadius: 'var(--radius-xs)',
                      cursor: 'pointer',
                    }}
                  >
                    🗑️ Clear History
                  </button>
                )}
              </div>

              {historyRuns.length === 0 ? (
                <div style={{ padding: '1rem', textAlign: 'center', fontSize: '0.75rem', opacity: 0.6, border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  No evaluation runs in history yet. Execute scenario benchmarks to populate.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'center', padding: '0.75rem', backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                      <span>Compare Baseline Run:</span>
                      <select
                        value={selectedBaseRunId}
                        onChange={(e) => setSelectedBaseRunId(e.target.value)}
                        style={{ padding: '0.15rem 0.4rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', color: 'var(--text)', fontSize: '0.7rem' }}
                      >
                        <option value="">-- Select Run --</option>
                        {historyRuns.map((r) => (
                          <option key={r.id} value={r.id}>
                            {new Date(r.timestamp).toLocaleTimeString()} ({r.id.substring(4, 9)}) - Rec: {(r.summary.retrievalRecall * 100).toFixed(0)}%
                          </option>
                        ))}
                      </select>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                      <span>Against Target Run:</span>
                      <select
                        value={selectedTargetRunId}
                        onChange={(e) => setSelectedTargetRunId(e.target.value)}
                        style={{ padding: '0.15rem 0.4rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', color: 'var(--text)', fontSize: '0.7rem' }}
                      >
                        <option value="">-- Select Run --</option>
                        {historyRuns.map((r) => (
                          <option key={r.id} value={r.id}>
                            {new Date(r.timestamp).toLocaleTimeString()} ({r.id.substring(4, 9)}) - Rec: {(r.summary.retrievalRecall * 100).toFixed(0)}%
                          </option>
                        ))}
                      </select>
                    </div>

                    <button
                      onClick={handleCompareHistoryRuns}
                      disabled={!selectedBaseRunId || !selectedTargetRunId}
                      style={{
                        padding: '0.2rem 0.6rem',
                        fontSize: '0.7rem',
                        backgroundColor: (selectedBaseRunId && selectedTargetRunId) ? 'var(--primary)' : 'var(--surface)',
                        color: (selectedBaseRunId && selectedTargetRunId) ? 'black' : 'var(--text)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-xs)',
                        cursor: (selectedBaseRunId && selectedTargetRunId) ? 'pointer' : 'default',
                        opacity: (selectedBaseRunId && selectedTargetRunId) ? 1 : 0.5,
                      }}
                    >
                      ⚖️ Compare Selected Runs
                    </button>
                  </div>

                  <div style={{ overflowX: 'auto', maxHeight: '200px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    <table style={{ width: '100%', fontSize: '0.7rem', textAlign: 'left', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ backgroundColor: 'var(--surface)', borderBottom: '1px solid var(--border)', opacity: 0.8 }}>
                          <th style={{ padding: '0.4rem 0.5rem' }}>Timestamp</th>
                          <th style={{ padding: '0.4rem 0.5rem' }}>Run ID</th>
                          <th style={{ padding: '0.4rem 0.5rem' }}>Success (P/F)</th>
                          <th style={{ padding: '0.4rem 0.5rem' }}>Recall / Prec</th>
                          <th style={{ padding: '0.4rem 0.5rem' }}>Relevance / Faith</th>
                          <th style={{ padding: '0.4rem 0.5rem' }}>Latency</th>
                          <th style={{ padding: '0.4rem 0.5rem', textAlign: 'center' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {historyRuns.map((r) => (
                          <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '0.4rem 0.5rem' }}>{new Date(r.timestamp).toLocaleTimeString()} ({new Date(r.timestamp).toLocaleDateString()})</td>
                            <td style={{ padding: '0.4rem 0.5rem' }}><code>{r.id.substring(4, 9)}</code></td>
                            <td style={{ padding: '0.4rem 0.5rem' }}>
                              <span style={{ color: 'var(--success)' }}>{r.summary.passed}</span> / <span style={{ color: 'var(--error)' }}>{r.summary.failed}</span>
                            </td>
                            <td style={{ padding: '0.4rem 0.5rem' }}>
                              {(r.summary.retrievalRecall * 100).toFixed(0)}% / {(r.summary.contextPrecision * 100).toFixed(0)}%
                            </td>
                            <td style={{ padding: '0.4rem 0.5rem' }}>
                              {(r.summary.relevance * 100).toFixed(0)}% / {(r.summary.faithfulness * 100).toFixed(0)}%
                            </td>
                            <td style={{ padding: '0.4rem 0.5rem' }}>{Math.round(r.summary.averageLatency)} ms</td>
                            <td style={{ padding: '0.4rem 0.5rem', textAlign: 'center' }}>
                              <button
                                onClick={() => handleDeleteHistoryRun(r.id)}
                                style={{
                                  padding: '0.1rem 0.3rem',
                                  fontSize: '0.65rem',
                                  backgroundColor: 'rgba(179, 74, 60, 0.1)',
                                  color: 'var(--error)',
                                  border: '1px solid rgba(179, 74, 60, 0.15)',
                                  borderRadius: 'var(--radius-xs)',
                                  cursor: 'pointer',
                                }}
                              >
                                🗑️
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Run Comparison Detail */}
              {runsComparison && (
                <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ fontSize: '1rem' }}>⚖️</span>
                      <strong style={{ fontSize: '0.8rem', color: 'var(--primary)' }}>Run Comparison Results</strong>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontWeight: 600, fontSize: '0.75rem' }}>
                      <span>Comparison Status:</span>
                      {runsComparison.status === 'pass' && (
                        <span style={{ color: 'var(--success)' }}>✓ PASS (No regressions detected)</span>
                      )}
                      {runsComparison.status === 'warning' && (
                        <span style={{ color: 'orange' }}>⚠ WARNING (Tolerable regressions detected)</span>
                      )}
                      {runsComparison.status === 'fail' && (
                        <span style={{ color: 'var(--error)' }}>✗ FAIL (Critical quality regressions detected)</span>
                      )}
                    </div>
                  </div>

                  {runsComparison.failedThresholds && runsComparison.failedThresholds.length > 0 && (
                    <div style={{ fontSize: '0.7rem', color: 'var(--error)', padding: '0.25rem 0.5rem', backgroundColor: 'rgba(179, 74, 60, 0.05)', borderRadius: 'var(--radius-xs)', border: '1px solid rgba(179, 74, 60, 0.15)', marginBottom: '0.5rem' }}>
                      ⚠️ Regressions exceeding tolerances: <strong>{runsComparison.failedThresholds.join(', ')}</strong>
                    </div>
                  )}

                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', fontSize: '0.7rem', textAlign: 'left', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)', opacity: 0.6 }}>
                          <th style={{ padding: '0.35rem' }}>Metric</th>
                          <th style={{ padding: '0.35rem' }}>Target Run</th>
                          <th style={{ padding: '0.35rem' }}>Base Run</th>
                          <th style={{ padding: '0.35rem' }}>Delta (Abs)</th>
                          <th style={{ padding: '0.35rem' }}>Delta (%)</th>
                          <th style={{ padding: '0.35rem' }}>Regression Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(runsComparison.deltas).map(([metric, delta]) => {
                          const baseRecord = historyRuns.find((r) => r.id === selectedBaseRunId);
                          const targetRecord = historyRuns.find((r) => r.id === selectedTargetRunId);
                          
                          const valBase = baseRecord ? (baseRecord.summary as unknown as Record<string, number | undefined>)[metric] : undefined;
                          const valTarget = targetRecord ? (targetRecord.summary as unknown as Record<string, number | undefined>)[metric] : undefined;

                          const formatMetric = (metricName: string, val: number | undefined) => {
                            if (val === undefined) return 'N/A';
                            if (metricName === 'averageLatency') return `${Math.round(val)} ms`;
                            if (metricName === 'timeoutCount') return `${val}`;
                            return `${(val * 100).toFixed(0)}%`;
                          };

                          let deltaTypeLabel = '—';
                          let deltaTypeColor = 'var(--text)';
                          if (delta.type === 'improvement') {
                            deltaTypeLabel = '▲ Improvement';
                            deltaTypeColor = 'var(--success)';
                          } else if (delta.type === 'regression') {
                            deltaTypeLabel = '▼ Regression';
                            deltaTypeColor = 'var(--error)';
                          } else if (delta.type === 'unchanged') {
                            deltaTypeLabel = '— Unchanged';
                            deltaTypeColor = 'var(--text)';
                          } else if (delta.type === 'notComparable') {
                            deltaTypeLabel = 'N/A Not Comparable';
                            deltaTypeColor = 'var(--text)';
                          }

                          const formatDeltaAbsolute = (metricName: string, val: number | undefined) => {
                            if (val === undefined) return 'N/A';
                            const sign = val > 0 ? '+' : '';
                            if (metricName === 'averageLatency') return `${sign}${Math.round(val)} ms`;
                            if (metricName === 'timeoutCount') return `${sign}${val}`;
                            return `${sign}${(val * 100).toFixed(0)}%`;
                          };

                          const absoluteText = delta.absolute !== undefined ? formatDeltaAbsolute(metric, delta.absolute) : 'N/A';
                          const percentageText = delta.percentage !== undefined ? `${delta.percentage > 0 ? '+' : ''}${delta.percentage.toFixed(0)}%` : 'N/A';

                          return (
                            <tr key={metric} style={{ borderBottom: '1px solid var(--border)', opacity: 0.9 }}>
                              <td style={{ padding: '0.35rem', fontWeight: 600 }}>{metric}</td>
                              <td style={{ padding: '0.35rem' }}>{formatMetric(metric, valTarget)}</td>
                              <td style={{ padding: '0.35rem' }}>{formatMetric(metric, valBase)}</td>
                              <td style={{ padding: '0.35rem', color: deltaTypeColor }}>{absoluteText}</td>
                              <td style={{ padding: '0.35rem', color: deltaTypeColor }}>{percentageText}</td>
                              <td style={{ padding: '0.35rem', color: deltaTypeColor, fontWeight: 600 }}>{deltaTypeLabel}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* A/B Evaluation Experimentation */}
            <div className="card" style={{ padding: '1.25rem', marginTop: '1.5rem' }}>
              <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600 }}>🧪 A/B Evaluation Experimentation</h3>
              <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1.25rem' }}>
                Compare two retrieval parameter configurations side-by-side under identical evaluation scenarios. 
                <strong style={{ color: 'var(--primary)', marginLeft: '0.25rem' }}>Developer / Advisory Only</strong>.
              </p>

              {/* Configurations input side-by-side */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '1.25rem' }}>
                {/* Control Parameter Inputs */}
                <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(255,255,255,0.02)' }}>
                  <h4 style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--primary)', marginBottom: '0.75rem' }}>Control Configuration (A)</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.7rem' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <span>Semantic Weight (0.0 - 1.0):</span>
                      <input 
                        type="number" 
                        step="0.05" 
                        min="0" 
                        max="1"
                        value={controlSemanticWeight} 
                        onChange={(e) => setControlSemanticWeight(parseFloat(e.target.value) || 0)} 
                        disabled={experimentLoading}
                        style={{ padding: '0.25rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <span>Lexical Weight (0.0 - 1.0):</span>
                      <input 
                        type="number" 
                        step="0.05" 
                        min="0" 
                        max="1"
                        value={controlLexicalWeight} 
                        onChange={(e) => setControlLexicalWeight(parseFloat(e.target.value) || 0)} 
                        disabled={experimentLoading}
                        style={{ padding: '0.25rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <span>Min Similarity (0.0 - 1.0):</span>
                      <input 
                        type="number" 
                        step="0.05" 
                        min="0" 
                        max="1"
                        value={controlMinSim} 
                        onChange={(e) => setControlMinSim(parseFloat(e.target.value) || 0)} 
                        disabled={experimentLoading}
                        style={{ padding: '0.25rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <span>Max Conversation Snippets (1 - 100):</span>
                      <input 
                        type="number" 
                        min="1" 
                        max="100"
                        value={controlMaxConvSnippets} 
                        onChange={(e) => setControlMaxConvSnippets(parseInt(e.target.value) || 0)} 
                        disabled={experimentLoading}
                        style={{ padding: '0.25rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                      />
                    </label>
                  </div>
                </div>

                {/* Candidate Parameter Inputs */}
                <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(255,255,255,0.02)' }}>
                  <h4 style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--success)', marginBottom: '0.75rem' }}>Candidate Configuration (B)</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.7rem' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <span>Semantic Weight (0.0 - 1.0):</span>
                      <input 
                        type="number" 
                        step="0.05" 
                        min="0" 
                        max="1"
                        value={candidateSemanticWeight} 
                        onChange={(e) => setCandidateSemanticWeight(parseFloat(e.target.value) || 0)} 
                        disabled={experimentLoading}
                        style={{ padding: '0.25rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <span>Lexical Weight (0.0 - 1.0):</span>
                      <input 
                        type="number" 
                        step="0.05" 
                        min="0" 
                        max="1"
                        value={candidateLexicalWeight} 
                        onChange={(e) => setCandidateLexicalWeight(parseFloat(e.target.value) || 0)} 
                        disabled={experimentLoading}
                        style={{ padding: '0.25rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <span>Min Similarity (0.0 - 1.0):</span>
                      <input 
                        type="number" 
                        step="0.05" 
                        min="0" 
                        max="1"
                        value={candidateMinSim} 
                        onChange={(e) => setCandidateMinSim(parseFloat(e.target.value) || 0)} 
                        disabled={experimentLoading}
                        style={{ padding: '0.25rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <span>Max Conversation Snippets (1 - 100):</span>
                      <input 
                        type="number" 
                        min="1" 
                        max="100"
                        value={candidateMaxConvSnippets} 
                        onChange={(e) => setCandidateMaxConvSnippets(parseInt(e.target.value) || 0)} 
                        disabled={experimentLoading}
                        style={{ padding: '0.25rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                      />
                    </label>
                  </div>
                </div>
              </div>

              {/* Action Button & Error Display */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.25rem' }}>
                <button
                  onClick={handleRunExperiment}
                  disabled={experimentLoading}
                  className="premium-btn premium-btn-primary"
                  style={{ width: '100%' }}
                >
                  {experimentLoading ? (
                    <>
                      {renderSpinner()}
                      Running Experiment (Evaluating real pipelines)...
                    </>
                  ) : (
                    <>🧪 Run A/B Experiment</>
                  )}
                </button>

                {experimentError && (
                  <div style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--error)', backgroundColor: 'rgba(179, 74, 60, 0.05)', color: 'var(--error)', fontSize: '0.75rem' }}>
                    ⚠️ {experimentError}
                  </div>
                )}
              </div>

              {/* Comparison Results Card */}
              {experimentResult && (
                <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(0,0,0,0.2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
                    <h4 style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--primary)', margin: 0 }}>A/B Experimentation Report</h4>
                    <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>
                      Winner: 
                      {experimentResult.recommendation === 'candidate' && (
                        <span style={{ color: 'var(--success)', marginLeft: '0.3rem' }}>🎉 Candidate (Config B)</span>
                      )}
                      {experimentResult.recommendation === 'control' && (
                        <span style={{ color: 'var(--primary)', marginLeft: '0.3rem' }}>🎉 Control (Config A)</span>
                      )}
                      {experimentResult.recommendation === 'draw' && (
                        <span style={{ color: 'var(--text)', opacity: 0.8, marginLeft: '0.3rem' }}>⚖️ Draw</span>
                      )}
                    </div>
                  </div>

                  <div style={{ fontSize: '0.75rem', opacity: 0.9, backgroundColor: 'rgba(255,255,255,0.03)', padding: '0.5rem', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)', marginBottom: '1rem' }}>
                    ℹ️ <strong>Recommendation:</strong> {experimentResult.recommendationExplanation}
                  </div>

                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', fontSize: '0.7rem', textAlign: 'left', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)', opacity: 0.6 }}>
                          <th style={{ padding: '0.35rem' }}>Metric</th>
                          <th style={{ padding: '0.35rem' }}>Control (Config A)</th>
                          <th style={{ padding: '0.35rem' }}>Candidate (Config B)</th>
                          <th style={{ padding: '0.35rem' }}>Delta (Abs)</th>
                          <th style={{ padding: '0.35rem' }}>Delta (%)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(experimentResult.comparison.deltas).map(([metric, delta]) => {
                          const valCtrl = (experimentResult.controlSummary as unknown as Record<string, number | undefined>)[metric];
                          const valCand = (experimentResult.candidateSummary as unknown as Record<string, number | undefined>)[metric];

                          const formatMetricVal = (metricName: string, val: number | undefined) => {
                            if (val === undefined) return 'N/A';
                            if (metricName === 'averageLatency') return `${Math.round(val)} ms`;
                            if (metricName === 'timeoutCount') return `${val}`;
                            return `${(val * 100).toFixed(0)}%`;
                          };

                          let deltaColor = 'var(--text)';
                          if (delta.type === 'improvement') deltaColor = 'var(--success)';
                          else if (delta.type === 'regression') deltaColor = 'var(--error)';

                          const formatAbsVal = (metricName: string, val: number | undefined) => {
                            if (val === undefined) return 'N/A';
                            const sign = val > 0 ? '+' : '';
                            if (metricName === 'averageLatency') return `${sign}${Math.round(val)} ms`;
                            if (metricName === 'timeoutCount') return `${sign}${val}`;
                            return `${sign}${(val * 100).toFixed(0)}%`;
                          };

                          const absText = delta.absolute !== undefined ? formatAbsVal(metric, delta.absolute) : 'N/A';
                          const pctText = delta.percentage !== undefined ? `${delta.percentage > 0 ? '+' : ''}${delta.percentage.toFixed(0)}%` : 'N/A';

                          return (
                            <tr key={metric} style={{ borderBottom: '1px solid var(--border)', opacity: 0.9 }}>
                              <td style={{ padding: '0.35rem', fontWeight: 600 }}>{metric}</td>
                              <td style={{ padding: '0.35rem' }}>{formatMetricVal(metric, valCtrl)}</td>
                              <td style={{ padding: '0.35rem' }}>{formatMetricVal(metric, valCand)}</td>
                              <td style={{ padding: '0.35rem', color: deltaColor }}>{absText}</td>
                              <td style={{ padding: '0.35rem', color: deltaColor }}>{pctText}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* A/B Experiment History & Longitudinal Analysis */}
            <div className="card" style={{ padding: '1.25rem', marginTop: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>📜 A/B Experiment History</h3>
                {experimentHistory.length > 0 && (
                  <button
                    onClick={handleClearExperimentHistory}
                    className="premium-btn"
                    style={{ fontSize: '0.65rem', padding: '0.25rem 0.5rem', backgroundColor: 'rgba(179, 74, 60, 0.1)', border: '1px solid var(--error)', color: 'var(--error)' }}
                  >
                    🗑️ Clear History
                  </button>
                )}
              </div>
              <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                Auditing session-scoped A/B evaluation records. Compare candidates longitudinally to monitor retrieval improvements.
              </p>

              {expHistoryLoading && <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>Loading history...</div>}
              {expHistoryError && <div style={{ fontSize: '0.75rem', color: 'var(--error)' }}>⚠️ {expHistoryError}</div>}

              {!expHistoryLoading && !expHistoryError && experimentHistory.length === 0 && (
                <div style={{ fontSize: '0.75rem', opacity: 0.5, textAlign: 'center', padding: '1.5rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)' }}>
                  No historical experiments logged in this session. Run an A/B experiment above to record metrics.
                </div>
              )}

              {experimentHistory.length > 0 && (
                <>
                  {/* Historical Runs List */}
                  <div style={{ overflowX: 'auto', maxHeight: '250px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', marginBottom: '1.25rem' }}>
                    <table style={{ width: '100%', fontSize: '0.7rem', textAlign: 'left', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)', backgroundColor: 'rgba(255,255,255,0.02)', position: 'sticky', top: 0, zIndex: 1 }}>
                          <th style={{ padding: '0.4rem' }}>Timestamp</th>
                          <th style={{ padding: '0.4rem' }}>Control Config</th>
                          <th style={{ padding: '0.4rem' }}>Candidate Config</th>
                          <th style={{ padding: '0.4rem' }}>Winner</th>
                          <th style={{ padding: '0.4rem', textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {experimentHistory.map((run) => {
                          const timeStr = new Date(run.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                          return (
                            <tr key={run.id} style={{ borderBottom: '1px solid var(--border)', opacity: 0.9 }}>
                              <td style={{ padding: '0.4rem', fontWeight: 600 }}>{timeStr}</td>
                              <td style={{ padding: '0.4rem' }}>
                                sem:{run.controlConfig.semanticWeight} / lex:{run.controlConfig.lexicalWeight} / sim:{run.controlConfig.minSimilarity}
                              </td>
                              <td style={{ padding: '0.4rem' }}>
                                sem:{run.candidateConfig.semanticWeight} / lex:{run.candidateConfig.lexicalWeight} / sim:{run.candidateConfig.minSimilarity}
                              </td>
                              <td style={{ padding: '0.4rem' }}>
                                {run.recommendation === 'candidate' && (
                                  <span style={{ color: 'var(--success)', fontWeight: 600 }}>Candidate</span>
                                )}
                                {run.recommendation === 'control' && (
                                  <span style={{ color: 'var(--primary)', fontWeight: 600 }}>Control</span>
                                )}
                                {run.recommendation === 'draw' && (
                                  <span style={{ color: 'var(--text)', opacity: 0.7 }}>Draw</span>
                                )}
                              </td>
                              <td style={{ padding: '0.4rem', textAlign: 'right' }}>
                                <button
                                  onClick={() => handleDeleteExperiment(run.id)}
                                  style={{ background: 'none', border: 'none', color: 'var(--error)', cursor: 'pointer', fontSize: '0.75rem', opacity: 0.8 }}
                                  title="Delete Record"
                                >
                                  ❌
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Longitudinal Comparison Selector */}
                  <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(255,255,255,0.01)' }}>
                    <h4 style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--primary)', marginBottom: '0.75rem' }}>📈 Longitudinal Candidate Comparison</h4>
                    <p style={{ fontSize: '0.65rem', opacity: 0.7, marginBottom: '0.75rem' }}>
                      Analyze candidate performance changes between two historical configurations. Reuses standard evaluation regression tolerance thresholds.
                    </p>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.7rem' }}>
                        <span>Base Experiment (Older):</span>
                        <select
                          value={baseExpId}
                          onChange={(e) => setBaseExpId(e.target.value)}
                          style={{ padding: '0.3rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                        >
                          <option value="">-- Select base run --</option>
                          {experimentHistory.map((run) => (
                            <option key={run.id} value={run.id}>
                              {new Date(run.timestamp).toLocaleTimeString()} (Winner: {run.recommendation})
                            </option>
                          ))}
                        </select>
                      </label>

                      <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.7rem' }}>
                        <span>Target Experiment (Newer):</span>
                        <select
                          value={targetExpId}
                          onChange={(e) => setTargetExpId(e.target.value)}
                          style={{ padding: '0.3rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                        >
                          <option value="">-- Select target run --</option>
                          {experimentHistory.map((run) => (
                            <option key={run.id} value={run.id}>
                              {new Date(run.timestamp).toLocaleTimeString()} (Winner: {run.recommendation})
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <button
                      onClick={handleCompareExperiments}
                      disabled={!baseExpId || !targetExpId || baseExpId === targetExpId || expComparisonLoading}
                      className="premium-btn premium-btn-primary"
                      style={{ width: '100%', padding: '0.4rem', fontSize: '0.7rem' }}
                    >
                      {expComparisonLoading ? 'Comparing candidate metrics...' : 'Compare Candidate Runs'}
                    </button>

                    {expComparisonError && (
                      <div style={{ marginTop: '0.5rem', padding: '0.4rem 0.6rem', border: '1px solid var(--error)', borderRadius: 'var(--radius-sm)', backgroundColor: 'rgba(179,74,60,0.05)', color: 'var(--error)', fontSize: '0.7rem' }}>
                        ⚠️ {expComparisonError}
                      </div>
                    )}

                    {/* Comparison Delta View */}
                    {expComparisonResult && (
                      <div style={{ marginTop: '1rem', padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'rgba(0,0,0,0.15)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.35rem' }}>
                          <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>Longitudinal Report</span>
                          <span style={{
                            fontSize: '0.65rem',
                            fontWeight: 700,
                            padding: '0.15rem 0.4rem',
                            borderRadius: 'var(--radius-xs)',
                            backgroundColor: expComparisonResult.comparison.status === 'fail' ? 'rgba(179,74,60,0.2)' : expComparisonResult.comparison.status === 'warning' ? 'rgba(230,126,34,0.2)' : 'rgba(46,204,113,0.2)',
                            color: expComparisonResult.comparison.status === 'fail' ? 'var(--error)' : expComparisonResult.comparison.status === 'warning' ? '#e67e22' : 'var(--success)'
                          }}>
                            STATUS: {expComparisonResult.comparison.status.toUpperCase()}
                          </span>
                        </div>

                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', fontSize: '0.65rem', textAlign: 'left', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr style={{ borderBottom: '1px solid var(--border)', opacity: 0.5 }}>
                                <th style={{ padding: '0.3rem' }}>Metric</th>
                                <th style={{ padding: '0.3rem' }}>Base Candidate</th>
                                <th style={{ padding: '0.3rem' }}>Target Candidate</th>
                                <th style={{ padding: '0.3rem' }}>Delta (Abs)</th>
                                <th style={{ padding: '0.3rem' }}>Delta (%)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {Object.entries(expComparisonResult.comparison.deltas).map(([metric, delta]) => {
                                const baseRecord = experimentHistory.find((r) => r.id === baseExpId);
                                const targetRecord = experimentHistory.find((r) => r.id === targetExpId);
                                const valBase = baseRecord ? (baseRecord.candidateSummary as unknown as Record<string, number | undefined>)[metric] : undefined;
                                const valTarget = targetRecord ? (targetRecord.candidateSummary as unknown as Record<string, number | undefined>)[metric] : undefined;

                                const formatMetricVal = (metricName: string, val: number | undefined) => {
                                  if (val === undefined) return 'N/A';
                                  if (metricName === 'averageLatency') return `${Math.round(val)} ms`;
                                  if (metricName === 'timeoutCount') return `${val}`;
                                  return `${(val * 100).toFixed(0)}%`;
                                };

                                let deltaColor = 'var(--text)';
                                if (delta.type === 'improvement') deltaColor = 'var(--success)';
                                else if (delta.type === 'regression') deltaColor = 'var(--error)';

                                const formatAbsVal = (metricName: string, val: number | undefined) => {
                                  if (val === undefined) return 'N/A';
                                  const sign = val > 0 ? '+' : '';
                                  if (metricName === 'averageLatency') return `${sign}${Math.round(val)} ms`;
                                  if (metricName === 'timeoutCount') return `${sign}${val}`;
                                  return `${sign}${(val * 100).toFixed(0)}%`;
                                };

                                const absText = delta.absolute !== undefined ? formatAbsVal(metric, delta.absolute) : 'N/A';
                                const pctText = delta.percentage !== undefined ? `${delta.percentage > 0 ? '+' : ''}${delta.percentage.toFixed(0)}%` : 'N/A';

                                return (
                                  <tr key={metric} style={{ borderBottom: '1px solid var(--border)', opacity: 0.9 }}>
                                    <td style={{ padding: '0.3rem', fontWeight: 600 }}>{metric}</td>
                                    <td style={{ padding: '0.3rem' }}>{formatMetricVal(metric, valBase)}</td>
                                    <td style={{ padding: '0.3rem' }}>{formatMetricVal(metric, valTarget)}</td>
                                    <td style={{ padding: '0.3rem', color: deltaColor }}>{absText}</td>
                                    <td style={{ padding: '0.3rem', color: deltaColor }}>{pctText}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* A/B Experiment Insights */}
            <div className="card" style={{ padding: '1.25rem', marginTop: '1.5rem' }}>
              <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600 }}>💡 Experiment Insights — Advisory Only</h3>
              <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1.25rem' }}>
                Statistical trends and suggested configurations compiled from session-scoped history runs.
              </p>

              {expInsightsLoading && <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>Loading insights...</div>}
              {expInsightsError && <div style={{ fontSize: '0.75rem', color: 'var(--error)' }}>⚠️ {expInsightsError}</div>}

              {!expInsightsLoading && !expInsightsError && experimentInsights && (
                <>
                  {experimentInsights.insufficientHistory ? (
                    <div style={{ fontSize: '0.75rem', opacity: 0.8, backgroundColor: 'rgba(230, 126, 34, 0.05)', padding: '1rem', borderRadius: 'var(--radius-md)', border: '1px solid #e67e22', color: '#e67e22', textAlign: 'center' }}>
                      ⚠️ Insufficient history. Execute at least 2 distinct A/B experiments to generate aggregated insights and track metrics shift.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                      {/* Stats Distribution Grid */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '1rem' }}>
                        <div style={{ padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'rgba(255,255,255,0.01)', textAlign: 'center' }}>
                          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--primary)' }}>{experimentInsights.totalExperiments}</div>
                          <div style={{ fontSize: '0.65rem', opacity: 0.6 }}>Total Experiments</div>
                        </div>

                        <div style={{ padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'rgba(255,255,255,0.01)', display: 'flex', justifyContent: 'space-around', alignItems: 'center' }}>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--primary)' }}>{experimentInsights.controlWins}</div>
                            <div style={{ fontSize: '0.65rem', opacity: 0.6 }}>Ctrl Wins (A)</div>
                          </div>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--success)' }}>{experimentInsights.candidateWins}</div>
                            <div style={{ fontSize: '0.65rem', opacity: 0.6 }}>Cand Wins (B)</div>
                          </div>
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text)' }}>{experimentInsights.draws}</div>
                            <div style={{ fontSize: '0.65rem', opacity: 0.6 }}>Draws</div>
                          </div>
                        </div>
                      </div>

                      {/* Best Tested Configuration Display */}
                      {experimentInsights.bestConfig ? (
                        <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(46, 204, 113, 0.03)', borderLeft: '4px solid var(--success)' }}>
                          <h4 style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--success)', margin: '0 0 0.5rem 0' }}>🏆 Optimal Tested Parameter Matrix</h4>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem', fontSize: '0.7rem', marginBottom: '0.5rem', textAlign: 'center' }}>
                            <div style={{ padding: '0.35rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' }}>
                              <span style={{ display: 'block', opacity: 0.5, fontSize: '0.55rem' }}>SEMANTIC</span>
                              <strong>{experimentInsights.bestConfig.semanticWeight}</strong>
                            </div>
                            <div style={{ padding: '0.35rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' }}>
                              <span style={{ display: 'block', opacity: 0.5, fontSize: '0.55rem' }}>LEXICAL</span>
                              <strong>{experimentInsights.bestConfig.lexicalWeight}</strong>
                            </div>
                            <div style={{ padding: '0.35rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' }}>
                              <span style={{ display: 'block', opacity: 0.5, fontSize: '0.55rem' }}>MIN SIM</span>
                              <strong>{experimentInsights.bestConfig.minSimilarity}</strong>
                            </div>
                            <div style={{ padding: '0.35rem', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' }}>
                              <span style={{ display: 'block', opacity: 0.5, fontSize: '0.55rem' }}>SNIPPETS</span>
                              <strong>{experimentInsights.bestConfig.maxConversationSnippets}</strong>
                            </div>
                          </div>
                          <p style={{ fontSize: '0.65rem', opacity: 0.8, margin: 0 }}>
                            💡 <strong>Recommendation Source:</strong> Extracted from the winning <strong>{experimentInsights.bestConfigSource} configuration</strong> run that achieved the highest net comparison margin.
                          </p>
                        </div>
                      ) : (
                        <div style={{ padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(255,255,255,0.01)', fontSize: '0.7rem', opacity: 0.7 }}>
                          No decisive winning configurations identified yet (all logged runs resulted in draws).
                        </div>
                      )}

                      {/* Metric Trends (Improving/Degrading) */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
                        <div>
                          <h4 style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--success)', marginBottom: '0.5rem' }}>📈 Improving Metrics</h4>
                          {experimentInsights.improvingMetrics.length > 0 ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                              {experimentInsights.improvingMetrics.map((m) => (
                                <span key={m} style={{ fontSize: '0.6rem', padding: '0.15rem 0.4rem', borderRadius: 'var(--radius-xs)', backgroundColor: 'rgba(46,204,113,0.15)', color: 'var(--success)', border: '1px solid rgba(46,204,113,0.3)' }}>
                                  {m} ({experimentInsights.averageDeltas[m] > 0 ? '+' : ''}
                                  {m === 'averageLatency' ? `${Math.round(experimentInsights.averageDeltas[m])}ms` : `${(experimentInsights.averageDeltas[m] * 100).toFixed(0)}%`})
                                </span>
                              ))}
                            </div>
                          ) : (
                            <div style={{ fontSize: '0.65rem', opacity: 0.5 }}>No metrics show significant improvements.</div>
                          )}
                        </div>

                        <div>
                          <h4 style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--error)', marginBottom: '0.5rem' }}>📉 Degrading Metrics</h4>
                          {experimentInsights.degradingMetrics.length > 0 ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                              {experimentInsights.degradingMetrics.map((m) => (
                                <span key={m} style={{ fontSize: '0.6rem', padding: '0.15rem 0.4rem', borderRadius: 'var(--radius-xs)', backgroundColor: 'rgba(179,74,60,0.15)', color: 'var(--error)', border: '1px solid rgba(179,74,60,0.3)' }}>
                                  {m} ({experimentInsights.averageDeltas[m] > 0 ? '+' : ''}
                                  {m === 'averageLatency' ? `${Math.round(experimentInsights.averageDeltas[m])}ms` : `${(experimentInsights.averageDeltas[m] * 100).toFixed(0)}%`})
                                </span>
                              ))}
                            </div>
                          ) : (
                            <div style={{ fontSize: '0.65rem', opacity: 0.5 }}>No metrics show significant regressions.</div>
                          )}
                        </div>
                      </div>

                      {/* Advisory Warning Note */}
                      <div style={{ fontSize: '0.65rem', opacity: 0.6, borderTop: '1px solid var(--border)', paddingTop: '0.5rem', textAlign: 'center', fontStyle: 'italic' }}>
                        * Advisory Only. Running configuration parameters are not automatically promoted to production defaults.
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Evaluation Configuration Promotion */}
            <div className="card" style={{ padding: '1.25rem', marginTop: '1.5rem' }}>
              <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600 }}>⚙️ Evaluation Configuration</h3>
              <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1.25rem' }}>
                Review and promote tested parameters as the active evaluation configuration.
                <span style={{ display: 'block', marginTop: '0.25rem', color: 'var(--primary)', fontWeight: 600 }}>
                  ⚠️ Developer / Evaluation Only — Does Not Modify Production Runtime
                </span>
              </p>

              {promotedLoading && <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>Processing configuration...</div>}
              {promotedError && <div style={{ fontSize: '0.75rem', color: 'var(--error)' }}>⚠️ {promotedError}</div>}

              {!promotedLoading && promotedConfigStatus && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  {/* Grid of Current and Previous promoted configs */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
                    {/* Current Config */}
                    <div style={{ padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(255,255,255,0.01)' }}>
                      <h4 style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--primary)', marginBottom: '0.5rem' }}>Active Config Override</h4>
                      {promotedConfigStatus.hasPromotedConfig && promotedConfigStatus.currentConfig ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.65rem' }}>
                          <div>Semantic Weight: <strong>{promotedConfigStatus.currentConfig.semanticWeight}</strong></div>
                          <div>Lexical Weight: <strong>{promotedConfigStatus.currentConfig.lexicalWeight}</strong></div>
                          <div>Min Similarity: <strong>{promotedConfigStatus.currentConfig.minSimilarity}</strong></div>
                          <div>Snippets Limit: <strong>{promotedConfigStatus.currentConfig.maxConversationSnippets}</strong></div>
                        </div>
                      ) : (
                        <div style={{ fontSize: '0.65rem', opacity: 0.5 }}>None (Using production settings defaults).</div>
                      )}
                    </div>

                    {/* Previous Config */}
                    <div style={{ padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(255,255,255,0.01)' }}>
                      <h4 style={{ fontSize: '0.75rem', fontWeight: 600, opacity: 0.8, marginBottom: '0.5rem' }}>Previous Config</h4>
                      {promotedConfigStatus.previousConfig ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.65rem' }}>
                          <div>Semantic Weight: <strong>{promotedConfigStatus.previousConfig.semanticWeight}</strong></div>
                          <div>Lexical Weight: <strong>{promotedConfigStatus.previousConfig.lexicalWeight}</strong></div>
                          <div>Min Similarity: <strong>{promotedConfigStatus.previousConfig.minSimilarity}</strong></div>
                          <div>Snippets Limit: <strong>{promotedConfigStatus.previousConfig.maxConversationSnippets}</strong></div>
                        </div>
                      ) : (
                        <div style={{ fontSize: '0.65rem', opacity: 0.5 }}>None (No previous rollback target).</div>
                      )}
                    </div>
                  </div>

                  {/* Actions Area */}
                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    {experimentInsights?.bestConfig ? (
                      <button
                        onClick={() => handlePromoteConfig(experimentInsights.bestConfig!)}
                        disabled={promotedLoading || !experimentInsights.bestConfig}
                        className="btn btn-primary"
                        style={{ fontSize: '0.7rem', padding: '0.4rem 0.8rem' }}
                      >
                        🚀 Promote Recommended Config
                      </button>
                    ) : (
                      <button
                        disabled
                        className="btn btn-secondary"
                        style={{ fontSize: '0.7rem', padding: '0.4rem 0.8rem', opacity: 0.5, cursor: 'not-allowed' }}
                      >
                        No Recommended Config Available
                      </button>
                    )}

                    <button
                      onClick={handleRollbackConfig}
                      disabled={promotedLoading || !promotedConfigStatus.previousConfig}
                      className="btn"
                      style={{
                        fontSize: '0.7rem',
                        padding: '0.4rem 0.8rem',
                        border: '1px solid var(--border)',
                        backgroundColor: 'transparent',
                        opacity: promotedConfigStatus.previousConfig ? 1 : 0.5,
                        cursor: promotedConfigStatus.previousConfig ? 'pointer' : 'not-allowed'
                      }}
                    >
                      ↩️ Rollback Previous Config
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Configuration Change History */}
            <div className="card" style={{ padding: '1.25rem', marginTop: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>📋 Configuration Change History</h3>
                {promotionHistory.length > 0 && (
                  <button
                    onClick={handleClearPromotionHistory}
                    disabled={promotionHistoryLoading}
                    className="btn"
                    style={{ fontSize: '0.65rem', padding: '0.2rem 0.5rem', border: '1px solid var(--border)', backgroundColor: 'transparent', cursor: 'pointer' }}
                  >
                    Clear Audit Trail
                  </button>
                )}
              </div>
              <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1.25rem' }}>
                Audit trail tracking all parameter promotions and rollbacks.
                <span style={{ display: 'block', marginTop: '0.25rem', color: 'var(--primary)', fontWeight: 600 }}>
                  ⚠️ Developer / Evaluation Only — Tracks local overrides transitions
                </span>
              </p>

              {promotionHistoryLoading && <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>Loading change logs...</div>}
              {promotionHistoryError && <div style={{ fontSize: '0.75rem', color: 'var(--error)' }}>⚠️ {promotionHistoryError}</div>}

              {!promotionHistoryLoading && !promotionHistoryError && (
                <>
                  {promotionHistory.length === 0 ? (
                    <div style={{ fontSize: '0.75rem', opacity: 0.5, textAlign: 'center', padding: '1rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)' }}>
                      No configuration change records in the audit log.
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto', maxHeight: '250px' }}>
                      <table style={{ width: '100%', fontSize: '0.65rem', textAlign: 'left', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)', opacity: 0.5 }}>
                            <th style={{ padding: '0.4rem' }}>Time</th>
                            <th style={{ padding: '0.4rem' }}>Action</th>
                            <th style={{ padding: '0.4rem' }}>Parameter Changes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {promotionHistory.map((record) => {
                            const dateStr = new Date(record.timestamp).toLocaleTimeString();
                            const actionColor = record.action === 'promote' ? 'var(--success)' : '#e67e22';
                            const actionBg = record.action === 'promote' ? 'rgba(46,204,113,0.15)' : 'rgba(230,126,34,0.15)';

                            const renderConfigDiff = (prev: import('@/evaluation/types').TuningConfig | null, next: import('@/evaluation/types').TuningConfig | null) => {
                              if (!prev && !next) return <span>No parameter changes</span>;
                              if (!prev && next) return <span>Set Config (minSim: {next.minSimilarity}, semWt: {next.semanticWeight})</span>;
                              if (prev && !next) return <span>Cleared Config</span>;

                              const p = prev as import('@/evaluation/types').TuningConfig;
                              const n = next as import('@/evaluation/types').TuningConfig;

                              const diffs: string[] = [];
                              const keys: (keyof import('@/evaluation/types').TuningConfig)[] = ['semanticWeight', 'lexicalWeight', 'minSimilarity', 'maxConversationSnippets'];
                              for (const key of keys) {
                                if (p[key] !== n[key]) {
                                  diffs.push(`${key}: ${p[key]} → ${n[key]}`);
                                }
                              }

                              if (diffs.length === 0) return <span>No parameter changes</span>;
                              return <span>{diffs.join(', ')}</span>;
                            };

                            return (
                              <tr key={record.id} style={{ borderBottom: '1px solid var(--border)', opacity: 0.9 }}>
                                <td style={{ padding: '0.4rem', whiteSpace: 'nowrap' }}>{dateStr}</td>
                                <td style={{ padding: '0.4rem' }}>
                                  <span style={{ fontSize: '0.55rem', padding: '0.1rem 0.3rem', borderRadius: 'var(--radius-xs)', backgroundColor: actionBg, color: actionColor, border: `1px solid ${actionColor}33`, fontWeight: 600, textTransform: 'uppercase' }}>
                                    {record.action}
                                  </span>
                                </td>
                                <td style={{ padding: '0.4rem', fontFamily: 'monospace', opacity: 0.8 }}>
                                  {renderConfigDiff(record.previousConfig, record.newConfig)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Retrieval Parameter Optimization & Matrix Tuning */}
            <div className="card" style={{ padding: '1.25rem', marginTop: '1.5rem' }}>
              <h3 className="card-title" style={{ fontSize: '1rem', fontWeight: 600 }}>Retrieval Parameter Optimization</h3>
              <p style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '1rem' }}>
                Run systematic matrix simulations to optimize semantic/lexical weights, thresholds, and snippet lengths.
              </p>

              {/* Benchmark Mode Selector */}
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', backgroundColor: 'rgba(0,0,0,0.15)', padding: '0.25rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                <button
                  onClick={() => setTuningMode('real')}
                  disabled={tuningLoading}
                  style={{
                    flex: 1,
                    padding: '0.4rem',
                    borderRadius: 'var(--radius-xs)',
                    border: 'none',
                    backgroundColor: tuningMode === 'real' ? 'var(--primary)' : 'transparent',
                    color: tuningMode === 'real' ? '#fff' : 'var(--text)',
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    cursor: tuningLoading ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  ⚡ Real Database Pipeline
                </button>
                <button
                  onClick={() => setTuningMode('mock')}
                  disabled={tuningLoading}
                  style={{
                    flex: 1,
                    padding: '0.4rem',
                    borderRadius: 'var(--radius-xs)',
                    border: 'none',
                    backgroundColor: tuningMode === 'mock' ? 'var(--primary)' : 'transparent',
                    color: tuningMode === 'mock' ? '#fff' : 'var(--text)',
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    cursor: tuningLoading ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  🧪 Mock Sandbox Mode
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                <button
                  onClick={handleRunTuning}
                  className="premium-btn premium-btn-primary"
                  disabled={tuningLoading}
                  style={{ marginBottom: 0 }}
                >
                  {tuningLoading ? (
                    <>
                      {renderSpinner()}
                      Tuning Matrix...
                    </>
                  ) : (
                    <>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '0.25rem' }}>
                        <circle cx="12" cy="12" r="3"/><path d="M3 20h18L12 4z"/>
                      </svg>
                      Optimize Parameters & Benchmark
                    </>
                  )}
                </button>

                {tuningSummary && (
                  tuningSummary.realPipelineExecuted ? (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.25rem 0.5rem', borderRadius: '12px', fontSize: '0.6rem', fontWeight: 'bold', textTransform: 'uppercase', backgroundColor: 'rgba(212, 175, 55, 0.1)', color: '#d4af37', border: '1px solid #d4af37' }}>
                      ⚡ Real Database Pipeline Active
                    </div>
                  ) : (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.25rem 0.5rem', borderRadius: '12px', fontSize: '0.6rem', fontWeight: 'bold', textTransform: 'uppercase', backgroundColor: 'rgba(52, 152, 219, 0.1)', color: '#3498db', border: '1px solid #3498db' }}>
                      🧪 Mock / Sandbox Mode Active
                    </div>
                  )
                )}
              </div>

              {tuningError && (
                <div style={{ padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--error)', backgroundColor: 'rgba(179, 74, 60, 0.05)', color: 'var(--error)', fontSize: '0.75rem', marginBottom: '1rem' }}>
                  {tuningError}
                </div>
              )}

              {tuningSummary && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  
                  {/* Recommendation Banner */}
                  <div style={{ padding: '1rem', border: '1px solid var(--success)', borderRadius: 'var(--radius-md)', backgroundColor: 'rgba(91, 138, 82, 0.05)', fontSize: '0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                      <span style={{ fontSize: '1.1rem' }}>💡</span>
                      <strong style={{ color: 'var(--success)', fontSize: '0.8rem' }}>Recommended Retrieval Configuration</strong>
                    </div>
                    <p style={{ margin: '0 0 0.5rem 0', opacity: 0.8 }}>
                      {tuningSummary.recommendationExplanation}
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.5rem', backgroundColor: 'rgba(0,0,0,0.2)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                      <div>Semantic Weight: <strong>{tuningSummary.bestConfig.semanticWeight.toFixed(2)}</strong></div>
                      <div>Lexical Weight: <strong>{tuningSummary.bestConfig.lexicalWeight.toFixed(2)}</strong></div>
                      <div>minSimilarity: <strong>{tuningSummary.bestConfig.minSimilarity.toFixed(2)}</strong></div>
                      <div>diversityThreshold: <strong>{tuningSummary.bestConfig.diversityThreshold.toFixed(2)}</strong></div>
                      <div>maxSnippets: <strong>{tuningSummary.bestConfig.maxConversationSnippets}</strong></div>
                    </div>
                    <p style={{ margin: '0.5rem 0 0 0', opacity: 0.6, fontSize: '0.65rem', fontStyle: 'italic' }}>
                      Note: This recommendation is for developer review only and has not modified your active production defaults.
                    </p>
                  </div>

                  {/* Matrix Results Table */}
                  <div>
                    <h4 style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem', opacity: 0.8 }}>Matrix Tuning Configurations Run</h4>
                    <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.7rem', textAlign: 'left' }}>
                        <thead>
                          <tr style={{ backgroundColor: 'var(--background)', borderBottom: '1px solid var(--border)' }}>
                            <th style={{ padding: '0.5rem' }}>Weights (Sem/Lex)</th>
                            <th style={{ padding: '0.5rem' }}>minSim</th>
                            <th style={{ padding: '0.5rem' }}>diversity</th>
                            <th style={{ padding: '0.5rem' }}>maxSnips</th>
                            <th style={{ padding: '0.5rem', textAlign: 'center' }}>Pass/Fail</th>
                            <th style={{ padding: '0.5rem', textAlign: 'center' }}>Recall</th>
                            <th style={{ padding: '0.5rem', textAlign: 'center' }}>Faith</th>
                            <th style={{ padding: '0.5rem', textAlign: 'center' }}>Score</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tuningSummary.matrixResults.map((res: TuningResult, idx: number) => {
                            const isBest = idx === 0;
                            return (
                              <tr 
                                key={idx} 
                                style={{ 
                                  borderBottom: '1px solid var(--border)', 
                                  backgroundColor: isBest ? 'rgba(212, 175, 55, 0.05)' : 'transparent',
                                  fontWeight: isBest ? 'bold' : 'normal'
                                }}
                              >
                                <td style={{ padding: '0.5rem' }}>
                                  {res.config.semanticWeight.toFixed(1)} / {res.config.lexicalWeight.toFixed(1)}
                                  {isBest && <span style={{ color: '#d4af37', marginLeft: '0.25rem' }}>★ Best</span>}
                                </td>
                                <td style={{ padding: '0.5rem' }}>{res.config.minSimilarity.toFixed(1)}</td>
                                <td style={{ padding: '0.5rem' }}>{res.config.diversityThreshold.toFixed(1)}</td>
                                <td style={{ padding: '0.5rem' }}>{res.config.maxConversationSnippets}</td>
                                <td style={{ padding: '0.5rem', textAlign: 'center', color: res.failedCount > 0 ? 'var(--error)' : 'var(--success)' }}>
                                  {res.passedCount} / {res.passedCount + res.failedCount}
                                </td>
                                <td style={{ padding: '0.5rem', textAlign: 'center' }}>{(res.averageMetrics.retrievalRecall * 100).toFixed(0)}%</td>
                                <td style={{ padding: '0.5rem', textAlign: 'center' }}>{((res.averageMetrics.faithfulness ?? 1.0) * 100).toFixed(0)}%</td>
                                <td style={{ padding: '0.5rem', textAlign: 'center', fontWeight: 'bold' }}>{(res.overallBenchmarkScore * 100).toFixed(1)}%</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Conversation Detail Modal Overlay */}
      {selectedConversation && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.4)',
          backdropFilter: 'blur(3px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '1.5rem'
        }}>
          <div className="card" style={{
            width: '100%',
            maxWidth: '550px',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            padding: '1.5rem',
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--primary)', margin: 0 }}>Conversation Details</h3>
              <button 
                onClick={() => {
                  setSelectedConversation(null);
                  setExtractError(null);
                  setExtractResult(null);
                  setSummarizeError(null);
                }}
                className="premium-btn premium-btn-secondary"
                style={{ padding: '0.2rem 0.4rem', minWidth: 'auto' }}
              >
                ✕ Close
              </button>
            </div>
            
            <div style={{ display: 'flex', gap: '1rem', fontSize: '0.75rem', color: 'var(--text)', opacity: 0.8, marginBottom: '1rem' }}>
              <div><strong>Recorded:</strong> {new Date(selectedConversation.createdAt).toLocaleDateString()}</div>
              <div><strong>Duration:</strong> {selectedConversation.durationSeconds || 0}s</div>
            </div>

            {/* Tab Selector */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: '1rem' }}>
              <button
                type="button"
                onClick={() => setSelectedConvTab('transcript')}
                style={{
                  padding: '0.5rem 1rem',
                  border: 'none',
                  background: 'none',
                  color: selectedConvTab === 'transcript' ? 'var(--primary)' : 'var(--text)',
                  borderBottom: selectedConvTab === 'transcript' ? '2px solid var(--primary)' : 'none',
                  fontWeight: selectedConvTab === 'transcript' ? 'bold' : 'normal',
                  cursor: 'pointer',
                  fontSize: '0.8rem'
                }}
              >
                📝 Transcript
              </button>
              <button
                type="button"
                onClick={() => setSelectedConvTab('summary')}
                style={{
                  padding: '0.5rem 1rem',
                  border: 'none',
                  background: 'none',
                  color: selectedConvTab === 'summary' ? 'var(--primary)' : 'var(--text)',
                  borderBottom: selectedConvTab === 'summary' ? '2px solid var(--primary)' : 'none',
                  fontWeight: selectedConvTab === 'summary' ? 'bold' : 'normal',
                  cursor: 'pointer',
                  fontSize: '0.8rem'
                }}
              >
                ✨ Summary
              </button>
              <button
                type="button"
                onClick={() => setSelectedConvTab('memories')}
                style={{
                  padding: '0.5rem 1rem',
                  border: 'none',
                  background: 'none',
                  color: selectedConvTab === 'memories' ? 'var(--primary)' : 'var(--text)',
                  borderBottom: selectedConvTab === 'memories' ? '2px solid var(--primary)' : 'none',
                  fontWeight: selectedConvTab === 'memories' ? 'bold' : 'normal',
                  cursor: 'pointer',
                  fontSize: '0.8rem'
                }}
              >
                🧠 Extracted Memories ({conversationMemories.length})
              </button>
            </div>

            {selectedConvTab === 'transcript' && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem', backgroundColor: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.85rem', lineHeight: '1.5', fontStyle: 'italic', marginBottom: '1rem' }}>
                  {selectedConversation.transcript}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button 
                    onClick={() => {
                      setContentInput(selectedConversation.transcript);
                      setSelectedConversation(null);
                      setExtractError(null);
                      setExtractResult(null);
                      setSummarizeError(null);
                    }} 
                    className="premium-btn premium-btn-secondary"
                    style={{ width: '100%' }}
                  >
                    📋 Copy to Ingest Form
                  </button>
                </div>
              </div>
            )}

            {selectedConvTab === 'summary' && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', gap: '0.75rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    onClick={() => handleSummarizeConversation(selectedConversation.id)}
                    className="premium-btn premium-btn-primary"
                    style={{ flex: 1 }}
                    disabled={summarizeLoading}
                  >
                    {summarizeLoading ? (
                      <>
                        {renderSpinner()}
                        Summarizing...
                      </>
                    ) : selectedConversation.summary ? (
                      '🔄 Regenerate Summary'
                    ) : (
                      '✨ Generate Summary'
                    )}
                  </button>
                </div>

                {summarizeError && (
                  <div style={{
                    padding: '0.5rem 0.75rem',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.75rem',
                    border: '1px solid var(--error)',
                    backgroundColor: 'rgba(179, 74, 60, 0.05)',
                    color: 'var(--error)'
                  }}>
                    {summarizeError}
                  </div>
                )}

                <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem', backgroundColor: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.85rem', lineHeight: '1.5' }}>
                  {selectedConversation.summary ? (
                    selectedConversation.summary
                  ) : (
                    <div style={{ textAlign: 'center', opacity: 0.5, padding: '2rem 0' }}>No summary generated yet.</div>
                  )}
                </div>
              </div>
            )}

            {selectedConvTab === 'memories' && (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', gap: '0.75rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    onClick={() => handleExtractMemories(selectedConversation.id)}
                    className="premium-btn premium-btn-primary"
                    style={{ flex: 1 }}
                    disabled={extractLoading}
                  >
                    {extractLoading ? (
                      <>
                        {renderSpinner()}
                        Extracting...
                      </>
                    ) : (
                      '🧠 Extract Memories'
                    )}
                  </button>
                </div>

                {extractError && (
                  <div style={{
                    padding: '0.5rem 0.75rem',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.75rem',
                    border: '1px solid var(--error)',
                    backgroundColor: 'rgba(179, 74, 60, 0.05)',
                    color: 'var(--error)'
                  }}>
                    {extractError}
                  </div>
                )}

                {extractResult && (
                  <div style={{
                    padding: '0.5rem 0.75rem',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.75rem',
                    border: '1px solid var(--success)',
                    backgroundColor: 'rgba(91, 138, 82, 0.05)',
                    color: 'var(--success)'
                  }}>
                    {extractResult.message}
                  </div>
                )}

                <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem', backgroundColor: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {loadingConversationMemories ? (
                    <div style={{ textAlign: 'center', padding: '2rem 0', fontSize: '0.8rem', opacity: 0.6 }}>
                      {renderSpinner()} Loading extracted memories...
                    </div>
                  ) : conversationMemories.length > 0 ? (
                    conversationMemories.map((m, idx) => (
                      <div key={idx} style={{
                        padding: '0.5rem 0.75rem',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)',
                        backgroundColor: 'var(--surface)',
                        fontSize: '0.75rem'
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                          <span className="badge" style={{ backgroundColor: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6', fontSize: '0.65rem', fontWeight: 600 }}>
                            {m.type}
                          </span>
                          <span style={{ fontSize: '0.7rem', opacity: 0.7 }}>
                            Confidence: <strong>{((m.metadata.confidence || 0.9) * 100).toFixed(0)}%</strong>
                          </span>
                        </div>
                        <p style={{ fontWeight: 500, margin: 0, color: 'var(--text)' }}>{m.content}</p>
                      </div>
                    ))
                  ) : (
                    <div style={{ textAlign: 'center', opacity: 0.5, padding: '2rem 0', fontSize: '0.8rem' }}>
                      No memories extracted from this conversation yet.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="footer" style={{ padding: '1.5rem', textAlign: 'center', borderTop: '1px solid var(--border)', fontSize: '0.8rem', opacity: 0.8 }}>
        <div>
          © 2026 Nataraj EL. All Rights Reserved.
        </div>
      </footer>
    </div>
  );
}
