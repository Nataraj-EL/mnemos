import { EvaluationReport, EvaluationReportRecord, ReportComparisonResult } from './types';

export class EvaluationReportHistoryManager {
  private static reports: EvaluationReportRecord[] = [];
  private static readonly MAX_REPORTS = 20;

  private static deepClone<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    return JSON.parse(JSON.stringify(obj));
  }

  private static sanitizeReport(report: EvaluationReport): EvaluationReport {
    const cloned = this.deepClone(report);

    const keysToStrip = ['diagnostics', 'prompts', 'sql', 'uuid', 'apiKey', 'provider', 'transcripts', 'payloads'];

    const stripKeys = (obj: unknown) => {
      if (!obj || typeof obj !== 'object') return;
      const record = obj as Record<string, unknown>;
      for (const key of keysToStrip) {
        if (key in record) {
          delete record[key];
        }
      }
      for (const val of Object.values(record)) {
        if (val && typeof val === 'object') {
          stripKeys(val);
        }
      }
    };

    stripKeys(cloned);
    return cloned;
  }

  public static addReport(report: EvaluationReport): EvaluationReportRecord {
    if (this.reports.length >= this.MAX_REPORTS) {
      this.reports.shift();
    }

    const sanitized = this.sanitizeReport(report);
    const id = `rpt_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`;
    const record: EvaluationReportRecord = {
      id,
      timestamp: new Date().toISOString(),
      report: sanitized,
    };

    this.reports.push(record);
    return this.deepClone(record);
  }

  public static listReports(): EvaluationReportRecord[] {
    return this.deepClone(this.reports).reverse();
  }

  public static getReport(id: string): EvaluationReportRecord | undefined {
    const rec = this.reports.find((r) => r.id === id);
    if (!rec) return undefined;
    return this.deepClone(rec);
  }

  public static deleteReport(id: string): boolean {
    const initialLength = this.reports.length;
    this.reports = this.reports.filter((r) => r.id !== id);
    return this.reports.length < initialLength;
  }

  public static clearHistory(): void {
    this.reports = [];
  }

  public static compareReports(baseId: string, targetId: string): ReportComparisonResult {
    const baseRecord = this.getReport(baseId);
    const targetRecord = this.getReport(targetId);

    if (!baseRecord || !targetRecord) {
      throw new Error('Comparison reports not found in history.');
    }

    const base = baseRecord.report;
    const target = targetRecord.report;

    const metricsToCompare = [
      'retrievalRecall',
      'contextPrecision',
      'relevance',
      'faithfulness',
      'citationCorrectness',
      'averageLatency',
      'successRate',
    ];

    const deltas: Record<string, { base: number | string; target: number | string; absolute?: number }> = {};

    for (const metric of metricsToCompare) {
      const baseVal = base.latestRunSummary
        ? (base.latestRunSummary as unknown as Record<string, number | undefined>)[metric]
        : undefined;
      const targetVal = target.latestRunSummary
        ? (target.latestRunSummary as unknown as Record<string, number | undefined>)[metric]
        : undefined;

      if (baseVal !== undefined && targetVal !== undefined) {
        deltas[metric] = {
          base: baseVal,
          target: targetVal,
          absolute: targetVal - baseVal,
        };
      } else {
        deltas[metric] = {
          base: baseVal !== undefined ? baseVal : 'notComparable',
          target: targetVal !== undefined ? targetVal : 'notComparable',
        };
      }
    }

    return {
      baseReportId: baseId,
      targetReportId: targetId,
      statusChange: {
        base: base.regressionStatus,
        target: target.regressionStatus,
      },
      gateStatusChange: {
        base: base.qualityGate?.status || 'pass',
        target: target.qualityGate?.status || 'pass',
      },
      deltas,
    };
  }
}
