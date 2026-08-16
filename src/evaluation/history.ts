import { EvalSummary, EvaluationRunRecord } from './types';
import { sanitizeSummary } from './regression';

export class EvaluationHistoryManager {
  private static runs: EvaluationRunRecord[] = [];
  private static readonly MAX_RUNS = 20;

  public static addRun(summary: EvalSummary): EvaluationRunRecord {
    if (this.runs.length >= this.MAX_RUNS) {
      this.runs.shift();
    }

    const record: EvaluationRunRecord = {
      id: `run_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      timestamp: new Date().toISOString(),
      summary: sanitizeSummary(summary),
    };

    this.runs.push(record);
    return record;
  }

  public static listRuns(): EvaluationRunRecord[] {
    return [...this.runs].reverse();
  }

  public static getRun(id: string): EvaluationRunRecord | undefined {
    return this.runs.find((r) => r.id === id);
  }

  public static deleteRun(id: string): boolean {
    const initialLength = this.runs.length;
    this.runs = this.runs.filter((r) => r.id !== id);
    return this.runs.length < initialLength;
  }

  public static clearHistory(): void {
    this.runs = [];
  }
}
