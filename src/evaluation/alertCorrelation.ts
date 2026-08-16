import { AlertCorrelation } from './types';
import { EvaluationAlertHistoryManager } from './alertHistory';
import { PromotionHistoryManager } from './promotionHistory';
import { ExperimentHistoryManager } from './experimentHistory';
import { EvaluationReportHistoryManager } from './reportHistory';
import { DEFAULT_THRESHOLDS } from './regression';

const PARAMETER_METRIC_MAP: Record<string, string[]> = {
  semanticWeight: ['relevance', 'retrievalRecall'],
  lexicalWeight: ['retrievalRecall', 'relevance'],
  minSimilarity: ['retrievalRecall', 'contextPrecision'],
  maxConversationSnippets: ['averageLatency', 'contextPrecision'],
};

export class EvaluationAlertCorrelationManager {
  private static isConfigChangeRelated(
    prev: import('./types').TuningConfig | null,
    curr: import('./types').TuningConfig | null,
    metric: string
  ): boolean {
    if (!prev || !curr) return false;
    for (const [param, metrics] of Object.entries(PARAMETER_METRIC_MAP)) {
      if (metrics.includes(metric)) {
        const valPrev = prev[param as keyof import('./types').TuningConfig];
        const valCurr = curr[param as keyof import('./types').TuningConfig];
        if (valPrev !== valCurr) {
          return true;
        }
      }
    }
    return false;
  }

  public static async correlateAlerts(includeResolved = false): Promise<AlertCorrelation[]> {
    const alerts = EvaluationAlertHistoryManager.listAlerts();
    const promotions = PromotionHistoryManager.listRecords();
    const experiments = ExperimentHistoryManager.listRecords();
    const reports = EvaluationReportHistoryManager.listReports();

    const correlations: AlertCorrelation[] = [];

    // Filter alerts: only open & acknowledged unless includeResolved is true
    const targets = alerts.filter(
      (a) => a.status === 'open' || a.status === 'acknowledged' || (includeResolved && a.status === 'resolved')
    );

    const metricsConfig: Record<string, { higherIsBetter: boolean; tolerance: number }> = {
      retrievalRecall: { higherIsBetter: true, tolerance: DEFAULT_THRESHOLDS.retrievalRecallTolerance },
      contextPrecision: { higherIsBetter: true, tolerance: DEFAULT_THRESHOLDS.contextPrecisionTolerance },
      relevance: { higherIsBetter: true, tolerance: DEFAULT_THRESHOLDS.relevanceTolerance },
      faithfulness: { higherIsBetter: true, tolerance: DEFAULT_THRESHOLDS.faithfulnessTolerance },
      citationCorrectness: { higherIsBetter: true, tolerance: DEFAULT_THRESHOLDS.citationCorrectnessTolerance },
      contextUtilization: { higherIsBetter: true, tolerance: DEFAULT_THRESHOLDS.contextUtilizationTolerance },
      successRate: { higherIsBetter: true, tolerance: DEFAULT_THRESHOLDS.successRateTolerance },
      cacheHitRate: { higherIsBetter: true, tolerance: DEFAULT_THRESHOLDS.cacheHitRateTolerance },
      fallbackRate: { higherIsBetter: false, tolerance: DEFAULT_THRESHOLDS.fallbackRateTolerance },
      retryRate: { higherIsBetter: false, tolerance: DEFAULT_THRESHOLDS.retryRateTolerance },
      timeoutCount: { higherIsBetter: false, tolerance: DEFAULT_THRESHOLDS.timeoutCountTolerance },
      averageLatency: { higherIsBetter: false, tolerance: DEFAULT_THRESHOLDS.latencyToleranceMs },
    };

    for (const record of targets) {
      const alert = record.alert;
      const metric = alert.metric || '';
      const alertTime = new Date(record.createdAt).getTime();

      const candidates: {
        likelyCause: 'configuration' | 'experiment' | 'evaluation';
        confidence: 'high' | 'medium' | 'low';
        explanation: string;
        relatedRecordId: string;
        timestamp: number;
      }[] = [];

      // 1. Config Change Correlation
      for (const promo of promotions) {
        const promoTime = new Date(promo.timestamp).getTime();
        if (promoTime > alertTime) {
          continue; // event after alert ignored
        }

        const isRelated = this.isConfigChangeRelated(promo.previousConfig, promo.newConfig, metric);
        if (isRelated) {
          const timeDelta = alertTime - promoTime;
          const isTenMin = timeDelta <= 10 * 60 * 1000;
          const confidence = isTenMin ? 'high' : 'medium';
          candidates.push({
            likelyCause: 'configuration',
            confidence,
            explanation: `Potential correlation: configuration parameter promotion occurred before the alert (confidence: ${confidence}).`,
            relatedRecordId: promo.id,
            timestamp: promoTime,
          });
        }
      }

      // 2. Experiment Correlation
      for (const exp of experiments) {
        const expTime = new Date(exp.timestamp).getTime();
        if (expTime > alertTime) {
          continue;
        }

        const delta = exp.comparison.deltas[metric];
        if (delta && delta.type === 'regression') {
          candidates.push({
            likelyCause: 'experiment',
            confidence: 'medium',
            explanation: 'Potential correlation: experiment run candidate showed regression in this metric before the alert.',
            relatedRecordId: exp.id,
            timestamp: expTime,
          });
        }
      }

      // 3. Evaluation Report Correlation
      for (let j = 0; j < reports.length - 1; j++) {
        const repRec = reports[j];
        const repTime = new Date(repRec.timestamp).getTime();
        if (repTime > alertTime) {
          continue;
        }

        const newerReport = repRec.report;
        const olderReport = reports[j + 1]?.report;
        if (!olderReport) continue;

        const baseVal = olderReport.latestRunSummary
          ? (olderReport.latestRunSummary as unknown as Record<string, number | undefined>)[metric]
          : undefined;
        const targetVal = newerReport.latestRunSummary
          ? (newerReport.latestRunSummary as unknown as Record<string, number | undefined>)[metric]
          : undefined;

        if (baseVal !== undefined && targetVal !== undefined) {
          const deltaVal = targetVal - baseVal;
          const config = metricsConfig[metric];
          if (config) {
            const isRegressed = config.higherIsBetter
              ? deltaVal < -config.tolerance
              : deltaVal > config.tolerance;

            if (isRegressed) {
              candidates.push({
                likelyCause: 'evaluation',
                confidence: 'medium',
                explanation: 'Potential correlation: evaluation report run recorded regression in this metric before the alert.',
                relatedRecordId: repRec.id,
                timestamp: repTime,
              });
            }
          }
        }
      }

      // Sort candidates by timestamp descending to find nearest events first
      candidates.sort((a, b) => b.timestamp - a.timestamp);

      // Now filter/rank to pick the primary cause
      const confidenceWeight = { high: 3, medium: 2, low: 1 };
      const causeWeight = { configuration: 4, experiment: 3, evaluation: 2, unknown: 1 };

      const bestCandidates = [...candidates];
      bestCandidates.sort((a, b) => {
        const cwA = confidenceWeight[a.confidence];
        const cwB = confidenceWeight[b.confidence];
        if (cwA !== cwB) {
          return cwB - cwA;
        }
        const causeA = causeWeight[a.likelyCause];
        const causeB = causeWeight[b.likelyCause];
        return causeB - causeA;
      });

      if (bestCandidates.length > 0) {
        const primary = bestCandidates[0];
        // Gather all related IDs from candidates matching the primary cause
        const relatedIds = candidates
          .filter((c) => c.likelyCause === primary.likelyCause)
          .map((c) => c.relatedRecordId);

        correlations.push({
          alertId: record.id,
          metric: alert.metric,
          likelyCause: primary.likelyCause,
          confidence: primary.confidence,
          explanation: primary.explanation,
          relatedRecordIds: Array.from(new Set(relatedIds)),
        });
      } else {
        correlations.push({
          alertId: record.id,
          metric: alert.metric,
          likelyCause: 'unknown',
          confidence: 'low',
          explanation: 'No clear correlation found with configurations, experiments, or report trends.',
          relatedRecordIds: [],
        });
      }
    }

    return correlations;
  }
}
