import { EvaluationRunner } from './runner';
import { TuningConfig, ExperimentResult, ControlledExperimentResult, EvalSummary } from './types';
import { compareSummaries, DEFAULT_THRESHOLDS } from './regression';
import { EVAL_DATASET } from './dataset';
import { ConfigSafetyGuard } from './configGuard';

export class EvaluationExperimentRunner {
  private static isLocked = false;

  public static validateConfig(config: TuningConfig): void {
    const checkNum = (val: number, name: string) => {
      if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) {
        throw new Error(`Invalid configuration: ${name} must be a finite number.`);
      }
      if (val < 0) {
        throw new Error(`Invalid configuration: ${name} cannot be negative.`);
      }
    };

    checkNum(config.semanticWeight, 'semanticWeight');
    checkNum(config.lexicalWeight, 'lexicalWeight');
    checkNum(config.minSimilarity, 'minSimilarity');
    checkNum(config.diversityThreshold, 'diversityThreshold');
    checkNum(config.maxConversationSnippets, 'maxConversationSnippets');

    if (config.semanticWeight > 1.0) {
      throw new Error('Invalid configuration: semanticWeight cannot exceed 1.0.');
    }
    if (config.lexicalWeight > 1.0) {
      throw new Error('Invalid configuration: lexicalWeight cannot exceed 1.0.');
    }
    if (config.minSimilarity > 1.0) {
      throw new Error('Invalid configuration: minSimilarity cannot exceed 1.0.');
    }
    if (config.diversityThreshold > 1.0) {
      throw new Error('Invalid configuration: diversityThreshold cannot exceed 1.0.');
    }
    if (config.maxConversationSnippets > 100) {
      throw new Error('Invalid configuration: maxConversationSnippets limit is too large.');
    }
  }

  public static async runExperiment(
    controlConfig: TuningConfig,
    candidateConfig: TuningConfig
  ): Promise<ExperimentResult> {
    if (this.isLocked) {
      throw new Error('An experiment is already in progress. Please wait.');
    }

    this.isLocked = true;

    try {
      this.validateConfig(controlConfig);
      this.validateConfig(candidateConfig);

      const runner = new EvaluationRunner();

      // Enforce real pipeline benchmarkMode
      const controlRun = await runner.runAll(EVAL_DATASET, controlConfig, { benchmarkMode: 'real' });
      // Validate Control runs succeeded cleanly without system crashes
      const controlFailure = controlRun.results.find(r => r.failureReason && 
        (r.failureReason.includes('API key') || 
         r.failureReason.includes('environment variable') ||
         r.failureReason.includes('database') ||
         r.failureReason.includes('connection') ||
         r.failureReason.includes('fetch') ||
         r.failureReason.includes('not defined'))
      );
      if (controlFailure) {
        throw new Error(`Control run failed due to system/pipeline error: ${controlFailure.failureReason}`);
      }

      const candidateRun = await runner.runAll(EVAL_DATASET, candidateConfig, { benchmarkMode: 'real' });
      // Validate Candidate runs succeeded cleanly
      const candidateFailure = candidateRun.results.find(r => r.failureReason && 
        (r.failureReason.includes('API key') || 
         r.failureReason.includes('environment variable') ||
         r.failureReason.includes('database') ||
         r.failureReason.includes('connection') ||
         r.failureReason.includes('fetch') ||
         r.failureReason.includes('not defined'))
      );
      if (candidateFailure) {
        throw new Error(`Candidate run failed due to system/pipeline error: ${candidateFailure.failureReason}`);
      }

      const controlSummary = controlRun.summary;
      const candidateSummary = candidateRun.summary;

      // Deterministic Winner Logic
      const compCandidateToControl = compareSummaries(candidateSummary, controlSummary);
      const compControlToCandidate = compareSummaries(controlSummary, candidateSummary);

      let recommendation: 'control' | 'candidate' | 'draw' = 'draw';
      let explanation = '';

      if (compCandidateToControl.status === 'fail') {
        // Candidate has a critical regression relative to Control -> Control wins
        recommendation = 'control';
        explanation = `Control is recommended. Candidate configuration introduced critical quality regressions: ${compCandidateToControl.failedThresholds.join(', ')}.`;
      } else if (compControlToCandidate.status === 'fail') {
        // Control has a critical regression relative to Candidate -> Candidate wins
        recommendation = 'candidate';
        explanation = `Candidate is recommended. Control configuration introduced critical quality regressions: ${compControlToCandidate.failedThresholds.join(', ')}.`;
      } else {
        // Compare retrievalRecall, contextPrecision, relevance, and faithfulness
        let candidateVotes = 0;
        let controlVotes = 0;

        const metricsToCompare = ['retrievalRecall', 'contextPrecision', 'relevance', 'faithfulness'] as const;
        const tolerances: Record<string, number> = {
          retrievalRecall: DEFAULT_THRESHOLDS.retrievalRecallTolerance,
          contextPrecision: DEFAULT_THRESHOLDS.contextPrecisionTolerance,
          relevance: DEFAULT_THRESHOLDS.relevanceTolerance,
          faithfulness: DEFAULT_THRESHOLDS.faithfulnessTolerance,
        };

        for (const metric of metricsToCompare) {
          const candVal = candidateSummary[metric];
          const ctrlVal = controlSummary[metric];

          if (candVal !== undefined && ctrlVal !== undefined) {
            const diff = candVal - ctrlVal;
            const tol = tolerances[metric];
            if (diff > tol) {
              candidateVotes++;
            } else if (diff < -tol) {
              controlVotes++;
            }
          }
        }

        if (candidateVotes > controlVotes) {
          recommendation = 'candidate';
          explanation = `Candidate is recommended based on overall metric count improves (${candidateVotes} vs ${controlVotes}).`;
        } else if (controlVotes > candidateVotes) {
          recommendation = 'control';
          explanation = `Control is recommended based on overall metric count improves (${controlVotes} vs ${candidateVotes}).`;
        } else {
          // Tie-breaker: averageLatency
          const latencyDelta = candidateSummary.averageLatency - controlSummary.averageLatency;
          const latencyTolerance = DEFAULT_THRESHOLDS.latencyToleranceMs;

          if (latencyDelta < -latencyTolerance) {
            recommendation = 'candidate';
            explanation = `Candidate is recommended as tie-breaker due to significantly lower average latency (improved by ${Math.round(Math.abs(latencyDelta))} ms).`;
          } else if (latencyDelta > latencyTolerance) {
            recommendation = 'control';
            explanation = `Control is recommended as tie-breaker due to significantly lower average latency (improved by ${Math.round(latencyDelta)} ms).`;
          } else {
            recommendation = 'draw';
            explanation = 'The configurations are comparable. Performance metrics lie within standard tolerance boundaries.';
          }
        }
      }

      return {
        controlConfig,
        candidateConfig,
        controlSummary,
        candidateSummary,
        comparison: compCandidateToControl,
        recommendation,
        recommendationExplanation: explanation,
      };
    } finally {
      this.isLocked = false;
    }
  }

  public static async runControlledExperiment(
    baselineConfig: TuningConfig,
    candidateConfig: TuningConfig,
    evidenceIds: string[] = []
  ): Promise<ControlledExperimentResult> {
    if (this.isLocked) {
      throw new Error('An experiment is already in progress. Please wait.');
    }

    this.isLocked = true;

    try {
      const safetyCheck = ConfigSafetyGuard.validate(candidateConfig);
      if (!safetyCheck.valid) {
        throw new Error(`Invalid candidate configuration: ${safetyCheck.errors.join(', ')}`);
      }

      this.validateConfig(baselineConfig);
      this.validateConfig(candidateConfig);

      const runner = new EvaluationRunner();

      const controlRun = await runner.runAll(EVAL_DATASET, baselineConfig, { benchmarkMode: 'real' });
      const controlFailure = controlRun.results.find(r => r.failureReason && 
        (r.failureReason.includes('API key') || 
         r.failureReason.includes('environment variable') ||
         r.failureReason.includes('database') ||
         r.failureReason.includes('connection') ||
         r.failureReason.includes('fetch') ||
         r.failureReason.includes('not defined'))
      );
      if (controlFailure) {
        throw new Error(`Control run failed due to system/pipeline error: ${controlFailure.failureReason}`);
      }

      const candidateRun = await runner.runAll(EVAL_DATASET, candidateConfig, { benchmarkMode: 'real' });
      const candidateFailure = candidateRun.results.find(r => r.failureReason && 
        (r.failureReason.includes('API key') || 
         r.failureReason.includes('environment variable') ||
         r.failureReason.includes('database') ||
         r.failureReason.includes('connection') ||
         r.failureReason.includes('fetch') ||
         r.failureReason.includes('not defined'))
      );
      if (candidateFailure) {
        throw new Error(`Candidate run failed due to system/pipeline error: ${candidateFailure.failureReason}`);
      }

      const baselineSummary = controlRun.summary;
      const candidateSummary = candidateRun.summary;

      const metricsToCompare = [
        'relevance',
        'retrievalRecall',
        'contextPrecision',
        'faithfulness',
        'citationCorrectness'
      ];

      const tolerances: Record<string, number> = {
        relevance: DEFAULT_THRESHOLDS.relevanceTolerance,
        retrievalRecall: DEFAULT_THRESHOLDS.retrievalRecallTolerance,
        contextPrecision: DEFAULT_THRESHOLDS.contextPrecisionTolerance,
        faithfulness: DEFAULT_THRESHOLDS.faithfulnessTolerance,
        citationCorrectness: DEFAULT_THRESHOLDS.citationCorrectnessTolerance,
      };

      const metricsComparison: Record<string, {
        baseline: number;
        candidate: number;
        delta: number;
        status: 'improved' | 'degraded' | 'unchanged' | 'insufficientData';
      }> = {};

      let hasDegradation = false;
      let hasImprovement = false;

      for (const m of metricsToCompare) {
        const rawBase = baselineSummary[m as keyof EvalSummary];
        const rawCand = candidateSummary[m as keyof EvalSummary];
        const baseVal = typeof rawBase === 'number' ? rawBase : 0;
        const candVal = typeof rawCand === 'number' ? rawCand : 0;
        const delta = candVal - baseVal;
        const tol = tolerances[m];

        let status: 'improved' | 'degraded' | 'unchanged' | 'insufficientData' = 'unchanged';
        if (delta < -tol) {
          status = 'degraded';
          hasDegradation = true;
        } else if (delta > tol) {
          status = 'improved';
          hasImprovement = true;
        }

        metricsComparison[m] = {
          baseline: baseVal,
          candidate: candVal,
          delta,
          status
        };
      }

      const baseLat = baselineSummary.averageLatency;
      const candLat = candidateSummary.averageLatency;
      const deltaLat = candLat - baseLat;
      let latStatus: 'improved' | 'degraded' | 'unchanged' | 'insufficientData' = 'unchanged';

      const isLatDegraded = deltaLat > DEFAULT_THRESHOLDS.latencyToleranceMs || 
        (baseLat > 0 && (deltaLat / baseLat) > DEFAULT_THRESHOLDS.latencyRelativeTolerance);
      const isLatImproved = deltaLat < -DEFAULT_THRESHOLDS.latencyToleranceMs || 
        (baseLat > 0 && (deltaLat / baseLat) < -DEFAULT_THRESHOLDS.latencyRelativeTolerance);

      if (isLatDegraded) {
        latStatus = 'degraded';
        hasDegradation = true;
      } else if (isLatImproved) {
        latStatus = 'improved';
        hasImprovement = true;
      }

      metricsComparison['averageLatency'] = {
        baseline: baseLat,
        candidate: candLat,
        delta: deltaLat,
        status: latStatus
      };

      let decision: 'candidateBetter' | 'baselineBetter' | 'noSignificantDifference' | 'insufficientData' = 'noSignificantDifference';
      if (baselineSummary.total === 0 || candidateSummary.total === 0) {
        decision = 'insufficientData';
        for (const k of Object.keys(metricsComparison)) {
          metricsComparison[k].status = 'insufficientData';
        }
      } else if (hasDegradation) {
        decision = 'baselineBetter';
      } else if (hasImprovement) {
        decision = 'candidateBetter';
      }

      const compCandidateToControl = compareSummaries(candidateSummary, baselineSummary);
      const experimentId = 'exp-ctrl-' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);

      const result: ControlledExperimentResult = {
        experimentId,
        baselineConfig: JSON.parse(JSON.stringify(baselineConfig)),
        candidateConfig: JSON.parse(JSON.stringify(candidateConfig)),
        baselineSummary: JSON.parse(JSON.stringify(baselineSummary)),
        candidateSummary: JSON.parse(JSON.stringify(candidateSummary)),
        comparison: compCandidateToControl,
        decision,
        metricsComparison,
        timestamp: new Date().toISOString(),
        evidenceIds,
      };

      return result;
    } finally {
      this.isLocked = false;
    }
  }
}
