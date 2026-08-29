/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalWhisperTranscriptionProvider } from './localWhisperTranscription';
import { POST as transcribePOST } from '@/app/api/v1/voice/transcribe/route';
import { POST as respondPOST } from '@/app/api/v1/voice/respond/route';
import { GeminiResponseGenerator } from '@/response/geminiGenerator';
import * as fs from 'fs';

// Mock child_process spawn
vi.mock('child_process', () => {
  return {
    spawn: vi.fn(),
  };
});

// Mock fs module
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// Mock Database Pool
const mockQuery = vi.fn();
vi.mock('@/db', () => ({
  getDbPool: vi.fn(() => ({
    query: mockQuery,
  })),
}));

// Mock Ingestion extraction & embeddings
const mockReconcile = vi.fn();
vi.mock('@/memory/geminiExtractor', () => {
  return {
    GeminiMemoryExtractor: vi.fn().mockImplementation(function () {
      return { reconcile: mockReconcile };
    }),
  };
});

const mockGenerateEmbedding = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
vi.mock('@/memory/geminiEmbedding', () => {
  return {
    GeminiEmbeddingProvider: vi.fn().mockImplementation(function () {
      return { generateEmbedding: mockGenerateEmbedding };
    }),
  };
});

describe('Multilingual and Hindi Voice Support Tests', () => {
  let mockFetch: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    mockReconcile.mockReset();
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    
    // Default mock environment variables
    process.env.MNEMOS_AUTH_ENABLED = 'false';
    process.env.WHISPER_PROVIDER = 'local';
    
    // Setup dynamic fetch mock
    mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/health')) {
        return {
          ok: true,
          json: async () => ({ status: 'ready', device: 'cpu', compute: 'int8' }),
        };
      }
      if (url.includes('/transcribe')) {
        return {
          ok: true,
          json: async () => ({
            text: 'मुझे आम खाना बहुत पसंद है।',
            duration: 2.8,
            language: 'hi',
            device: 'cpu',
            compute: 'int8',
            latency_ms: 150,
          }),
        };
      }
      return { ok: false, status: 404 };
    });
    vi.stubGlobal('fetch', mockFetch);

    // Setup dynamic DB query mock
    mockQuery.mockImplementation(async (sql: any, params: any[]) => {
      const sqlStr = typeof sql === 'string' ? sql : (sql?.text || '');
      
      if (sqlStr.includes('INSERT INTO memories')) {
        return {
          rows: [
            {
              id: 'mem-999',
              userId: params[0],
              type: params[1],
              content: params[2],
              metadata: typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3],
            }
          ]
        };
      }
      
      if (sqlStr.includes('UPDATE memories')) {
        return {
          rows: [
            {
              id: 'mem-999',
              userId: 'user-hindi',
              type: 'PREFERENCE',
              content: 'उपयोगकर्ता को आम खाना बहुत पसंद है',
              metadata: { source: 'voice', type: 'conversation', confidence: 0.98, status: 'active' },
            }
          ]
        };
      }

      if (sqlStr.includes('SELECT') && sqlStr.includes('memories') && (sqlStr.includes('similarity') || sqlStr.includes('<=>'))) {
        return {
          rows: [
            {
              id: 'mem-999',
              userId: 'user-hindi',
              type: 'PREFERENCE',
              content: 'उपयोगकर्ता को आम खाना बहुत पसंद है',
              metadata: { source: 'voice', type: 'conversation', confidence: 0.98, status: 'active' },
              similarity: 0.89,
            }
          ]
        };
      }

      if (sqlStr.includes('SELECT') && sqlStr.includes('memories')) {
        return { rows: [] };
      }

      return { rows: [] };
    });

    // Mock existence of local python files
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (typeof p === 'string' && (p.includes('python3') || p.includes('transcription_server.py') || p.includes('.whisper_secret'))) {
        return true;
      }
      return false;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('1. Multilingual Model Configuration', () => {
    it('should default to multilingual tiny model when LOCAL_WHISPER_MODEL is not set', () => {
      delete process.env.LOCAL_WHISPER_MODEL;
      LocalWhisperTranscriptionProvider.resetDaemonState();
      const provider = new LocalWhisperTranscriptionProvider();
      expect(provider['modelName']).toBe('tiny');
    });

    it('should respect custom model configured in LOCAL_WHISPER_MODEL', () => {
      process.env.LOCAL_WHISPER_MODEL = 'base';
      LocalWhisperTranscriptionProvider.resetDaemonState();
      const provider = new LocalWhisperTranscriptionProvider();
      expect(provider['modelName']).toBe('base');
    });
  });

  describe('2. Hindi & English Transcription Path', () => {
    it('should correctly transcribe Hindi and return language metadata as hi', async () => {
      LocalWhisperTranscriptionProvider.resetDaemonState();
      const provider = new LocalWhisperTranscriptionProvider();

      vi.mocked(fs.readFileSync).mockReturnValue('mocked-secret');

      const result = await provider.transcribe(Buffer.from('dummy-audio'), 'audio/wav');
      expect(result.text).toBe('मुझे आम खाना बहुत पसंद है।');
      expect(result.metadata?.language).toBe('hi');
    });

    it('should correctly transcribe English and return language metadata as en', async () => {
      LocalWhisperTranscriptionProvider.resetDaemonState();
      const provider = new LocalWhisperTranscriptionProvider();

      vi.mocked(fs.readFileSync).mockReturnValue('mocked-secret');

      mockFetch.mockImplementationOnce(async (url: string) => {
        if (url.includes('/health')) {
          return {
            ok: true,
            json: async () => ({ status: 'ready', device: 'cpu', compute: 'int8' }),
          };
        }
        return { ok: false, status: 404 };
      }).mockImplementationOnce(async (url: string) => {
        if (url.includes('/transcribe')) {
          return {
            ok: true,
            json: async () => ({
              text: 'I love drinking tea.',
              duration: 2.1,
              language: 'en',
              device: 'cpu',
              compute: 'int8',
              latency_ms: 120,
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const result = await provider.transcribe(Buffer.from('dummy-audio'), 'audio/wav');
      expect(result.text).toBe('I love drinking tea.');
      expect(result.metadata?.language).toBe('en');
    });
  });

  describe('3. Ingestion and Retrieval of Hindi Voice Memories', () => {
    it('should process Hindi voice transcription through memory ingestion pipeline', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('mocked-secret');

      // 3. Extractor reconcile mock
      mockReconcile.mockResolvedValueOnce([
        {
          action: 'CREATE',
          type: 'PREFERENCE',
          content: 'उपयोगकर्ता को आम खाना बहुत पसंद है',
          confidence: 0.98,
          importance: 5,
        },
      ]);

      const formData = new FormData();
      const blob = new Blob([Buffer.from('audio')], { type: 'audio/wav' });
      formData.append('file', blob);
      formData.append('userId', 'user-hindi');

      const request = new Request('http://localhost/api/v1/voice/transcribe', {
        method: 'POST',
        body: formData,
      });

      const response = await transcribePOST(request);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.status).toBe('success');
      expect(json.data.text).toBe('मुझे आम खाना बहुत पसंद है।');
      expect(json.data.saved).toBe(true);
      expect(json.data.metadata.language).toBe('hi');
      expect(json.data.memories[0].content).toBe('उपयोगकर्ता को आम खाना बहुत पसंद है');
    });

    it('should query existing memories in Hindi and respond naturally in Hindi', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('mocked-secret');

      // Setup dynamic fetch mock for respond path
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/health')) {
          return {
            ok: true,
            json: async () => ({ status: 'ready', device: 'cpu', compute: 'int8' }),
          };
        }
        if (url.includes('/transcribe')) {
          return {
            ok: true,
            json: async () => ({
              text: 'मुझे क्या खाना पसंद है?',
              duration: 2.1,
              language: 'hi',
              device: 'cpu',
              compute: 'int8',
              latency_ms: 110,
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      // Extractor check for query should return empty
      mockReconcile.mockResolvedValueOnce([]);

      // Mock Gemini response generator
      const mockGenerateResponse = vi.spyOn(GeminiResponseGenerator.prototype, 'generateResponse');
      mockGenerateResponse.mockResolvedValueOnce({
        text: 'आपकी यादों के अनुसार, आपको आम खाना बहुत पसंद है।',
      });

      const formData = new FormData();
      const blob = new Blob([Buffer.from('audio')], { type: 'audio/wav' });
      formData.append('file', blob);
      formData.append('userId', 'user-hindi');

      const request = new Request('http://localhost/api/v1/voice/respond', {
        method: 'POST',
        body: formData,
      });

      const response = await respondPOST(request);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.status).toBe('success');
      expect(json.data.transcript).toBe('मुझे क्या खाना पसंद है?');
      expect(json.data.response).toBe('आपकी यादों के अनुसार, आपको आम खाना बहुत पसंद है।');
      expect(json.data.usedMemories).toHaveLength(1);
      expect(json.data.usedMemories[0].id).toBe('mem-999');
    });
  });
});
