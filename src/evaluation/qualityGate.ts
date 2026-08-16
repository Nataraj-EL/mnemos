import { QualityGateResult } from './types';
import { EvaluationHistoryManager } from './history';
import { BaselineManager, compareSummaries } from './regression';
import { EvaluationConfigPromotionManager } from './promotion';
import { ConfigSafetyGuard } from './configGuard';

export class EvaluationQualityGateManager {
  public static async evaluateGate(): Promise<QualityGateResult> {
    const timestamp = new Date().toISOString();
    const checkedMetrics: Record<string, string | number> = {};

    const runs = EvaluationHistoryManager.listRuns();
    if (runs.length === 0) {
      return {
        status: 'pass',
        reasons: ['No evaluation runs exist in history.'],
        checkedMetrics: {},
        timestamp,
        insufficientHistory: true,
        baselineAvailable: false,
      };
    }

    const latestRun = runs[0];
    const latest = latestRun.summary;

    const metricsToTrack = [
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

    for (const metric of metricsToTrack) {
      const val = (latest as unknown as Record<string, unknown>)[metric];
      if (val !== undefined && val !== null) {
        checkedMetrics[metric] = val as string | number;
      }
    }

    let isBlocked = false;
    let hasWarning = false;

    const criticalReasons: string[] = [];
    const configSafetyReasons: string[] = [];
    const latencyReasons: string[] = [];
    const healthReasons: string[] = [];

    const baseline = BaselineManager.getBaseline();
    const baselineAvailable = baseline !== null;

    if (baselineAvailable) {
      const comparison = compareSummaries(latest, baseline);
      if (comparison.status === 'fail') {
        isBlocked = true;
        for (const failedMetric of comparison.failedThresholds) {
          criticalReasons.push(`Critical quality regression: ${failedMetric} has regressed beyond acceptable baseline tolerances.`);
        }
      } else if (comparison.status === 'warning') {
        hasWarning = true;
        for (const failedMetric of comparison.failedThresholds) {
          if (failedMetric === 'averageLatency') {
            latencyReasons.push('Elevated average latency regression detected relative to baseline.');
          } else {
            healthReasons.push(`Non-critical regression: ${failedMetric} has regressed relative to baseline.`);
          }
        }
      }
    }

    if (latest.successRate !== undefined && latest.successRate < 0.5) {
      isBlocked = true;
      criticalReasons.push('Critical quality gate: query success rate is below 50%.');
    }

    const hasPromotedConfig = EvaluationConfigPromotionManager.hasPromotedConfig();
    if (hasPromotedConfig) {
      const promotedConfig = EvaluationConfigPromotionManager.getCurrentConfig();
      if (promotedConfig) {
        const safetyCheck = ConfigSafetyGuard.validate(promotedConfig);
        if (!safetyCheck.valid) {
          isBlocked = true;
          for (const err of safetyCheck.errors) {
            configSafetyReasons.push(`Configuration safety error: ${err}`);
          }
        }
        if (safetyCheck.warnings.length > 0) {
          hasWarning = true;
          for (const warn of safetyCheck.warnings) {
            healthReasons.push(`Configuration warning: ${warn}`);
          }
        }
      }
    }

    if (latest.averageLatency !== undefined && latest.averageLatency > 2000) {
      hasWarning = true;
      latencyReasons.push(`Elevated average latency of ${Math.round(latest.averageLatency)}ms (exceeds absolute warning limit of 2000ms).`);
    }

    if (latest.timeoutCount !== undefined && latest.timeoutCount > 0) {
      hasWarning = true;
      healthReasons.push(`Detected ${latest.timeoutCount} request timeouts during query execution.`);
    }
    if (latest.retryRate !== undefined && latest.retryRate > 0) {
      hasWarning = true;
      healthReasons.push(`Detected query retries (retry rate: ${(latest.retryRate * 100).toFixed(0)}%).`);
    }
    if (latest.fallbackRate !== undefined && latest.fallbackRate > 0) {
      hasWarning = true;
      healthReasons.push(`Detected query lexical fallbacks (fallback rate: ${(latest.fallbackRate * 100).toFixed(0)}%).`);
    }

    const allReasons = [
      ...criticalReasons,
      ...configSafetyReasons,
      ...latencyReasons,
      ...healthReasons,
    ];

    const uniqueReasons = Array.from(new Set(allReasons));

    let status: 'pass' | 'warning' | 'block' = 'pass';
    if (isBlocked) {
      status = 'block';
    } else if (hasWarning) {
      status = 'warning';
    }

    if (uniqueReasons.length === 0) {
      uniqueReasons.push('Release readiness gates passed with no issues.');
    }

    return {
      status,
      reasons: uniqueReasons,
      checkedMetrics,
      timestamp,
      insufficientHistory: false,
      baselineAvailable,
    };
  }
}
