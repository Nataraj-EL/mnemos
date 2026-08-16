import { EvaluationAlertsSummary, EvaluationAlert } from './types';
import { EvaluationReportHistoryManager } from './reportHistory';
import { EvaluationReportInsightsManager } from './reportInsights';

export const LATENCY_ESCALATION_MS = 1000;

export const METRIC_RECOMMENDATIONS: Record<string, string> = {
  retrievalRecall: 'Optimize diversity thresholds or increase snippets limit to capture missing context.',
  contextPrecision: 'Fine-tune similarity filters or context formatting to reduce irrelevant segments.',
  relevance: 'Review response generation prompt structures or update model settings to focus on query alignment.',
  faithfulness: 'Enforce strict factual checking or lower similarity boundaries to prevent hallucinations.',
  citationCorrectness: 'Adjust grounding validators or verification steps to align citations with context source list.',
  successRate: 'Audit query routing rules or connection pools to mitigate execution failures.',
  averageLatency: 'Decrease conversation snippets limit or optimize embedding retrievals to speed up responses.',
  timeoutCount: 'Increase stage timeouts or optimize indexing to prevent query timeouts.',
  fallbackRate: 'Check primary database availability or index structures to reduce reliance on fallback paths.',
  retryRate: 'Identify intermittent server connection bottlenecks or configure adaptive backoff options.',
  contextUtilization: 'Optimize snippet chunk sizes or pruning parameters to utilize relevant content.',
  cacheHitRate: 'Increase cache expiration times or normalize search keys to improve reuse rate.',
};

export class EvaluationAlertManager {
  public static async generateAlerts(): Promise<EvaluationAlertsSummary> {
    const timestamp = new Date().toISOString();
    const reports = EvaluationReportHistoryManager.listReports();

    if (reports.length === 0) {
      return {
        alerts: [],
        timestamp,
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
      };
    }

    const insights = await EvaluationReportInsightsManager.generateInsights();
    const newestReport = reports[0].report;
    const gateStatus = newestReport.qualityGate?.status || 'pass';

    const tempAlerts: EvaluationAlert[] = [];

    // 1. Quality Gate Block/Warning
    if (gateStatus === 'block') {
      tempAlerts.push({
        id: `gate-block-${timestamp}`,
        severity: 'critical',
        message: `Evaluation Quality Gate is blocked: ${newestReport.qualityGate?.reasons.join(', ') || 'No reasons provided.'}`,
        timestamp,
      });
    } else if (gateStatus === 'warning') {
      tempAlerts.push({
        id: `gate-warning-${timestamp}`,
        severity: 'warning',
        message: `Evaluation Quality Gate has warnings: ${newestReport.qualityGate?.reasons.join(', ') || 'No reasons provided.'}`,
        timestamp,
      });
    }

    // 2. Recurring Degradations
    const recurringMetrics = new Set(insights.recurringDegradations);
    for (const metric of insights.recurringDegradations) {
      const rec = METRIC_RECOMMENDATIONS[metric] || 'Review recent parameter changes immediately.';
      tempAlerts.push({
        id: `recurring-degradation-${metric}-${timestamp}`,
        metric,
        severity: 'critical',
        message: `Recurring Degradation: ${metric} degraded across sequential runs. Recommended Action: ${rec}`,
        timestamp,
      });
    }

    // 3. Trends & Regressions
    if (!insights.insufficientHistory && insights.trends) {
      for (const [metric, trend] of Object.entries(insights.trends)) {
        if (recurringMetrics.has(metric)) {
          continue;
        }

        if (trend.type === 'degrading') {
          const deltaVal = trend.delta || 0;
          if (metric === 'averageLatency') {
            const absDelta = Math.abs(deltaVal);
            if (absDelta >= LATENCY_ESCALATION_MS) {
              const rec = METRIC_RECOMMENDATIONS[metric] || 'Review latency settings.';
              tempAlerts.push({
                id: `latency-escalation-${timestamp}`,
                metric,
                severity: 'critical',
                message: `Latency Escalation: averageLatency increased significantly by +${Math.round(absDelta)}ms. Recommended Action: ${rec}`,
                delta: deltaVal,
                timestamp,
              });
            } else {
              const rec = METRIC_RECOMMENDATIONS[metric] || 'Review latency settings.';
              tempAlerts.push({
                id: `latency-warning-${timestamp}`,
                metric,
                severity: 'warning',
                message: `Latency Regression: averageLatency increased by +${Math.round(absDelta)}ms. Recommended Action: ${rec}`,
                delta: deltaVal,
                timestamp,
              });
            }
          } else if (['timeoutCount', 'fallbackRate', 'retryRate'].includes(metric)) {
            const rec = METRIC_RECOMMENDATIONS[metric] || 'Review health settings.';
            tempAlerts.push({
              id: `health-warning-${metric}-${timestamp}`,
              metric,
              severity: 'warning',
              message: `Health Regression: ${metric} shows degrading performance trend. Recommended Action: ${rec}`,
              delta: deltaVal,
              timestamp,
            });
          } else {
            const rec = METRIC_RECOMMENDATIONS[metric] || 'Review parameters override settings.';
            tempAlerts.push({
              id: `metric-degradation-${metric}-${timestamp}`,
              metric,
              severity: 'warning',
              message: `Performance Regression: ${metric} showed a regressive trend. Recommended Action: ${rec}`,
              delta: deltaVal,
              timestamp,
            });
          }
        } else if (trend.type === 'improving') {
          if (gateStatus !== 'block') {
            const deltaVal = trend.delta || 0;
            const rec = METRIC_RECOMMENDATIONS[metric] || 'No actions required.';
            tempAlerts.push({
              id: `metric-improvement-${metric}-${timestamp}`,
              metric,
              severity: 'info',
              message: `Sustained Improvement: ${metric} showed a positive trend. Recommended Action: ${rec}`,
              delta: deltaVal,
              timestamp,
            });
          }
        }
      }
    }

    // Deduplication by metric + severity + message
    const dedupedAlerts: EvaluationAlert[] = [];
    const seen = new Set<string>();

    for (const alert of tempAlerts) {
      const key = `${alert.metric || 'gate'}-${alert.severity}-${alert.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        dedupedAlerts.push(alert);
      }
    }

    // Deterministic Sorting: critical > warning > info, then alphabetical by metric/id
    const severityWeight = { critical: 3, warning: 2, info: 1 };
    dedupedAlerts.sort((a, b) => {
      const wa = severityWeight[a.severity];
      const wb = severityWeight[b.severity];
      if (wa !== wb) {
        return wb - wa;
      }
      const ma = a.metric || a.id;
      const mb = b.metric || b.id;
      return ma.localeCompare(mb);
    });

    let criticalCount = 0;
    let warningCount = 0;
    let infoCount = 0;

    for (const a of dedupedAlerts) {
      if (a.severity === 'critical') criticalCount++;
      else if (a.severity === 'warning') warningCount++;
      else if (a.severity === 'info') infoCount++;
    }

    return {
      alerts: dedupedAlerts,
      timestamp,
      criticalCount,
      warningCount,
      infoCount,
    };
  }
}
