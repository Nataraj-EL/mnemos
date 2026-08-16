import { EvaluationReportInsights, HistoricalMetricTrend } from './types';
import { EvaluationReportHistoryManager } from './reportHistory';
import { DEFAULT_THRESHOLDS } from './regression';

export class EvaluationReportInsightsManager {
  private static evaluateMetricTrend(
    targetVal: number | undefined,
    baseVal: number | undefined,
    higherIsBetter: boolean,
    tolerance: number
  ): HistoricalMetricTrend {
    if (
      targetVal === undefined ||
      baseVal === undefined ||
      !Number.isFinite(targetVal) ||
      !Number.isFinite(baseVal)
    ) {
      return { type: 'notComparable' };
    }

    const delta = targetVal - baseVal;
    if (Math.abs(delta) <= tolerance) {
      return { delta, type: 'stable' };
    }

    const isImproved = higherIsBetter ? delta > 0 : delta < 0;
    return {
      delta,
      type: isImproved ? 'improving' : 'degrading',
    };
  }

  public static async generateInsights(): Promise<EvaluationReportInsights> {
    const timestamp = new Date().toISOString();
    const reports = EvaluationReportHistoryManager.listReports();

    let passed = 0;
    let warned = 0;
    let blocked = 0;

    for (const rec of reports) {
      const status = rec.report.qualityGate?.status;
      if (status === 'pass') {
        passed++;
      } else if (status === 'warning') {
        warned++;
      } else if (status === 'block') {
        blocked++;
      }
    }

    const gateHistorySummary = {
      total: reports.length,
      passed,
      warned,
      blocked,
    };

    if (reports.length < 2) {
      return {
        insufficientHistory: true,
        timestamp,
        status: 'stable',
        trends: {},
        recurringDegradations: [],
        gateHistorySummary,
      };
    }

    const latestReport = reports[0];
    const previousReport = reports[1];

    const latest = latestReport.report;
    const previous = previousReport.report;

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

    const trends: Record<string, HistoricalMetricTrend> = {};
    let improvingCount = 0;
    let degradingCount = 0;

    for (const [metric, info] of Object.entries(metricsConfig)) {
      const baseVal = previous.latestRunSummary
        ? (previous.latestRunSummary as unknown as Record<string, number | undefined>)[metric]
        : undefined;
      const targetVal = latest.latestRunSummary
        ? (latest.latestRunSummary as unknown as Record<string, number | undefined>)[metric]
        : undefined;

      const trend = this.evaluateMetricTrend(targetVal, baseVal, info.higherIsBetter, info.tolerance);
      trends[metric] = trend;

      if (trend.type === 'improving') {
        improvingCount++;
      } else if (trend.type === 'degrading') {
        degradingCount++;
      }
    }

    let status: 'improving' | 'stable' | 'degrading' = 'stable';
    if (improvingCount > degradingCount) {
      status = 'improving';
    } else if (degradingCount > improvingCount) {
      status = 'degrading';
    }

    const recurringDegradations: string[] = [];

    for (const metric of Object.keys(metricsConfig)) {
      const degradations: boolean[] = [];
      for (let k = 0; k < reports.length - 1; k++) {
        const newerReport = reports[k].report;
        const olderReport = reports[k + 1].report;

        const baseVal = olderReport.latestRunSummary
          ? (olderReport.latestRunSummary as unknown as Record<string, number | undefined>)[metric]
          : undefined;
        const targetVal = newerReport.latestRunSummary
          ? (newerReport.latestRunSummary as unknown as Record<string, number | undefined>)[metric]
          : undefined;

        const info = metricsConfig[metric];
        const evaluated = this.evaluateMetricTrend(targetVal, baseVal, info.higherIsBetter, info.tolerance);
        degradations.push(evaluated.type === 'degrading');
      }

      let isRecurring = false;
      for (let j = 0; j < degradations.length - 1; j++) {
        if (degradations[j] && degradations[j + 1]) {
          isRecurring = true;
          break;
        }
      }

      if (isRecurring) {
        recurringDegradations.push(metric);
      }
    }

    recurringDegradations.sort();

    return {
      insufficientHistory: false,
      timestamp,
      latestReportId: latestReport.id,
      previousReportId: previousReport.id,
      status,
      trends,
      recurringDegradations,
      gateHistorySummary,
    };
  }
}
