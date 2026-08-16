import { EvaluationHistoryManager } from './history';
import { DEFAULT_THRESHOLDS } from './regression';

export interface MetricTrend {
  delta?: number;
  type: 'improving' | 'stable' | 'degrading' | 'notComparable';
}

export interface EvaluationInsightsSummary {
  status: 'improving' | 'stable' | 'degrading' | 'insufficient';
  latestTimestamp?: string;
  previousTimestamp?: string;
  trends: Record<string, MetricTrend>;
}

export class EvaluationInsightsManager {
  public static generateInsights(): EvaluationInsightsSummary {
    const runs = EvaluationHistoryManager.listRuns();

    if (runs.length < 2) {
      return {
        status: 'insufficient',
        trends: {},
      };
    }

    // runs are sorted newest-first, so index 0 is latest and index 1 is previous
    const latest = runs[0];
    const previous = runs[1];

    const trends: Record<string, MetricTrend> = {};
    let improvingCount = 0;
    let degradingCount = 0;

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
    };

    for (const [key, info] of Object.entries(metricsConfig)) {
      const latestVal = (latest.summary as unknown as Record<string, number | undefined>)[key];
      const previousVal = (previous.summary as unknown as Record<string, number | undefined>)[key];

      if (latestVal === undefined || previousVal === undefined) {
        trends[key] = { type: 'notComparable' };
        continue;
      }

      const delta = latestVal - previousVal;

      if (Math.abs(delta) <= info.tolerance) {
        trends[key] = { delta, type: 'stable' };
      } else {
        const isImproved = info.higherIsBetter ? delta > 0 : delta < 0;
        if (isImproved) {
          trends[key] = { delta, type: 'improving' };
          improvingCount++;
        } else {
          trends[key] = { delta, type: 'degrading' };
          degradingCount++;
        }
      }
    }

    // Latency handling
    const latestLatency = latest.summary.averageLatency;
    const previousLatency = previous.summary.averageLatency;

    if (latestLatency === undefined || previousLatency === undefined) {
      trends.averageLatency = { type: 'notComparable' };
    } else {
      const latencyDelta = latestLatency - previousLatency;
      if (Math.abs(latencyDelta) <= DEFAULT_THRESHOLDS.latencyToleranceMs) {
        trends.averageLatency = { delta: latencyDelta, type: 'stable' };
      } else {
        const isLatencyImproved = latencyDelta < 0;
        if (isLatencyImproved) {
          trends.averageLatency = { delta: latencyDelta, type: 'improving' };
          improvingCount++;
        } else {
          trends.averageLatency = { delta: latencyDelta, type: 'degrading' };
          degradingCount++;
        }
      }
    }

    let status: 'improving' | 'stable' | 'degrading' = 'stable';
    if (improvingCount > degradingCount) {
      status = 'improving';
    } else if (degradingCount > improvingCount) {
      status = 'degrading';
    }

    return {
      status,
      latestTimestamp: latest.timestamp,
      previousTimestamp: previous.timestamp,
      trends,
    };
  }
}
