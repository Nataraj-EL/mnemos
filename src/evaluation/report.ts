import { EvaluationReport } from './types';
import { EvaluationHistoryManager } from './history';
import { BaselineManager, compareSummaries } from './regression';
import { EvaluationConfigPromotionManager } from './promotion';
import { EvaluationRecommendationsManager } from './recommendations';
import { EvaluationInsightsManager } from './insights';
import { ExperimentHistoryManager } from './experimentHistory';
import { EvaluationQualityGateManager } from './qualityGate';

export class EvaluationReportManager {
  private static deepClone<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    return JSON.parse(JSON.stringify(obj));
  }

  private static sanitizeConfig(config: import('./types').TuningConfig | null): import('./types').TuningConfig | null {
    if (!config) return null;
    const cloned = this.deepClone(config);
    const keysToStrip = ['diagnostics', 'prompts', 'sql', 'uuid', 'apiKey', 'provider'];
    for (const key of keysToStrip) {
      if (key in cloned) {
        delete (cloned as unknown as Record<string, unknown>)[key];
      }
    }
    return cloned;
  }

  public static async generateReport(): Promise<EvaluationReport> {
    const timestamp = new Date().toISOString();

    const runs = EvaluationHistoryManager.listRuns();
    if (runs.length === 0) {
      return {
        timestamp,
        latestRunSummary: null,
        qualityGate: null,
        baselineAvailable: false,
        regressionStatus: 'notComparable',
        healthMetrics: null,
        trendSummary: null,
        promotedConfig: null,
        recommendations: [],
        experimentSummary: null,
      };
    }

    const latestRun = runs[0];
    const latest = latestRun.summary;

    const qualityGate = await EvaluationQualityGateManager.evaluateGate();

    const baseline = BaselineManager.getBaseline();
    const baselineAvailable = baseline !== null;
    let regressionStatus: 'pass' | 'warning' | 'fail' | 'notComparable' = 'notComparable';

    if (baselineAvailable) {
      const comp = compareSummaries(latest, baseline);
      regressionStatus = comp.status;
    }

    const healthMetrics = {
      timeoutCount: latest.timeoutCount,
      retryRate: latest.retryRate,
      fallbackRate: latest.fallbackRate,
      cacheHitRate: latest.cacheHitRate,
      successRate: latest.successRate,
    };

    const insights = EvaluationInsightsManager.generateInsights();
    let trendSummary = null;
    if (insights.status !== 'insufficient' && insights.trends) {
      const improving: string[] = [];
      const degrading: string[] = [];
      for (const [metric, trend] of Object.entries(insights.trends)) {
        if (trend.type === 'improving') {
          improving.push(metric);
        } else if (trend.type === 'degrading') {
          degrading.push(metric);
        }
      }
      trendSummary = { improving, degrading };
    }

    const promotedConfig = this.sanitizeConfig(EvaluationConfigPromotionManager.getCurrentConfig());

    const recs = EvaluationRecommendationsManager.generateRecommendations();
    const recommendations = recs.map((r) => r.action);

    const expHistory = ExperimentHistoryManager.listRecords();
    const experimentSummary = expHistory.length > 0 ? {
      recommendation: expHistory[0].recommendation,
      explanation: expHistory[0].recommendationExplanation,
    } : null;

    return {
      timestamp,
      latestRunSummary: this.deepClone(latest),
      qualityGate,
      baselineAvailable,
      regressionStatus,
      healthMetrics,
      trendSummary,
      promotedConfig,
      recommendations,
      experimentSummary,
    };
  }
}
