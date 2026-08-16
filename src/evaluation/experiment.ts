import { EvaluationRunner } from './runner';
import { TuningConfig, ExperimentResult } from './types';
import { compareSummaries, DEFAULT_THRESHOLDS } from './regression';
import { EVAL_DATASET } from './dataset';

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
}
