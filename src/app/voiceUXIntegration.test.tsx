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
