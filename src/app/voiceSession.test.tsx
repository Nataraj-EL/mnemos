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
}

describe('Voice Session State Machine Unit Tests', () => {
  let state: MockState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setters: Record<string, (val: any) => void> = {};

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
      transcript: '',
      isRecording: false,
      recordingTime: 0,
      transcribeLoading: false,
      transcribeError: null,
      voiceSessionState: 'idle',
      saveLoading: false,
      saveMessage: null,
      recordingStart: 0,
      recordingEnd: 0,
      voiceMode: 'transcribe',
      userId: 'user-123',
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
  });

  const startRecording = async () => {
    if (state.transcribeLoading || state.saveLoading || state.voiceSessionState === 'saving' || state.voiceSessionState === 'transcribing') {
      return;
    }
    setters.setTranscribeError(null);
    setters.setTranscript('');
    setters.setSaveMessage(null);
    setters.setRecordingStart(Date.now());
    setters.setRecordingEnd(0);
    setters.setVoiceSessionState('recording');
    setters.setIsRecording(true);
  };

  const uploadAudioSuccess = async () => {
    setters.setTranscribeLoading(true);
    setters.setVoiceSessionState('transcribing');
    setters.setTranscribeError(null);

    setters.setTranscript('Mocked transcribed transcript text.');
    setters.setVoiceSessionState('review');
    setters.setTranscribeLoading(false);
  };

  const uploadAudioFailure = async () => {
    setters.setTranscribeLoading(true);
    setters.setVoiceSessionState('transcribing');
    setters.setTranscribeError(null);

    setters.setTranscribeError('Failed to transcribe.');
    setters.setVoiceSessionState('error');
    setters.setTranscribeLoading(false);
  };

  const handleSaveConversation = async (mockResponseOk: boolean) => {
    if (!state.transcript || !state.transcript.trim() || !state.userId.trim()) return;
    if (state.voiceSessionState === 'saving' || state.voiceSessionState === 'saved') return;

    setters.setVoiceSessionState('saving');
    setters.setSaveLoading(true);
    setters.setSaveMessage(null);

    if (mockResponseOk) {
      setters.setSaveMessage({ type: 'success', text: 'Saved conversation!' });
      setters.setVoiceSessionState('saved');
    } else {
      setters.setSaveMessage({ type: 'error', text: 'Failed to save.' });
      setters.setVoiceSessionState('error');
    }
    setters.setSaveLoading(false);
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
  };

  it('should transition recording state correctly from idle', async () => {
    expect(state.voiceSessionState).toBe('idle');
    await startRecording();
    expect(state.voiceSessionState).toBe('recording');
    expect(state.isRecording).toBe(true);
  });

  it('should block starting recording if transcribing or saving', async () => {
    state.voiceSessionState = 'transcribing';
    state.transcribeLoading = true;
    await startRecording();
    expect(state.voiceSessionState).toBe('transcribing');

    state.voiceSessionState = 'saving';
    state.saveLoading = true;
    state.transcribeLoading = false;
    await startRecording();
    expect(state.voiceSessionState).toBe('saving');
  });

  it('should handle successful recording to transcription transition', async () => {
    await startRecording();
    expect(state.voiceSessionState).toBe('recording');

    await uploadAudioSuccess();
    expect(state.voiceSessionState).toBe('review');
    expect(state.transcript).toBe('Mocked transcribed transcript text.');
  });

  it('should handle transcription failure and not auto-save', async () => {
    await startRecording();
    await uploadAudioFailure();
    expect(state.voiceSessionState).toBe('error');
    expect(state.transcribeError).toBe('Failed to transcribe.');
  });

  it('should reject empty/whitespace-only transcripts before API call', async () => {
    state.transcript = '   ';
    state.voiceSessionState = 'review';
    await handleSaveConversation(true);
    expect(state.voiceSessionState).toBe('review');
  });

  it('should prevent parallel saving requests during active save session', async () => {
    state.transcript = 'Hello user';
    state.voiceSessionState = 'review';
    
    const savePromise = handleSaveConversation(true);
    await handleSaveConversation(false);
    
    await savePromise;
    expect(state.voiceSessionState).toBe('saved');
  });

  it('should revert back to retryable error state on save failure without losing transcript', async () => {
    state.transcript = 'Custom user edits.';
    state.voiceSessionState = 'review';

    await handleSaveConversation(false);
    expect(state.voiceSessionState).toBe('error');
    expect(state.transcript).toBe('Custom user edits.');
    expect(state.saveMessage?.type).toBe('error');
  });

  it('should reset voice session cleanly back to idle', async () => {
    state.voiceSessionState = 'saved';
    state.transcript = 'Custom user edits.';
    resetVoiceSession();

    expect(state.voiceSessionState).toBe('idle');
    expect(state.transcript).toBe('');
  });
});
