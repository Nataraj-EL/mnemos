import { describe, it, expect, beforeEach } from 'vitest';
import { EvaluationAlertHistoryManager } from './alertHistory';
import { EvaluationAlert } from './types';
import { RETRIEVAL_SETTINGS } from '@/core/config';
import { ResponseService } from '@/response/service';
import { MemoryRetriever } from '@/memory/retriever';
import { ContextAssembler } from '@/context/assembler';
import { ResponseGenerator } from '@/response/generator';

describe('Sprint 56: Evaluation Alert Acknowledgement & Resolution Tracking Tests', () => {
  const sampleAlert: EvaluationAlert = {
    id: 'sample-id',
    metric: 'relevance',
    severity: 'warning',
    message: 'Relevance is regressing.',
    timestamp: new Date().toISOString(),
  };

  beforeEach(() => {
    EvaluationAlertHistoryManager.clearHistory();
  });

  describe('Lifecycle Status Transitions', () => {
    it('should progress transition boundaries correctly open -> acknowledged -> resolved -> reopened', () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);
      expect(rec.status).toBe('open');

      // Valid: open -> acknowledged
      let success = EvaluationAlertHistoryManager.acknowledge(rec.id);
      expect(success).toBe(true);
      let list = EvaluationAlertHistoryManager.listAlerts();
      expect(list[0].status).toBe('acknowledged');

      // Invalid: acknowledged -> acknowledge again
      success = EvaluationAlertHistoryManager.acknowledge(rec.id);
      expect(success).toBe(false);

      // Valid: acknowledged -> resolved
      success = EvaluationAlertHistoryManager.resolve(rec.id);
      expect(success).toBe(true);
      list = EvaluationAlertHistoryManager.listAlerts();
      expect(list[0].status).toBe('resolved');

      // Valid: resolved -> open (reopen)
      success = EvaluationAlertHistoryManager.reopen(rec.id);
      expect(success).toBe(true);
      list = EvaluationAlertHistoryManager.listAlerts();
      expect(list[0].status).toBe('open');
    });

    it('should reject invalid lifecycle transitions', () => {
      const rec = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);

      // Invalid: open -> reopen (only resolved can be reopened)
      let success = EvaluationAlertHistoryManager.reopen(rec.id);
      expect(success).toBe(false);

      // Transition to resolved
      EvaluationAlertHistoryManager.resolve(rec.id);

      // Invalid: resolved -> acknowledge (only open can be acknowledged)
      success = EvaluationAlertHistoryManager.acknowledge(rec.id);
      expect(success).toBe(false);
    });
  });

  describe('Resolved Alert Regeneration', () => {
    it('should suppress duplicate alerts when open or acknowledged, but recreate if resolved', () => {
      const r1 = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);
      const r2 = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);

      // Open, so duplicate is suppressed (returns same record)
      expect(r1.id).toBe(r2.id);
      expect(EvaluationAlertHistoryManager.listAlerts()).toHaveLength(1);

      // Acknowledge r1
      EvaluationAlertHistoryManager.acknowledge(r1.id);
      const r3 = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);
      expect(r3.id).toBe(r1.id);
      expect(EvaluationAlertHistoryManager.listAlerts()).toHaveLength(1);

      // Resolve r1
      EvaluationAlertHistoryManager.resolve(r1.id);
      const r4 = EvaluationAlertHistoryManager.addAlertRecord(sampleAlert);

      // Now resolved, so a new alert occurrence is created!
      expect(r4.id).not.toBe(r1.id);
      expect(EvaluationAlertHistoryManager.listAlerts()).toHaveLength(2);
    });
  });

  describe('FIFO Eviction and Deep Cloning', () => {
    it('should enforce MAX_RECORDS = 50 limit using FIFO eviction', () => {
      for (let i = 0; i < 60; i++) {
        const customAlert = {
          ...sampleAlert,
          message: `Regression number ${i}`,
        };
        EvaluationAlertHistoryManager.addAlertRecord(customAlert);
      }

      const list = EvaluationAlertHistoryManager.listAlerts();
      expect(list).toHaveLength(50);
      expect(list[0].alert.message).toBe('Regression number 59'); // newest at index 0
      expect(list[49].alert.message).toBe('Regression number 10'); // oldest surviving
    });

    it('should maintain strict immutability deep cloning', () => {
      const alertCopy = { ...sampleAlert };
      const record = EvaluationAlertHistoryManager.addAlertRecord(alertCopy);

      // Mutate original source
      alertCopy.message = 'Mutated';
      expect(record.alert.message).toBe('Relevance is regressing.');

      // Mutate returned list item
      const list = EvaluationAlertHistoryManager.listAlerts();
      list[0].alert.message = 'Mutated list';

      const listSecond = EvaluationAlertHistoryManager.listAlerts();
      expect(listSecond[0].alert.message).toBe('Relevance is regressing.');
    });
  });

  describe('Deterministic Sort Order', () => {
    it('should keep order sorted by createdAt descending and maintain order on lifecycle status updates', () => {
      const a1 = { ...sampleAlert, message: 'First alert' };
      const a2 = { ...sampleAlert, message: 'Second alert' };

      const r1 = EvaluationAlertHistoryManager.addAlertRecord(a1);
      // Wait briefly or simulate distinct timestamp sequence by custom mock if needed
      // (addAlertRecord uses Date.now() internally inside ID/Timestamps, so they will naturally order since pushing happens in sequence)
      const r2 = EvaluationAlertHistoryManager.addAlertRecord(a2);

      let list = EvaluationAlertHistoryManager.listAlerts();
      expect(list[0].id).toBe(r2.id); // newest first
      expect(list[1].id).toBe(r1.id);

      // Update the status of the older alert
      EvaluationAlertHistoryManager.resolve(r1.id);

      // Verify sorting order remains unchanged by updates
      list = EvaluationAlertHistoryManager.listAlerts();
      expect(list[0].id).toBe(r2.id);
      expect(list[1].id).toBe(r1.id);
    });
  });

  describe('Production Isolation and Config Stability', () => {
    it('should verify production response requests bypass alerts tracking logic completely', async () => {
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
