import { ExperimentHistoryManager } from './experimentHistory';
import { ExperimentInsights, TuningConfig } from './types';
import { DEFAULT_THRESHOLDS } from './regression';

export class ExperimentInsightsManager {
  public static generateInsights(): ExperimentInsights {
    const records = ExperimentHistoryManager.listRecords();

    if (records.length < 2) {
      return {
        insufficientHistory: true,
        totalExperiments: records.length,
        controlWins: 0,
        candidateWins: 0,
        draws: 0,
        bestConfig: null,
        bestConfigSource: null,
        averageDeltas: {},
        improvingMetrics: [],
        degradingMetrics: [],
      };
    }

    let controlWins = 0;
    let candidateWins = 0;
    let draws = 0;

    let highestMargin = 0;
    let bestConfig: TuningConfig | null = null;
    let bestConfigSource: 'candidate' | 'control' | null = null;

    const metricSums: Record<string, number> = {};
    const metricCounts: Record<string, number> = {};

    const allMetrics = [
      'retrievalRecall',
      'contextPrecision',
      'relevance',
      'faithfulness',
      'citationCorrectness',
      'contextUtilization',
      'averageLatency',
      'successRate',
      'cacheHitRate',
      'fallbackRate',
      'retryRate',
      'timeoutCount',
    ];

    for (const record of records) {
      if (record.recommendation === 'candidate') candidateWins++;
      else if (record.recommendation === 'control') controlWins++;
      else draws++;

      let margin = 0;
      if (record.recommendation === 'candidate') {
        margin = (record.candidateSummary.retrievalRecall - record.controlSummary.retrievalRecall) +
                 (record.candidateSummary.contextPrecision - record.controlSummary.contextPrecision) +
                 (record.candidateSummary.relevance - record.controlSummary.relevance) +
                 (record.candidateSummary.faithfulness - record.controlSummary.faithfulness);
      } else if (record.recommendation === 'control') {
        margin = (record.controlSummary.retrievalRecall - record.candidateSummary.retrievalRecall) +
                 (record.controlSummary.contextPrecision - record.candidateSummary.contextPrecision) +
                 (record.controlSummary.relevance - record.candidateSummary.relevance) +
                 (record.controlSummary.faithfulness - record.candidateSummary.faithfulness);
      }

      if (margin > highestMargin) {
        highestMargin = margin;
        bestConfig = record.recommendation === 'candidate' ? record.candidateConfig : record.controlConfig;
        bestConfigSource = record.recommendation === 'candidate' ? 'candidate' : 'control';
      }

      for (const metric of allMetrics) {
        const valCand = (record.candidateSummary as unknown as Record<string, number | undefined>)[metric];
        const valCtrl = (record.controlSummary as unknown as Record<string, number | undefined>)[metric];

        if (
          valCand !== undefined &&
          valCtrl !== undefined &&
          typeof valCand === 'number' &&
          typeof valCtrl === 'number' &&
          !isNaN(valCand) &&
          !isNaN(valCtrl) &&
          isFinite(valCand) &&
          isFinite(valCtrl)
        ) {
          const delta = valCand - valCtrl;
          metricSums[metric] = (metricSums[metric] || 0) + delta;
          metricCounts[metric] = (metricCounts[metric] || 0) + 1;
        }
      }
    }

    const averageDeltas: Record<string, number> = {};
    for (const metric of allMetrics) {
      const count = metricCounts[metric] || 0;
      if (count > 0) {
        averageDeltas[metric] = metricSums[metric] / count;
      }
    }

    const improvingMetrics: string[] = [];
    const degradingMetrics: string[] = [];

    const qualityTolerances: Record<string, number> = {
      retrievalRecall: DEFAULT_THRESHOLDS.retrievalRecallTolerance,
      contextPrecision: DEFAULT_THRESHOLDS.contextPrecisionTolerance,
      relevance: DEFAULT_THRESHOLDS.relevanceTolerance,
      faithfulness: DEFAULT_THRESHOLDS.faithfulnessTolerance,
      citationCorrectness: DEFAULT_THRESHOLDS.citationCorrectnessTolerance,
      contextUtilization: DEFAULT_THRESHOLDS.contextUtilizationTolerance,
      successRate: DEFAULT_THRESHOLDS.successRateTolerance,
      cacheHitRate: DEFAULT_THRESHOLDS.cacheHitRateTolerance,
    };

    const costTolerances: Record<string, number> = {
      averageLatency: DEFAULT_THRESHOLDS.latencyToleranceMs,
      fallbackRate: DEFAULT_THRESHOLDS.fallbackRateTolerance,
      retryRate: DEFAULT_THRESHOLDS.retryRateTolerance,
      timeoutCount: DEFAULT_THRESHOLDS.timeoutCountTolerance,
    };

    for (const [metric, tolerance] of Object.entries(qualityTolerances)) {
      const avg = averageDeltas[metric];
      if (avg !== undefined) {
        if (avg > tolerance) {
          improvingMetrics.push(metric);
        } else if (avg < -tolerance) {
          degradingMetrics.push(metric);
        }
      }
    }

    for (const [metric, tolerance] of Object.entries(costTolerances)) {
      const avg = averageDeltas[metric];
      if (avg !== undefined) {
        if (avg < -tolerance) {
          improvingMetrics.push(metric);
        } else if (avg > tolerance) {
          degradingMetrics.push(metric);
        }
      }
    }

    return {
      insufficientHistory: false,
      totalExperiments: records.length,
      controlWins,
      candidateWins,
      draws,
      bestConfig,
      bestConfigSource,
      averageDeltas,
      improvingMetrics,
      degradingMetrics,
    };
  }
}
