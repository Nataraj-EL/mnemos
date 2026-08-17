import { RemediationExecutionRecord, TuningConfig } from './types';
import { EvaluationConfigPromotionManager } from './promotion';
import { ConfigSafetyGuard } from './configGuard';

export class EvaluationRemediationExecutionManager {
  private static executions: RemediationExecutionRecord[] = [];

  private static deepClone<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    return JSON.parse(JSON.stringify(obj));
  }

  private static sanitizeConfig(config: TuningConfig | null): TuningConfig | null {
    if (!config) return null;
    const cloned = this.deepClone(config);
    const keysToStrip = ['diagnostics', 'prompts', 'sql', 'uuid', 'apiKey', 'provider', 'secrets'];
    const traverseAndStrip = (current: unknown) => {
      if (typeof current !== 'object' || current === null) return;
      const obj = current as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (keysToStrip.includes(key)) {
          delete obj[key];
        } else {
          traverseAndStrip(obj[key]);
        }
      }
    };
    traverseAndStrip(cloned);
    return cloned;
  }

  private static sanitizeRecord(rec: RemediationExecutionRecord): RemediationExecutionRecord {
    const cloned = this.deepClone(rec);
    cloned.previousConfig = this.sanitizeConfig(cloned.previousConfig);
    cloned.appliedConfig = this.sanitizeConfig(cloned.appliedConfig);
    return cloned;
  }

  public static listExecutions(): RemediationExecutionRecord[] {
    return this.executions.map((rec) => this.sanitizeRecord(rec));
  }

  public static getExecution(id: string): RemediationExecutionRecord | null {
    const rec = this.executions.find((e) => e.id === id);
    if (!rec) return null;
    return this.sanitizeRecord(rec);
  }

  public static clearHistory(): void {
    this.executions = [];
  }

  public static recordExecution(
    record: Omit<RemediationExecutionRecord, 'id' | 'executedAt'>
  ): RemediationExecutionRecord {
    const id = `exe-${Math.random().toString(36).substring(2, 11)}`;
    const executedAt = new Date().toISOString();

    const newRecord: RemediationExecutionRecord = {
      id,
      proposalId: record.proposalId,
      executedAt,
      previousConfig: this.deepClone(record.previousConfig),
      appliedConfig: this.deepClone(record.appliedConfig),
      status: record.status,
      rollbackAt: record.rollbackAt,
      auditId: record.auditId,
    };

    const sanitized = this.sanitizeRecord(newRecord);
    this.executions.unshift(sanitized);

    // FIFO eviction max 20, newest first
    if (this.executions.length > 20) {
      this.executions.pop();
    }

    return this.deepClone(sanitized);
  }

  public static rollback(id: string): boolean {
    const rec = this.executions.find((e) => e.id === id);
    if (!rec || rec.status !== 'success') {
      return false;
    }

    if (!rec.previousConfig) {
      return false;
    }

    // Revalidate config safety before rollback promotion
    const safetyCheck = ConfigSafetyGuard.validate(rec.previousConfig);
    if (!safetyCheck.valid) {
      return false;
    }

    // Promote previousConfig using developer config mechanism
    const auditRecord = EvaluationConfigPromotionManager.promote(rec.previousConfig);

    rec.status = 'rolled_back';
    rec.rollbackAt = new Date().toISOString();
    rec.auditId = auditRecord.id;

    return true;
  }
}
