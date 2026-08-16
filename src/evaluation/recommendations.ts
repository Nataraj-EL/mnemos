import { EvaluationHistoryManager } from './history';
import { EvaluationInsightsManager } from './insights';
import { EvaluationRecommendation } from './types';

export const RECOMMENDATION_THRESHOLDS = {
  faithfulness: 0.85,
  relevance: 0.85,
  retrievalRecall: 0.80,
  averageLatencyCritical: 3000,
  averageLatencyWarning: 1500,
  cacheHitRate: 0.60,
  timeoutCount: 1,
  fallbackRate: 0.30,
  retryRate: 0.20,
};

export class EvaluationRecommendationsManager {
  public static generateRecommendations(): EvaluationRecommendation[] {
    const runs = EvaluationHistoryManager.listRuns();
    if (runs.length === 0) {
      return [];
    }

    const latest = runs[0];
    const insights = EvaluationInsightsManager.generateInsights();
    
    const recs: EvaluationRecommendation[] = [];

    const formatPct = (val: number) => `${(val * 100).toFixed(0)}%`;
    const formatMs = (val: number) => `${Math.round(val)} ms`;

    // 1. Faithfulness
    const faithfulness = latest.summary.faithfulness;
    if (faithfulness !== undefined && faithfulness < RECOMMENDATION_THRESHOLDS.faithfulness) {
      const trend = insights.trends?.faithfulness?.type;
      recs.push({
        id: 'rec-faithfulness-low',
        metric: 'faithfulness',
        value: formatPct(faithfulness),
        severity: 'critical',
        action: 'Grounding quality is low. Review LLM context limits or adjust strictness prompts.',
        trend,
      });
    }

    // 2. Relevance
    const relevance = latest.summary.relevance;
    if (relevance !== undefined && relevance < RECOMMENDATION_THRESHOLDS.relevance) {
      const trend = insights.trends?.relevance?.type;
      if (trend !== 'improving') {
        recs.push({
          id: 'rec-relevance-low',
          metric: 'relevance',
          value: formatPct(relevance),
          severity: 'warning',
          action: 'Retrieved context relevance is low. Review semantic search relevance tolerances.',
          trend,
        });
      }
    }

    // 3. Retrieval Recall
    const retrievalRecall = latest.summary.retrievalRecall;
    if (retrievalRecall !== undefined && retrievalRecall < RECOMMENDATION_THRESHOLDS.retrievalRecall) {
      const trend = insights.trends?.retrievalRecall?.type;
      recs.push({
        id: 'rec-recall-low',
        metric: 'retrievalRecall',
        value: formatPct(retrievalRecall),
        severity: 'critical',
        action: 'Retrieval recall is low. Review indexing pipelines and database search configs.',
        trend,
      });
    }

    // 4. Latency
    const latency = latest.summary.averageLatency;
    if (latency !== undefined) {
      const trend = insights.trends?.averageLatency?.type;
      if (latency > RECOMMENDATION_THRESHOLDS.averageLatencyCritical) {
        recs.push({
          id: 'rec-latency-critical',
          metric: 'averageLatency',
          value: formatMs(latency),
          severity: 'critical',
          action: 'High latency bottleneck. Audit database latency and network configurations.',
          trend,
        });
      } else if (latency > RECOMMENDATION_THRESHOLDS.averageLatencyWarning) {
        if (trend !== 'improving') {
          recs.push({
            id: 'rec-latency-warning',
            metric: 'averageLatency',
            value: formatMs(latency),
            severity: 'warning',
            action: 'Latency is elevated. Monitor Timing stats and limit retrieved size limits.',
            trend,
          });
        }
      }
    }

    // 5. Cache Efficiency
    const cacheHitRate = latest.summary.cacheHitRate;
    if (cacheHitRate !== undefined && cacheHitRate < RECOMMENDATION_THRESHOLDS.cacheHitRate) {
      const trend = insights.trends?.cacheHitRate?.type;
      if (trend !== 'improving') {
        recs.push({
          id: 'rec-cache-low',
          metric: 'cacheHitRate',
          value: formatPct(cacheHitRate),
          severity: 'info',
          action: 'Cache hit rate is sub-optimal. Consider tweaking TTL or cache keys.',
          trend,
        });
      }
    }

    // 6. Timeouts
    const timeoutCount = latest.summary.timeoutCount;
    if (timeoutCount !== undefined && timeoutCount >= RECOMMENDATION_THRESHOLDS.timeoutCount) {
      const trend = insights.trends?.timeoutCount?.type;
      if (trend !== 'improving') {
        recs.push({
          id: 'rec-timeout-high',
          metric: 'timeoutCount',
          value: `${timeoutCount}`,
          severity: 'warning',
          action: 'Multiple timeouts detected. Check retrieval timeout limits and pipeline stability.',
          trend,
        });
      }
    }

    // 7. Fallbacks
    const fallbackRate = latest.summary.fallbackRate;
    if (fallbackRate !== undefined && fallbackRate > RECOMMENDATION_THRESHOLDS.fallbackRate) {
      const trend = insights.trends?.fallbackRate?.type;
      if (trend !== 'improving') {
        recs.push({
          id: 'rec-fallback-high',
          metric: 'fallbackRate',
          value: formatPct(fallbackRate),
          severity: 'info',
          action: 'High fallback usage detected. Check index health or lower minSimilarity limit.',
          trend,
        });
      }
    }

    // 8. Retries
    const retryRate = latest.summary.retryRate;
    if (retryRate !== undefined && retryRate > RECOMMENDATION_THRESHOLDS.retryRate) {
      const trend = insights.trends?.retryRate?.type;
      if (trend !== 'improving') {
        recs.push({
          id: 'rec-retry-high',
          metric: 'retryRate',
          value: formatPct(retryRate),
          severity: 'info',
          action: 'High rate of API retries. Check provider availability constraints.',
          trend,
        });
      }
    }

    const severityMap: Record<string, number> = {
      critical: 0,
      warning: 1,
      info: 2,
    };

    recs.sort((a, b) => {
      const severityDiff = severityMap[a.severity] - severityMap[b.severity];
      if (severityDiff !== 0) {
        return severityDiff;
      }
      return a.id.localeCompare(b.id);
    });

    return recs.slice(0, 5);
  }
}
