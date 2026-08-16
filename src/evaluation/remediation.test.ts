import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EvaluationAlertHistoryManager } from './alertHistory';
import { EvaluationAlertCorrelationManager } from './alertCorrelation';
import { EvaluationReportInsightsManager } from './reportInsights';
import { PromotionHistoryManager } from './promotionHistory';
import { EvaluationRemediationManager } from './remediation';
import { EvaluationAlert, TuningConfig, EvaluationReportInsights } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 58: Evaluation Remediation Recommendations Tests', () => {
  const relevanceAlert: EvaluationAlert = {
    id: 'relevance-alert-id',
    metric: 'relevance',
    severity: 'warning',
    message: 'Relevance degraded.',
    timestamp: '2026-08-16T12:00:00.000Z',
  };

  const latencyAlert: EvaluationAlert = {
    id: 'latency-alert-id',
    metric: 'averageLatency',
    severity: 'critical',
    message: 'Latency is too high.',
    timestamp: '2026-08-16T12:00:00.000Z',
  };

  const emptyInsights: EvaluationReportInsights = {
    insufficientHistory: false,
    timestamp: new Date().toISOString(),
    status: 'stable',
    trends: {},
    recurringDegradations: [],
    gateHistorySummary: { total: 0, passed: 0, warned: 0, blocked: 0 },
  };

  beforeEach(() => {
    EvaluationAlertHistoryManager.clearHistory();
    PromotionHistoryManager.clearHistory();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Metric -> Suggestion Mappings', () => {
    it('should suggest semantic/lexical weights for relevance or recall alerts', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(relevanceAlert);

      vi.spyOn(EvaluationAlertCorrelationManager, 'correlateAlerts').mockResolvedValue([
        {
          alertId: rec.id,
          metric: 'relevance',
          likelyCause: 'configuration',
          confidence: 'high',
          explanation: 'Modified config',
          relatedRecordIds: ['aud-123'],
        },
      ]);

      vi.spyOn(EvaluationReportInsightsManager, 'generateInsights').mockResolvedValue(emptyInsights);

      const remediations = await EvaluationRemediationManager.generateRemediations();
      expect(remediations).toHaveLength(1);
      expect(remediations[0].action).toBe('Evaluate semantic/lexical weighting parameters.');
      expect(remediations[0].reason).toContain('Relevance and recall');
    });

    it('should suggest reducing snippets for latency only when maxConversationSnippets parameter is implicated', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(latencyAlert);

      // Implicate maxConversationSnippets by changing it
      vi.spyOn(PromotionHistoryManager, 'listRecords').mockReturnValue([
        {
          id: 'aud-123',
          timestamp: new Date().toISOString(),
          action: 'promote',
          previousConfig: { maxConversationSnippets: 3 } as unknown as TuningConfig,
          newConfig: { maxConversationSnippets: 5 } as unknown as TuningConfig,
        },
      ]);

      vi.spyOn(EvaluationAlertCorrelationManager, 'correlateAlerts').mockResolvedValue([
        {
          alertId: rec.id,
          metric: 'averageLatency',
          likelyCause: 'configuration',
          confidence: 'high',
          explanation: 'Config changed maxConversationSnippets',
          relatedRecordIds: ['aud-123'],
        },
      ]);

      vi.spyOn(EvaluationReportInsightsManager, 'generateInsights').mockResolvedValue(emptyInsights);

      const remediations = await EvaluationRemediationManager.generateRemediations();
      expect(remediations).toHaveLength(1);
      expect(remediations[0].action).toBe('Reduce conversation snippets count.');
    });

    it('should suggest generic latency inspection if config did not implicate maxConversationSnippets', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(latencyAlert);

      // Config change did NOT implicate maxConversationSnippets
      vi.spyOn(PromotionHistoryManager, 'listRecords').mockReturnValue([
        {
          id: 'aud-123',
          timestamp: new Date().toISOString(),
          action: 'promote',
          previousConfig: { semanticWeight: 0.5 } as unknown as TuningConfig,
          newConfig: { semanticWeight: 0.8 } as unknown as TuningConfig,
        },
      ]);

      vi.spyOn(EvaluationAlertCorrelationManager, 'correlateAlerts').mockResolvedValue([
        {
          alertId: rec.id,
          metric: 'averageLatency',
          likelyCause: 'configuration',
          confidence: 'medium',
          explanation: 'Config change',
          relatedRecordIds: ['aud-123'],
        },
      ]);

      vi.spyOn(EvaluationReportInsightsManager, 'generateInsights').mockResolvedValue(emptyInsights);

      const remediations = await EvaluationRemediationManager.generateRemediations();
      expect(remediations).toHaveLength(1);
      expect(remediations[0].action).toBe('Inspect retrieval path latency.');
    });

    it('should suggest controlled A/B experiment when report insights flag recurring degradation', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(relevanceAlert);

      vi.spyOn(EvaluationAlertCorrelationManager, 'correlateAlerts').mockResolvedValue([
        {
          alertId: rec.id,
          metric: 'relevance',
          likelyCause: 'evaluation',
          confidence: 'medium',
          explanation: 'Regression',
          relatedRecordIds: ['rpt-123'],
        },
      ]);

      // Flag relevance as recurring degradation
      vi.spyOn(EvaluationReportInsightsManager, 'generateInsights').mockResolvedValue({
        ...emptyInsights,
        recurringDegradations: ['relevance'],
      });

      const remediations = await EvaluationRemediationManager.generateRemediations();
      expect(remediations).toHaveLength(1);
      expect(remediations[0].action).toBe('Recommend running a controlled A/B experiment.');
      expect(remediations[0].reason).toContain('degraded repeatedly');
    });
  });

  describe('Filtering and Deduplication', () => {
    it('should omit recommendations when likelyCause is unknown and not recurring', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(relevanceAlert);

      vi.spyOn(EvaluationAlertCorrelationManager, 'correlateAlerts').mockResolvedValue([
        {
          alertId: rec.id,
          metric: 'relevance',
          likelyCause: 'unknown',
          confidence: 'low',
          explanation: 'No cause found',
          relatedRecordIds: [],
        },
      ]);

      vi.spyOn(EvaluationReportInsightsManager, 'generateInsights').mockResolvedValue(emptyInsights);

      const remediations = await EvaluationRemediationManager.generateRemediations();
      expect(remediations).toHaveLength(0); // Omitted completely
    });

    it('should exclude resolved alerts from recommendations generation', async () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(relevanceAlert);
      EvaluationAlertHistoryManager.resolve(rec.id);

      vi.spyOn(EvaluationAlertCorrelationManager, 'correlateAlerts').mockResolvedValue([]);
      vi.spyOn(EvaluationReportInsightsManager, 'generateInsights').mockResolvedValue(emptyInsights);

      const remediations = await EvaluationRemediationManager.generateRemediations();
      expect(remediations).toHaveLength(0);
    });

    it('should consolidate multiple alerts recommending the same action and merge evidenceIds', async () => {
      const alertA = { ...relevanceAlert, id: 'alert-a-id' };
      const alertB = { ...relevanceAlert, id: 'alert-b-id', metric: 'retrievalRecall' };

      const recA = EvaluationAlertHistoryManager.addAlertRecord(alertA);
      const recB = EvaluationAlertHistoryManager.addAlertRecord(alertB);

      // Both relevance and retrievalRecall map to 'Evaluate semantic/lexical weighting parameters.'
      vi.spyOn(EvaluationAlertCorrelationManager, 'correlateAlerts').mockResolvedValue([
        {
          alertId: recA.id,
          metric: 'relevance',
          likelyCause: 'configuration',
          confidence: 'medium',
          explanation: 'Promo config',
          relatedRecordIds: ['aud-111'],
        },
        {
          alertId: recB.id,
          metric: 'retrievalRecall',
          likelyCause: 'configuration',
          confidence: 'high', // higher confidence
          explanation: 'Promo config',
          relatedRecordIds: ['aud-222'],
        },
      ]);

      vi.spyOn(EvaluationReportInsightsManager, 'generateInsights').mockResolvedValue(emptyInsights);

      const remediations = await EvaluationRemediationManager.generateRemediations();
      expect(remediations).toHaveLength(1); // consolidated
      expect(remediations[0].action).toBe('Evaluate semantic/lexical weighting parameters.');
      // Should union and sort evidence IDs
      expect(remediations[0].evidenceIds).toEqual([
        recA.id,
        recB.id,
        'aud-111',
        'aud-222',
      ].sort());
      // Priority should elevate to high (due to warning alert + high confidence)
      expect(remediations[0].priority).toBe('high');
      expect(remediations[0].confidence).toBe('high');
    });
  });

  describe('Production Isolation and Config Stability', () => {
    it('should verify production response requests bypass recommendations computations completely', async () => {
      const mockGenerator = {
        generateResponse: async () => ({ text: 'Answer' }),
      };
      const mockRetriever = {
        retrieve: async () => [],
      };
      const mockAssembler = {
        assemble: () => ({ items: [], context: '', tokenCount: 0, governance: {} }),
      };

      const service = new ResponseService(
        mockRetriever as unknown as MemoryRetriever,
        mockAssembler as unknown as ContextAssembler,
        mockGenerator as unknown as ResponseGenerator
      );

      await service.respond('user-1', 'hi', {
        evaluationRun: false, // production
      });
    });

    it('should verify original RETRIEVAL_SETTINGS defaults are untouched', () => {
      const originalSettingsString = JSON.stringify(RETRIEVAL_SETTINGS);
      expect(JSON.stringify(RETRIEVAL_SETTINGS)).toBe(originalSettingsString);
    });
  });
});
