import { EvaluationRemediation } from './types';
import { EvaluationAlertHistoryManager } from './alertHistory';
import { EvaluationAlertCorrelationManager } from './alertCorrelation';
import { EvaluationReportInsightsManager } from './reportInsights';
import { PromotionHistoryManager } from './promotionHistory';

export class EvaluationRemediationManager {
  private static deepClone<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    return JSON.parse(JSON.stringify(obj));
  }

  public static async generateRemediations(): Promise<EvaluationRemediation[]> {
    const alerts = EvaluationAlertHistoryManager.listAlerts();
    const activeAlerts = alerts.filter((a) => a.status === 'open' || a.status === 'acknowledged');
    if (activeAlerts.length === 0) {
      return [];
    }

    // Call correlation manager (excludes resolved alerts)
    const correlations = await EvaluationAlertCorrelationManager.correlateAlerts(false);

    // Call report insights to check recurring degradations
    const reportInsights = await EvaluationReportInsightsManager.generateInsights();
    const recurringDegradations = reportInsights.recurringDegradations || [];

    const promotions = PromotionHistoryManager.listRecords();

    const rawRemediations: EvaluationRemediation[] = [];

    for (const record of activeAlerts) {
      const alert = record.alert;
      const metric = alert.metric || '';
      const correlation = correlations.find((c) => c.alertId === record.id);
      if (!correlation) {
        continue;
      }

      // 1. Omit if no correlation exists and not recurring
      const isRecurring = metric && recurringDegradations.includes(metric);
      if (correlation.likelyCause === 'unknown' && !isRecurring) {
        continue; // Omit recommendation entirely when no evidence is found
      }

      let action = '';
      let reason = '';

      // 2. Map metric to recommendation
      if (isRecurring) {
        action = 'Recommend running a controlled A/B experiment.';
        reason = 'Metric has degraded repeatedly across sequential runs.';
      } else if (metric === 'relevance' || metric === 'retrievalRecall') {
        action = 'Evaluate semantic/lexical weighting parameters.';
        reason = 'Relevance and recall are affected by weights configuration.';
      } else if (metric === 'contextPrecision') {
        action = 'Review similarity threshold and conversation snippet selection.';
        reason = 'Precision is impacted by snippet filtering thresholds.';
      } else if (metric === 'averageLatency') {
        // Only suggest reducing snippets when maxConversationSnippets is actually implicated by configuration changes
        let snippetsImplicated = false;
        for (const promoId of correlation.relatedRecordIds) {
          const promo = promotions.find((p) => p.id === promoId);
          if (promo && promo.previousConfig && promo.newConfig) {
            if (promo.previousConfig.maxConversationSnippets !== promo.newConfig.maxConversationSnippets) {
              snippetsImplicated = true;
              break;
            }
          }
        }

        if (snippetsImplicated) {
          action = 'Reduce conversation snippets count.';
          reason = 'Snippet count increase is correlated with average latency increase.';
        } else {
          action = 'Inspect retrieval path latency.';
          reason = 'Latency regression is typically linked to heavy snippet counts.';
        }
      } else if (metric === 'timeoutCount' || metric === 'retryRate' || metric === 'fallbackRate') {
        action = 'Inspect retrieval resilience and timeout limits.';
        reason = 'Health regressions indicate remote provider connection issues.';
      } else {
        // Fallback / unsupported metrics
        continue;
      }

      // 3. Calculate priority:
      // critical -> high
      // warning + high confidence -> high
      // warning + medium confidence -> medium
      // info/low confidence -> low
      let priority: 'high' | 'medium' | 'low' = 'low';
      if (alert.severity === 'critical') {
        priority = 'high';
      } else if (alert.severity === 'warning') {
        if (correlation.confidence === 'high') {
          priority = 'high';
        } else if (correlation.confidence === 'medium') {
          priority = 'medium';
        } else {
          priority = 'low';
        }
      } else {
        priority = 'low';
      }

      // Propagate correlation confidence: match it, fallback to low
      const confidence = correlation.confidence || 'low';

      // 4. Sanitize evidenceIds (collect only existing IDs prefix aud-, exp-, rpt-, alr-)
      const validEvidenceIds = [record.id, ...correlation.relatedRecordIds].filter((id) =>
        id.startsWith('alr_') || id.startsWith('aud-') || id.startsWith('exp-') || id.startsWith('rpt-')
      );

      rawRemediations.push({
        alertId: record.id,
        priority,
        action,
        reason,
        evidenceIds: Array.from(new Set(validEvidenceIds)).sort(),
        confidence,
      });
    }

    // 5. Consolidate and merge identical recommendation actions
    const consolidatedMap = new Map<string, EvaluationRemediation>();

    for (const rem of rawRemediations) {
      const existing = consolidatedMap.get(rem.action);
      if (existing) {
        const mergedEvidences = Array.from(new Set([...existing.evidenceIds, ...rem.evidenceIds])).sort();

        const priorityOrder = { high: 3, medium: 2, low: 1 };
        const newPriority = priorityOrder[rem.priority] > priorityOrder[existing.priority] ? rem.priority : existing.priority;

        const confidenceOrder = { high: 3, medium: 2, low: 1 };
        const newConfidence = confidenceOrder[rem.confidence] > confidenceOrder[existing.confidence] ? rem.confidence : existing.confidence;

        existing.evidenceIds = mergedEvidences;
        existing.priority = newPriority;
        existing.confidence = newConfidence;
        if (!existing.alertId.includes(rem.alertId)) {
          existing.alertId = `${existing.alertId},${rem.alertId}`;
        }
      } else {
        consolidatedMap.set(rem.action, this.deepClone(rem));
      }
    }

    const remediations = Array.from(consolidatedMap.values());

    // 6. Deterministic Sort: priority high > medium > low, then alphabetical action
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    remediations.sort((a, b) => {
      const pA = priorityOrder[a.priority];
      const pB = priorityOrder[b.priority];
      if (pA !== pB) {
        return pB - pA;
      }
      return a.action.localeCompare(b.action);
    });

    return remediations;
  }
}
