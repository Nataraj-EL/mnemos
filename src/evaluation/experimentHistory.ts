import { ExperimentRunRecord, ExperimentResult } from './types';
import { sanitizeSummary } from './regression';

export class ExperimentHistoryManager {
  private static historyMap = new Map<string, ExperimentRunRecord>();

  public static addRecord(result: ExperimentResult): ExperimentRunRecord {
    const randomId = 'exp-' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

    const controlConfig = JSON.parse(JSON.stringify(result.controlConfig));
    const candidateConfig = JSON.parse(JSON.stringify(result.candidateConfig));

    const controlSummary = sanitizeSummary(result.controlSummary);
    const candidateSummary = sanitizeSummary(result.candidateSummary);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sanitizedDeltas: Record<string, any> = {};
    for (const [k, d] of Object.entries(result.comparison.deltas)) {
      sanitizedDeltas[k] = {
        absolute: d.absolute,
        percentage: d.percentage,
        type: d.type,
      };
    }
    const comparison = {
      baselineAvailable: result.comparison.baselineAvailable,
      baselineLabel: result.comparison.baselineLabel,
      status: result.comparison.status,
      failedThresholds: [...result.comparison.failedThresholds],
      deltas: sanitizedDeltas,
    };

    const record: ExperimentRunRecord = {
      id: randomId,
      timestamp: new Date().toISOString(),
      controlConfig,
      candidateConfig,
      controlSummary,
      candidateSummary,
      comparison,
      recommendation: result.recommendation,
      recommendationExplanation: result.recommendationExplanation,
    };

    if (this.historyMap.size >= 20) {
      const oldestId = this.historyMap.keys().next().value;
      if (oldestId !== undefined) {
        this.historyMap.delete(oldestId);
      }
    }

    this.historyMap.set(randomId, record);
    return record;
  }

  public static listRecords(): ExperimentRunRecord[] {
    return Array.from(this.historyMap.values()).reverse();
  }

  public static getRecord(id: string): ExperimentRunRecord | undefined {
    const record = this.historyMap.get(id);
    if (!record) return undefined;
    return JSON.parse(JSON.stringify(record));
  }

  public static deleteRecord(id: string): boolean {
    return this.historyMap.delete(id);
  }

  public static clearHistory(): void {
    this.historyMap.clear();
  }
}
