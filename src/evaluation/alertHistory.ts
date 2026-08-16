import { EvaluationAlert, EvaluationAlertRecord } from './types';

export class EvaluationAlertHistoryManager {
  private static records: EvaluationAlertRecord[] = [];
  private static readonly MAX_RECORDS = 50;

  private static deepClone<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    return JSON.parse(JSON.stringify(obj));
  }

  private static sanitizeAlert(alert: EvaluationAlert): EvaluationAlert {
    const cloned = this.deepClone(alert);
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

  private static getConditionKey(alert: EvaluationAlert): string {
    return `${alert.metric || 'gate'}-${alert.severity}-${alert.message}`;
  }

  public static addAlertRecord(alert: EvaluationAlert): EvaluationAlertRecord {
    const sanitizedAlert = this.sanitizeAlert(alert);
    const conditionKey = this.getConditionKey(sanitizedAlert);

    const existing = this.records.find(
      (r) => this.getConditionKey(r.alert) === conditionKey && (r.status === 'open' || r.status === 'acknowledged')
    );

    if (existing) {
      return this.deepClone(existing);
    }

    if (this.records.length >= this.MAX_RECORDS) {
      this.records.shift();
    }

    const timestamp = new Date().toISOString();
    const id = `alr_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`;
    const record: EvaluationAlertRecord = {
      id,
      alert: sanitizedAlert,
      status: 'open',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.records.push(record);
    return this.deepClone(record);
  }

  public static listAlerts(): EvaluationAlertRecord[] {
    const cloned = this.deepClone(this.records);
    cloned.reverse();
    cloned.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return cloned;
  }

  public static acknowledge(id: string): boolean {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return false;

    if (rec.status === 'open') {
      rec.status = 'acknowledged';
      rec.updatedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  public static resolve(id: string): boolean {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return false;

    if (rec.status === 'open' || rec.status === 'acknowledged') {
      rec.status = 'resolved';
      rec.updatedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  public static reopen(id: string): boolean {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return false;

    if (rec.status === 'resolved') {
      rec.status = 'open';
      rec.updatedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  public static clearHistory(): void {
    this.records = [];
  }
}
