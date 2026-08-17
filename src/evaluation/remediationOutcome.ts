import {
  RemediationOutcome,
  TuningConfig,
} from './types';
import { EvaluationRemediationExecutionManager } from './remediationExecution';
import { EvaluationReportHistoryManager } from './reportHistory';
import { DEFAULT_THRESHOLDS } from './regression';

export class EvaluationRemediationOutcomeManager {
  private static deepClone<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    return JSON.parse(JSON.stringify(obj));
  }

  private static sanitizeData<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    const cloned = this.deepClone(obj);
    const keysToStrip = ['diagnostics', 'prompts', 'sql', 'uuid', 'apiKey', 'provider', 'secrets', 'transcripts'];

    const traverseAndStrip = (current: unknown) => {
      if (typeof current !== 'object' || current === null) return;
      const objRec = current as Record<string, unknown>;
      for (const key of Object.keys(objRec)) {
        if (keysToStrip.includes(key)) {
          delete objRec[key];
        } else {
          traverseAndStrip(objRec[key]);
        }
      }
    };

    traverseAndStrip(cloned);
    return cloned;
  }

  private static configsEqual(a: TuningConfig | null, b: TuningConfig | null): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
      a.semanticWeight === b.semanticWeight &&
      a.lexicalWeight === b.lexicalWeight &&
      a.minSimilarity === b.minSimilarity &&
      a.diversityThreshold === b.diversityThreshold &&
      a.maxConversationSnippets === b.maxConversationSnippets
    );
  }

  public static generateOutcomes(): RemediationOutcome[] {
    // Read execution history
    const executions = EvaluationRemediationExecutionManager.listExecutions();
    
    // Sort reports chronologically oldest to newest for temporal sequence lookup
    const reports = [...EvaluationReportHistoryManager.listReports()].sort(
      (a, b) => new Date(a.report.timestamp).getTime() - new Date(b.report.timestamp).getTime()
    );

    const outcomes: RemediationOutcome[] = [];

    for (const exec of executions) {
      if (exec.status !== 'success') {
        // Exclude failed or rolled_back executions from evaluation comparison
        outcomes.push({
          executionId: exec.id,
          status: 'insufficientData',
          targetMetrics: {},
          summary: `No outcome verification available for ${exec.status} execution.`,
          evaluatedAt: new Date().toISOString(),
        });
        continue;
      }

      const executedTime = new Date(exec.executedAt).getTime();

      // Find first report AFTER execution
      const postReports = reports.filter((r) => new Date(r.report.timestamp).getTime() > executedTime);
      const afterReport = postReports[0];

      if (!afterReport || !this.configsEqual(afterReport.report.promotedConfig, exec.appliedConfig)) {
        outcomes.push({
          executionId: exec.id,
          status: 'insufficientData',
          targetMetrics: {},
          summary: 'Insufficient post-execution report data matching applied configuration.',
          evaluatedAt: new Date().toISOString(),
        });
        continue;
      }

      // Find nearest comparable report BEFORE execution
      const preReports = reports.filter((r) => new Date(r.report.timestamp).getTime() < executedTime);
      const beforeReport = preReports[preReports.length - 1];

      if (!beforeReport || !this.configsEqual(beforeReport.report.promotedConfig, exec.previousConfig)) {
        outcomes.push({
          executionId: exec.id,
          status: 'insufficientData',
          targetMetrics: {},
          summary: 'Insufficient pre-execution report data matching previous configuration.',
          evaluatedAt: new Date().toISOString(),
        });
        continue;
      }

      // Compare metrics between beforeReport and afterReport
      const beforeSummary = beforeReport.report.latestRunSummary || {};
      const afterSummary = afterReport.report.latestRunSummary || {};

      const metricsToCompare: Record<string, { higherIsBetter: boolean; tolerance: number }> = {
        relevance: { higherIsBetter: true, tolerance: DEFAULT_THRESHOLDS.relevanceTolerance },
        retrievalRecall: { higherIsBetter: true, tolerance: DEFAULT_THRESHOLDS.retrievalRecallTolerance },
        contextPrecision: { higherIsBetter: true, tolerance: DEFAULT_THRESHOLDS.contextPrecisionTolerance },
        averageLatency: { higherIsBetter: false, tolerance: DEFAULT_THRESHOLDS.latencyToleranceMs },
        faithfulness: { higherIsBetter: true, tolerance: DEFAULT_THRESHOLDS.faithfulnessTolerance },
        citationCorrectness: { higherIsBetter: true, tolerance: DEFAULT_THRESHOLDS.citationCorrectnessTolerance },
      };

      const targetMetrics: Record<string, { before?: number; after?: number; delta?: number }> = {};
      let hasDegraded = false;
      let hasImproved = false;
      const improvedMetricsList: string[] = [];
      const degradedMetricsList: string[] = [];

      for (const [key, info] of Object.entries(metricsToCompare)) {
        const beforeVal = (beforeSummary as Record<string, number | undefined>)[key];
        const afterVal = (afterSummary as Record<string, number | undefined>)[key];

        if (beforeVal === undefined || afterVal === undefined) {
          continue;
        }

        const delta = parseFloat((afterVal - beforeVal).toFixed(4));
        targetMetrics[key] = { before: beforeVal, after: afterVal, delta };

        if (info.higherIsBetter) {
          if (delta > info.tolerance) {
            hasImproved = true;
            improvedMetricsList.push(key);
          } else if (delta < -info.tolerance) {
            hasDegraded = true;
            degradedMetricsList.push(key);
          }
        } else {
          // lower is better (e.g. latency)
          if (delta < -info.tolerance) {
            hasImproved = true;
            improvedMetricsList.push(key);
          } else if (delta > info.tolerance) {
            hasDegraded = true;
            degradedMetricsList.push(key);
          }
        }
      }

      let status: 'improved' | 'degraded' | 'unchanged' | 'insufficientData' = 'insufficientData';
      let summaryText = '';

      if (Object.keys(targetMetrics).length === 0) {
        status = 'insufficientData';
        summaryText = 'No comparable summary metrics found between reports.';
      } else if (hasDegraded) {
        status = 'degraded';
        summaryText = `Degraded performance detected in: ${degradedMetricsList.join(', ')}.`;
      } else if (hasImproved) {
        status = 'improved';
        summaryText = `Improved performance detected in: ${improvedMetricsList.join(', ')}.`;
      } else {
        status = 'unchanged';
        summaryText = 'All monitored metrics remained stable and within tolerances.';
      }

      outcomes.push({
        executionId: exec.id,
        status,
        targetMetrics,
        summary: summaryText,
        evaluatedAt: afterReport.report.timestamp,
      });
    }

    // Sort outcomes deterministically by execution ID
    outcomes.sort((a, b) => a.executionId.localeCompare(b.executionId));

    return this.sanitizeData(outcomes);
  }
}
