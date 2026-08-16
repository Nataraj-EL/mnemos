import { EvalSummary } from './types';

export interface RegressionThresholds {
  retrievalRecallTolerance?: number;
  contextPrecisionTolerance?: number;
  relevanceTolerance?: number;
  faithfulnessTolerance?: number;
  citationCorrectnessTolerance?: number;
  contextUtilizationTolerance?: number;
  latencyToleranceMs?: number;
  latencyRelativeTolerance?: number;
  successRateTolerance?: number;
  cacheHitRateTolerance?: number;
  fallbackRateTolerance?: number;
  retryRateTolerance?: number;
  timeoutCountTolerance?: number;
}

export const DEFAULT_THRESHOLDS: Required<RegressionThresholds> = {
  retrievalRecallTolerance: 0.05,
  contextPrecisionTolerance: 0.05,
  relevanceTolerance: 0.02,
  faithfulnessTolerance: 0.02,
  citationCorrectnessTolerance: 0.02,
  contextUtilizationTolerance: 0.05,
  latencyToleranceMs: 500,
  latencyRelativeTolerance: 0.20,
  successRateTolerance: 0.05,
  cacheHitRateTolerance: 0.10,
  fallbackRateTolerance: 0.10,
  retryRateTolerance: 0.10,
  timeoutCountTolerance: 1,
};

export interface MetricDelta {
  absolute?: number;
  percentage?: number;
  type: 'improvement' | 'unchanged' | 'regression' | 'notComparable';
  notComparable?: boolean;
}

export interface RegressionSummary {
  baselineAvailable: boolean;
  baselineLabel?: string;
  status: 'pass' | 'warning' | 'fail';
  deltas: Record<string, MetricDelta>;
  failedThresholds: string[];
}

export function sanitizeSummary(summary: EvalSummary): EvalSummary {
  return {
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    retrievalRecall: summary.retrievalRecall,
    contextPrecision: summary.contextPrecision,
    isolationRate: summary.isolationRate,
    deduplicationRate: summary.deduplicationRate,
    tokenCompliance: summary.tokenCompliance,
    relevance: summary.relevance,
    faithfulness: summary.faithfulness,
    citationCorrectness: summary.citationCorrectness,
    contextUtilization: summary.contextUtilization,
    averageLatency: summary.averageLatency,
    successRate: summary.successRate,
    cacheHitRate: summary.cacheHitRate,
    fallbackRate: summary.fallbackRate,
    retryRate: summary.retryRate,
    timeoutCount: summary.timeoutCount,
  };
}

export class BaselineManager {
  private static baseline: EvalSummary | null = null;
  private static label: string | null = null;

  public static getBaseline(): EvalSummary | null {
    return this.baseline;
  }

  public static getLabel(): string | null {
    return this.label;
  }

  public static setBaseline(summary: EvalSummary, label?: string): void {
    this.baseline = sanitizeSummary(summary);
    this.label = label || new Date().toISOString();
  }

  public static clearBaseline(): void {
    this.baseline = null;
    this.label = null;
  }
}

function calculateMetricDelta(
  currentVal: number | undefined,
  baselineVal: number | undefined,
  higherIsBetter: boolean
): MetricDelta {
  if (currentVal === undefined || baselineVal === undefined) {
    return { type: 'notComparable', notComparable: true };
  }

  const absolute = currentVal - baselineVal;
  let percentage: number | undefined = undefined;

  if (baselineVal !== 0) {
    percentage = (absolute / baselineVal) * 100;
  }

  if (absolute === 0) {
    return { absolute, percentage, type: 'unchanged' };
  }

  const isRegressed = higherIsBetter ? absolute < 0 : absolute > 0;

  return {
    absolute,
    percentage,
    type: isRegressed ? 'regression' : 'improvement',
  };
}

export function compareSummaries(
  current: EvalSummary,
  baseline: EvalSummary | null,
  thresholdsConfig?: RegressionThresholds
): RegressionSummary {
  if (!baseline) {
    return {
      baselineAvailable: false,
      status: 'pass',
      deltas: {},
      failedThresholds: [],
    };
  }

  const thresholds = { ...DEFAULT_THRESHOLDS, ...thresholdsConfig };
  const deltas: Record<string, MetricDelta> = {};
  const failedThresholds: string[] = [];

  const metricsInfo: Record<string, { higherIsBetter: boolean; tolerance: number; isCritical: boolean }> = {
    retrievalRecall: { higherIsBetter: true, tolerance: thresholds.retrievalRecallTolerance, isCritical: true },
    contextPrecision: { higherIsBetter: true, tolerance: thresholds.contextPrecisionTolerance, isCritical: true },
    relevance: { higherIsBetter: true, tolerance: thresholds.relevanceTolerance, isCritical: true },
    faithfulness: { higherIsBetter: true, tolerance: thresholds.faithfulnessTolerance, isCritical: true },
    citationCorrectness: { higherIsBetter: true, tolerance: thresholds.citationCorrectnessTolerance, isCritical: true },
    successRate: { higherIsBetter: true, tolerance: thresholds.successRateTolerance, isCritical: true },
    contextUtilization: { higherIsBetter: true, tolerance: thresholds.contextUtilizationTolerance, isCritical: false },
    cacheHitRate: { higherIsBetter: true, tolerance: thresholds.cacheHitRateTolerance, isCritical: false },
    fallbackRate: { higherIsBetter: false, tolerance: thresholds.fallbackRateTolerance, isCritical: false },
    retryRate: { higherIsBetter: false, tolerance: thresholds.retryRateTolerance, isCritical: false },
    timeoutCount: { higherIsBetter: false, tolerance: thresholds.timeoutCountTolerance, isCritical: false },
  };

  // 1. Calculate deltas for standard metrics
  for (const [key, info] of Object.entries(metricsInfo)) {
    const currentVal = (current as unknown as Record<string, number | undefined>)[key];
    const baselineVal = (baseline as unknown as Record<string, number | undefined>)[key];
    const delta = calculateMetricDelta(currentVal, baselineVal, info.higherIsBetter);
    deltas[key] = delta;

    if (delta.type === 'regression' && delta.absolute !== undefined) {
      if (Math.abs(delta.absolute) > info.tolerance) {
        failedThresholds.push(key);
      }
    }
  }

  // 2. Special handling for averageLatency delta
  const latencyDelta = calculateMetricDelta(current.averageLatency, baseline.averageLatency, false);
  deltas.averageLatency = latencyDelta;

  if (latencyDelta.type === 'regression' && latencyDelta.absolute !== undefined) {
    const exceedsAbs = latencyDelta.absolute > thresholds.latencyToleranceMs;
    const exceedsRel =
      latencyDelta.percentage !== undefined &&
      latencyDelta.percentage > thresholds.latencyRelativeTolerance * 100;

    if (exceedsAbs || exceedsRel) {
      failedThresholds.push('averageLatency');
    }
  }

  // 3. Resolve overall status
  let status: 'pass' | 'warning' | 'fail' = 'pass';

  for (const failedMetric of failedThresholds) {
    const isCritical = metricsInfo[failedMetric]?.isCritical ?? false;
    if (isCritical) {
      status = 'fail';
      break;
    } else {
      status = 'warning';
    }
  }

  return {
    baselineAvailable: true,
    baselineLabel: BaselineManager.getLabel() || undefined,
    status,
    deltas,
    failedThresholds,
  };
}
