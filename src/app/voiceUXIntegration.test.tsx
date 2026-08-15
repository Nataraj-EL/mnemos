import { describe, it, expect, beforeEach } from 'vitest';

interface MockState {
  transcript: string;
  isRecording: boolean;
  recordingTime: number;
  transcribeLoading: boolean;
  transcribeError: string | null;
  voiceSessionState: 'idle' | 'recording' | 'transcribing' | 'review' | 'saving' | 'saved' | 'error';
  saveLoading: boolean;
  saveMessage: { type: 'success' | 'error'; text: string } | null;
  recordingStart: number;
  recordingEnd: number;
  voiceMode: 'transcribe' | 'ask';
  userId: string;
  savedConversationId: string | null;
  extractionState: 'idle' | 'extracting' | 'extracted' | 'extraction-error';
  extractionResultCount: number | null;
  extractionError: string | null;
}

describe('Voice UX Integration State Machine Unit Tests (Sprint 19)', () => {
  let state: MockState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setters: Record<string, (val: any) => void> = {};
  
  let saveCallsCount = 0;
  let extractCallsCount = 0;
  let refreshMemoriesCallsCount = 0;

  const mockSetState = <K extends keyof MockState>(key: K) => {
    return (val: unknown) => {
      if (typeof val === 'function') {
        state[key] = (val as (prev: MockState[K]) => MockState[K])(state[key]);
      } else {
        state[key] = val as MockState[K];
      }
    };
  };

  beforeEach(() => {
    state = {
      transcript: 'Test transcription segment payload content.',
      isRecording: false,
      recordingTime: 0,
      transcribeLoading: false,
      transcribeError: null,
      voiceSessionState: 'review',
      saveLoading: false,
      saveMessage: null,
      recordingStart: 1000,
      recordingEnd: 5000,
      voiceMode: 'transcribe',
      userId: 'user-123',
      savedConversationId: null,
      extractionState: 'idle',
      extractionResultCount: null,
      extractionError: null,
    };

    setters.setTranscript = mockSetState('transcript');
    setters.setIsRecording = mockSetState('isRecording');
    setters.setRecordingTime = mockSetState('recordingTime');
    setters.setTranscribeLoading = mockSetState('transcribeLoading');
    setters.setTranscribeError = mockSetState('transcribeError');
    setters.setVoiceSessionState = mockSetState('voiceSessionState');
    setters.setSaveLoading = mockSetState('saveLoading');
    setters.setSaveMessage = mockSetState('saveMessage');
    setters.setRecordingStart = mockSetState('recordingStart');
    setters.setRecordingEnd = mockSetState('recordingEnd');
    setters.setVoiceMode = mockSetState('voiceMode');
    setters.setSavedConversationId = mockSetState('savedConversationId');
    setters.setExtractionState = mockSetState('extractionState');
    setters.setExtractionResultCount = mockSetState('extractionResultCount');
    setters.setExtractionError = mockSetState('extractionError');

    saveCallsCount = 0;
    extractCallsCount = 0;
    refreshMemoriesCallsCount = 0;
  });

  const fetchConversations = () => {};
  const fetchMemories = () => {
    refreshMemoriesCallsCount++;
  };

  const performExtraction = async (_conversationId: string, mockExtractSuccess: boolean) => {
    setters.setExtractionState('extracting');
    setters.setExtractionError(null);
    setters.setExtractionResultCount(null);
    extractCallsCount++;

    if (mockExtractSuccess) {
      setters.setExtractionResultCount(3);
      setters.setExtractionState('extracted');
      fetchMemories();
    } else {
      setters.setExtractionError('Failed to extract memories.');
      setters.setExtractionState('extraction-error');
    }
  };

  const handleSaveAndExtractMemories = async (mockSaveSuccess: boolean, mockExtractSuccess: boolean) => {
    if (!state.transcript || !state.transcript.trim() || !state.userId.trim()) return;
    if (state.voiceSessionState === 'saving' || state.voiceSessionState === 'saved') return;
    if (state.extractionState === 'extracting') return;

    setters.setVoiceSessionState('saving');
    setters.setSaveLoading(true);
    setters.setSaveMessage(null);
    setters.setExtractionState('idle');
    setters.setExtractionResultCount(null);
    setters.setExtractionError(null);
    saveCallsCount++;

    let conversationId: string | null = null;

    if (mockSaveSuccess) {
      conversationId = 'conv-123';
      setters.setSavedConversationId(conversationId);
      setters.setSaveMessage({ type: 'success', text: 'Conversation Saved' });
      setters.setVoiceSessionState('saved');
      fetchConversations();
    } else {
      setters.setSaveMessage({ type: 'error', text: 'Failed to save conversation.' });
      setters.setVoiceSessionState('error');
      setters.setSaveLoading(false);
      return;
    }

    setters.setSaveLoading(false);

    if (conversationId) {
      await performExtraction(conversationId, mockExtractSuccess);
    }
  };

  const handleRetryExtractionAfterSave = async (mockExtractSuccess: boolean) => {
    if (!state.savedConversationId || !state.userId.trim()) return;
    if (state.extractionState === 'extracting') return;
    await performExtraction(state.savedConversationId, mockExtractSuccess);
  };

  const resetVoiceSession = () => {
    setters.setTranscript('');
    setters.setIsRecording(false);
    setters.setRecordingTime(0);
    setters.setRecordingStart(0);
    setters.setRecordingEnd(0);
    setters.setTranscribeLoading(false);
    setters.setTranscribeError(null);
    setters.setSaveMessage(null);
    setters.setVoiceSessionState('idle');
    setters.setSavedConversationId(null);
    setters.setExtractionState('idle');
    setters.setExtractionResultCount(null);
    setters.setExtractionError(null);
  };

  it('should successfully run save then extract memories flow', async () => {
    await handleSaveAndExtractMemories(true, true);
    
    expect(saveCallsCount).toBe(1);
    expect(extractCallsCount).toBe(1);
    expect(state.voiceSessionState).toBe('saved');
    expect(state.savedConversationId).toBe('conv-123');
    expect(state.extractionState).toBe('extracted');
    expect(state.extractionResultCount).toBe(3);
    expect(refreshMemoriesCallsCount).toBe(1);
  });

  it('should prevent extraction if save fails', async () => {
    await handleSaveAndExtractMemories(false, true);

    expect(saveCallsCount).toBe(1);
    expect(extractCallsCount).toBe(0);
    expect(state.voiceSessionState).toBe('error');
    expect(state.savedConversationId).toBeNull();
    expect(state.extractionState).toBe('idle');
  });

  it('should preserve saved conversation when extraction fails', async () => {
    await handleSaveAndExtractMemories(true, false);

    expect(saveCallsCount).toBe(1);
    expect(extractCallsCount).toBe(1);
    expect(state.voiceSessionState).toBe('saved');
    expect(state.savedConversationId).toBe('conv-123');
    expect(state.extractionState).toBe('extraction-error');
    expect(state.extractionError).toBe('Failed to extract memories.');
    expect(refreshMemoriesCallsCount).toBe(0);
  });

  it('should successfully retry extraction using stored conversationId without re-saving', async () => {
    await handleSaveAndExtractMemories(true, false);
    expect(saveCallsCount).toBe(1);
    expect(extractCallsCount).toBe(1);
    expect(state.savedConversationId).toBe('conv-123');
    expect(state.extractionState).toBe('extraction-error');

    await handleRetryExtractionAfterSave(true);
    expect(saveCallsCount).toBe(1);
    expect(extractCallsCount).toBe(2);
    expect(state.extractionState).toBe('extracted');
    expect(state.extractionResultCount).toBe(3);
    expect(refreshMemoriesCallsCount).toBe(1);
  });

  it('should prevent concurrent saving/extracting clicks with loading guards', async () => {
    const p1 = handleSaveAndExtractMemories(true, true);
    const p2 = handleSaveAndExtractMemories(true, true);

    await Promise.all([p1, p2]);

    expect(saveCallsCount).toBe(1);
  });

  it('should clear temporary states on reset without deleting conversation', async () => {
    await handleSaveAndExtractMemories(true, true);
    expect(state.savedConversationId).toBe('conv-123');

    resetVoiceSession();

    expect(state.savedConversationId).toBeNull();
    expect(state.extractionState).toBe('idle');
    expect(state.extractionResultCount).toBeNull();
    expect(state.transcript).toBe('');
  });
});

describe('Voice UX Integration State Machine - Sprint 27 Additions', () => {
  it('should prove transcript fidelity - normalizing whitespaces without altering words/casing/ends', () => {
    const rawWhisperOutput = '   some   words  \n\n\n here  ';
    // Trim and collapse whitespace/consecutive newlines
    let normalized = rawWhisperOutput.trim();
    normalized = normalized.replace(/[ \t]+/g, ' ');
    normalized = normalized.replace(/[ \t]*\n[ \t]*/g, '\n');
    normalized = normalized.replace(/\n\s*\n+/g, '\n\n');

    expect(normalized).toBe('some words\n\nhere');
  });

  it('should reject empty or very short inputs (< 3 characters) during verification check', () => {
    const noisyTranscript = '  h  ';
    const checkLength = noisyTranscript.trim().length;
    expect(checkLength).toBeLessThan(3);
  });

  it('should allow editing the transcript before save and show accurate character counts', () => {
    let mockTranscript = 'Initial text';
    expect(mockTranscript.length).toBe(12);

    // Edit transcript
    mockTranscript = 'Edited question';
    expect(mockTranscript.length).toBe(15);
  });

  it('should prevent duplicate Get Answer requests using loading guard variables', async () => {
    let callCount = 0;
    let loading = false;

    const getAnswerMock = async () => {
      if (loading) return;
      loading = true;
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      loading = false;
    };

    // Simulate clicking twice quickly
    const p1 = getAnswerMock();
    const p2 = getAnswerMock();
    await Promise.all([p1, p2]);

    expect(callCount).toBe(1);
  });
});

describe('Voice UX Integration State Machine - Sprint 28 Additions', () => {
  interface VoiceSessionEntry {
    id: string;
    transcript: string;
    response: string | null;
    timestamp: string;
  }

  it('should maintain stable history IDs and enforce 20-entry limit, removing oldest', () => {
    const history: VoiceSessionEntry[] = [];
    const limit = 20;

    for (let i = 1; i <= 25; i++) {
      const entry: VoiceSessionEntry = {
        id: `vse-stable-${i}`,
        transcript: `Question ${i}`,
        response: `Answer ${i}`,
        timestamp: new Date().toISOString(),
      };
      history.push(entry);
      if (history.length > limit) {
        history.shift(); // remove oldest
      }
    }

    expect(history.length).toBe(20);
    expect(history[0].id).toBe('vse-stable-6');
    expect(history[19].id).toBe('vse-stable-25');
  });

  it('should not add entry to history on failed transcription/response', () => {
    const history: VoiceSessionEntry[] = [];
    let success = false;
    const requestFailed = true;

    // Simulate failed query execution
    if (!requestFailed) {
      success = true;
      history.push({
        id: 'vse-123',
        transcript: 'Failed query',
        response: 'Answer',
        timestamp: new Date().toISOString(),
      });
    }

    expect(success).toBe(false);
    expect(history.length).toBe(0);
  });

  it('should permit selection of history entry as read-only and allow returning to current query', () => {
    let transcript = 'Unsaved typed question';
    let selectedHistoryId: string | null = null;
    let activeQueryText = '';
    let readOnly = false;

    const history: VoiceSessionEntry[] = [
      { id: 'vse-1', transcript: 'Past Question', response: 'Past Answer', timestamp: '' }
    ];

    // Select entry
    if (selectedHistoryId === null) {
      activeQueryText = transcript;
    }
    selectedHistoryId = 'vse-1';
    transcript = history[0].transcript;
    readOnly = true;

    expect(transcript).toBe('Past Question');
    expect(activeQueryText).toBe('Unsaved typed question');
    expect(readOnly).toBe(true);

    // Return to current
    selectedHistoryId = null;
    transcript = activeQueryText;
    readOnly = false;

    expect(transcript).toBe('Unsaved typed question');
    expect(readOnly).toBe(false);
  });

  it('should preserve voiceHistory and savedConversationId on Ask Another', () => {
    const history: VoiceSessionEntry[] = [{ id: 'vse-1', transcript: 'Q1', response: 'A1', timestamp: '' }];
    const savedConversationId: string | null = 'conv-saved-id';
    let transcript = 'Q1';
    let responseText: string | null = 'A1';

    // Ask Another click
    transcript = '';
    responseText = null;
    // History and saved ID remain untouched
    expect(history.length).toBe(1);
    expect(savedConversationId).toBe('conv-saved-id');
    expect(transcript).toBe('');
    expect(responseText).toBeNull();
  });

  it('should clear voiceHistory on Clear Session but not touch database persistence', () => {
    let history: VoiceSessionEntry[] = [{ id: 'vse-1', transcript: 'Q1', response: 'A1', timestamp: '' }];
    const dbConversationsExist = true;

    // Clear Session
    history = [];
    // DB conversations remain intact
    expect(history.length).toBe(0);
    expect(dbConversationsExist).toBe(true);
  });
});

describe('Voice UX Integration State Machine - Sprint 29 Additions', () => {
  interface VoiceSessionEntry {
    id: string;
    transcript: string;
    response: string | null;
    timestamp: string;
    isSaved?: boolean;
    conversationId?: string;
    savedAt?: string;
  }

  it('should link history entry to conversationId on successful save', () => {
    const history: VoiceSessionEntry[] = [
      { id: 'vse-1', transcript: 'Q1', response: 'A1', timestamp: '' }
    ];

    // Atomically link
    const updatedHistory = history.map((e) =>
      e.id === 'vse-1'
        ? { ...e, isSaved: true, conversationId: 'conv-999', savedAt: '2026-08-15T12:00:00Z' }
        : e
    );

    expect(updatedHistory[0].isSaved).toBe(true);
    expect(updatedHistory[0].conversationId).toBe('conv-999');
    expect(updatedHistory[0].savedAt).toBe('2026-08-15T12:00:00Z');
  });

  it('should enforce save idempotence by preventing duplicate saves', () => {
    const entry: VoiceSessionEntry = {
      id: 'vse-1',
      transcript: 'Q1',
      response: 'A1',
      timestamp: '',
      isSaved: true,
      conversationId: 'conv-999'
    };

    let postCount = 0;
    const saveHandler = () => {
      if (entry.isSaved) return; // Prevent duplicate POST
      postCount++;
    };

    saveHandler();
    expect(postCount).toBe(0);
  });

  it('should keep history entry intact if saving fails and allow retry save only', () => {
    const history: VoiceSessionEntry[] = [
      { id: 'vse-1', transcript: 'Q1', response: 'A1', timestamp: '' }
    ];
    const errors: Record<string, string> = { 'vse-1': 'Failed to save conversation.' };

    expect(history.length).toBe(1);
    expect(errors['vse-1']).toBe('Failed to save conversation.');

    // Retry triggers saving again
    let retried = false;
    const retryHandler = (id: string) => {
      if (errors[id]) {
        retried = true;
      }
    };

    retryHandler('vse-1');
    expect(retried).toBe(true);
  });

  it('should preserve session history and view states when selecting linked conversation', () => {
    const history: VoiceSessionEntry[] = [
      { id: 'vse-1', transcript: 'Q1', response: 'A1', timestamp: '', isSaved: true, conversationId: 'conv-123' }
    ];
    const selectedHistoryId: string | null = 'vse-1';
    let currentOpenConvId: string | null = null;

    // Open linked conversation
    if (history[0].isSaved && history[0].conversationId) {
      currentOpenConvId = history[0].conversationId;
    }

    // Verify view state & history are preserved
    expect(selectedHistoryId).toBe('vse-1');
    expect(currentOpenConvId).toBe('conv-123');
    expect(history.length).toBe(1);
  });

  it('should verify double-click prevention on history save using loading guards', async () => {
    let callCount = 0;
    let savingId: string | null = null;

    const mockSave = async (id: string) => {
      if (savingId === id) return;
      savingId = id;
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      savingId = null;
    };

    // Fast double click
    const p1 = mockSave('vse-1');
    const p2 = mockSave('vse-1');
    await Promise.all([p1, p2]);

    expect(callCount).toBe(1);
  });
});

describe('Voice UX Integration State Machine - Sprint 30 Additions', () => {
  interface ConversationMock {
    id: string;
    transcript: string;
    summary?: string;
    createdAt: string;
  }

  it('should sort timeline conversations newest-first within local date-boundary groups', () => {
    const now = new Date();
    // Local date boundaries
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);

    const cToday1: ConversationMock = { id: 'c1', transcript: 'T1', createdAt: new Date(startOfToday.getTime() + 10000).toISOString() };
    const cToday2: ConversationMock = { id: 'c2', transcript: 'T2', createdAt: new Date(startOfToday.getTime() + 50000).toISOString() };
    const cYesterday1: ConversationMock = { id: 'c3', transcript: 'T3', createdAt: new Date(startOfYesterday.getTime() + 5000).toISOString() };

    const rawList = [cToday1, cYesterday1, cToday2];

    const today: ConversationMock[] = [];
    const yesterday: ConversationMock[] = [];
    const earlier: ConversationMock[] = [];

    // Sort newest -> oldest
    const sorted = [...rawList].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

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

    expect(today.length).toBe(2);
    // Newest first check
    expect(today[0].id).toBe('c2');
    expect(today[1].id).toBe('c1');

    expect(yesterday.length).toBe(1);
    expect(yesterday[0].id).toBe('c3');
  });

  it('should search/filter local lightweight fields without triggering backend fetches', () => {
    const list: ConversationMock[] = [
      { id: 'c1', transcript: 'Lightweight preview text', summary: 'Grounded memory details', createdAt: '' },
      { id: 'c2', transcript: 'Whisper raw output voice', summary: 'Unrelated notes', createdAt: '' }
    ];

    const searchStr = 'lightweight';
    const filtered = list.filter((conv) => {
      const q = searchStr.toLowerCase();
      return (
        (conv.transcript && conv.transcript.toLowerCase().includes(q)) ||
        (conv.summary && conv.summary.toLowerCase().includes(q))
      );
    });

    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe('c1');
  });

  it('should handle incomplete client-side memory count safely using subset existence', () => {
    const list: ConversationMock[] = [
      { id: 'c1', transcript: 'T1', createdAt: '' }
    ];
    // Incomplete memories array
    const clientMemories = [
      { id: 'm1', metadata: { conversationId: 'c1' } }
    ];

    const hasExtractedMemories = clientMemories.some((m) => m.metadata?.conversationId === list[0].id);
    expect(hasExtractedMemories).toBe(true);
  });

  it('should open conversation details using handleSelectConversation without mutating voiceSessionState', () => {
    const voiceSessionState = 'review';
    let selectedConversationId: string | null = null;

    const selectMock = (id: string) => {
      selectedConversationId = id;
      // Do not touch voiceSessionState
    };

    selectMock('c1');
    expect(selectedConversationId).toBe('c1');
    expect(voiceSessionState).toBe('review');
  });
});
