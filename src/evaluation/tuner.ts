import { EvalScenario, EvalScenarioResult, TuningConfig, TuningResult, TuningBenchmarkSummary, EvalScenarioMetrics } from './types';
import { EVAL_DATASET } from './dataset';
import { EvaluationRunner } from './runner';
import { getDbPool } from '@/db';
import { GeminiEmbeddingProvider } from '@/memory/geminiEmbedding';

export interface ScoringWeights {
  relevance: number;
  faithfulness: number;
  citationCorrectness: number;
  contextUtilization: number;
  retrievalRecall: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  relevance: 0.25,
  faithfulness: 0.25,
  citationCorrectness: 0.25,
  contextUtilization: 0.15,
  retrievalRecall: 0.10
};

// Global lock to prevent concurrent tuning executions
let isTuningActive = false;

/**
 * Returns whether a tuning benchmark run is currently in progress.
 */
export function getIsTuningActive(): boolean {
  return isTuningActive;
}

/**
 * Reset lock (primarily for test cleanup)
 */
export function resetTuningActiveLock(): void {
  isTuningActive = false;
}

/**
 * Cartesian matrix configurations generator.
 * Produces bounded combinations under a safety size threshold limit.
 */
export function generateTuningMatrix(): TuningConfig[] {
  // Define explicit configurations to avoid cartesian explosions
  const weights = [
    { semanticWeight: 0.8, lexicalWeight: 0.2 },
    { semanticWeight: 0.5, lexicalWeight: 0.5 }
  ];
  const minSimilarities = [0.0, 0.2];
  const diversityThresholds = [0.6, 0.8];
  const maxConversationSnippets = [2, 4];

  const matrix: TuningConfig[] = [];
  for (const w of weights) {
    for (const minSim of minSimilarities) {
      for (const div of diversityThresholds) {
        for (const maxSnip of maxConversationSnippets) {
          // Normalize weights so they sum to 1.0 safely
          const sum = w.semanticWeight + w.lexicalWeight;
          const semanticWeight = sum > 0 ? w.semanticWeight / sum : 1.0;
          const lexicalWeight = sum > 0 ? w.lexicalWeight / sum : 0.0;

          matrix.push({
            semanticWeight,
            lexicalWeight,
            minSimilarity: minSim,
            diversityThreshold: div,
            maxConversationSnippets: maxSnip
          });
        }
      }
    }
  }

  // Validate matrix limit
  if (matrix.length > 30) {
    throw new Error(`Matrix size limit exceeded: generated ${matrix.length} combinations, maximum is 30.`);
  }

  return matrix;
}

/**
 * Calculates a configurable, weighted benchmark score for a configuration's metrics.
 */
export function calculateBenchmarkScore(
  metrics: EvalScenarioMetrics,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): number {
  return (
    metrics.relevance * weights.relevance +
    metrics.faithfulness * weights.faithfulness +
    metrics.citationCorrectness * weights.citationCorrectness +
    metrics.contextUtilization * weights.contextUtilization +
    metrics.retrievalRecall * weights.retrievalRecall
  );
}

export class TuningRunner {
  private runner: EvaluationRunner;
  private scoringWeights: ScoringWeights;
  private timeoutMs: number;

  constructor(
    runner?: EvaluationRunner,
    scoringWeights?: ScoringWeights,
    timeoutMs: number = 15000 // 15 seconds execution timeout limit
  ) {
    this.runner = runner || new EvaluationRunner();
    this.scoringWeights = scoringWeights || DEFAULT_SCORING_WEIGHTS;
    this.timeoutMs = timeoutMs;
  }

  private getUuidForMockId(id: string): string {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(id)) {
      return id;
    }
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash << 5) - hash + id.charCodeAt(i);
      hash |= 0;
    }
    const hex = Math.abs(hash).toString(16).padStart(12, '0');
    return `e0a12e84-1111-2222-3333-${hex}`;
  }

  private async ingestSyntheticData(scenarios: EvalScenario[], evalRunId: string): Promise<void> {
    const pool = getDbPool();
    const embeddingProvider = new GeminiEmbeddingProvider();
    const embeddingCache = new Map<string, number[]>();
    const evalUserId = 'eval-user-sprint36-dedicated';

    for (const scenario of scenarios) {
      scenario.userId = evalUserId;

      // Ingest memories
      for (const memory of scenario.inputMemories) {
        memory.userId = evalUserId;

        let embedding = embeddingCache.get(memory.content);
        if (!embedding) {
          try {
            embedding = await embeddingProvider.generateEmbedding(memory.content);
            embeddingCache.set(memory.content, embedding);
          } catch (e) {
            console.error(`[Tuning Setup] Embedding generation failed for memory "${memory.content}":`, e);
            throw new Error(`Embedding setup failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
          }
        }

        const metadata = {
          ...memory.metadata,
          isSyntheticEval: true,
          originalId: memory.id,
          evalRunId,
        };

        const embeddingStr = `[${embedding.join(',')}]`;
        const memoryUuid = this.getUuidForMockId(memory.id);

        await pool.query(
          `INSERT INTO memories (id, user_id, type, content, metadata, embedding, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE SET
             user_id = EXCLUDED.user_id,
             type = EXCLUDED.type,
             content = EXCLUDED.content,
             metadata = EXCLUDED.metadata,
             embedding = EXCLUDED.embedding,
             updated_at = CURRENT_TIMESTAMP`,
          [
            memoryUuid,
            evalUserId,
            memory.type,
            memory.content,
            JSON.stringify(metadata),
            embeddingStr
          ]
        );
      }

      // Ingest conversations
      const lq = scenario.query.toLowerCase();
      if (lq.includes('yesterday') || lq.includes('combined')) {
        const convUuid = this.getUuidForMockId('conv-999');
        let convEmbedding = embeddingCache.get('We talked about PostgreSQL database setups.');
        if (!convEmbedding) {
          try {
            convEmbedding = await embeddingProvider.generateEmbedding('We talked about PostgreSQL database setups.');
            embeddingCache.set('We talked about PostgreSQL database setups.', convEmbedding);
          } catch (e) {
            console.error(`[Tuning Setup] Embedding generation failed for conversation:`, e);
            throw new Error(`Embedding setup failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
          }
        }
        const embeddingStr = `[${convEmbedding.join(',')}]`;
        const convSummary = `PostgreSQL setups summary [evalRunId: ${evalRunId}]`;

        await pool.query(
          `INSERT INTO conversations (id, user_id, started_at, ended_at, duration_seconds, transcript, summary, embedding, created_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $3, $4, $5, $6, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO UPDATE SET
             user_id = EXCLUDED.user_id,
             duration_seconds = EXCLUDED.duration_seconds,
             transcript = EXCLUDED.transcript,
             summary = EXCLUDED.summary,
             embedding = EXCLUDED.embedding`,
          [
            convUuid,
            evalUserId,
            120,
            'We talked about PostgreSQL database setups.',
            convSummary,
            embeddingStr
          ]
        );
      }
    }
  }

  private async cleanupSyntheticData(evalRunId: string): Promise<void> {
    const pool = getDbPool();
    // 1. Delete matching memories
    await pool.query(
      `DELETE FROM memories
       WHERE metadata->>'isSyntheticEval' = 'true'
         AND metadata->>'evalRunId' = $1`,
      [evalRunId]
    );

    // 2. Delete conversations matching run token
    const convUuid = this.getUuidForMockId('conv-999');
    await pool.query(
      `DELETE FROM conversations
       WHERE id = $1 AND summary LIKE $2`,
      [convUuid, `%[evalRunId: ${evalRunId}]%`]
    );
  }

  /**
   * Runs grounding evaluation benchmark dataset across the parameter tuning matrix configurations.
   */
  async runTuning(
    scenarios: EvalScenario[] = EVAL_DATASET,
    matrix: TuningConfig[] = generateTuningMatrix(),
    benchmarkMode: 'mock' | 'real' = 'real'
  ): Promise<TuningBenchmarkSummary> {
    if (isTuningActive) {
      throw new Error('Concurrent tuning execution blocked. A tuning run is already in progress.');
    }
    isTuningActive = true;

    const evalRunId = 'run-' + Math.random().toString(36).substring(2, 9);

    try {
      if (matrix.length > 30) {
        throw new Error(`Execution blocked: configuration matrix size is ${matrix.length}, which exceeds the max limit of 30.`);
      }

      if (benchmarkMode === 'real') {
        await this.ingestSyntheticData(scenarios, evalRunId);
      }

      // Wrap matrix execution in a timeout boundary
      const executionPromise = this.executeTuningMatrix(scenarios, matrix, benchmarkMode);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tuning execution timeout exceeded.')), this.timeoutMs)
      );

      const summary = await Promise.race([executionPromise, timeoutPromise]);
      return {
        ...summary,
        realPipelineExecuted: benchmarkMode === 'real',
      };
    } finally {
      if (benchmarkMode === 'real') {
        await this.cleanupSyntheticData(evalRunId);
      }
      isTuningActive = false;
    }
  }

  private async executeTuningMatrix(
    scenarios: EvalScenario[],
    matrix: TuningConfig[],
    benchmarkMode: 'mock' | 'real'
  ): Promise<Omit<TuningBenchmarkSummary, 'realPipelineExecuted'>> {
    const matrixResults: TuningResult[] = [];
    const totalScenarios = scenarios.length;

    for (const config of matrix) {
      let passedCount = 0;
      let failedCount = 0;

      // Accumulator metric variables
      let recallSum = 0;
      let precisionSum = 0;
      let isolationSum = 0;
      let deduplicationSum = 0;
      let tokenSum = 0;
      let relevanceSum = 0;
      let faithfulnessSum = 0;
      let citationSum = 0;
      let utilizationSum = 0;

      for (const scenario of scenarios) {
        try {
          const result: EvalScenarioResult = await this.runner.runScenario(scenario, config, { benchmarkMode });
          if (result.passed) {
            passedCount++;
          } else {
            failedCount++;
          }

          recallSum += result.metrics.retrievalRecall;
          precisionSum += result.metrics.contextPrecision;
          isolationSum += result.metrics.userIsolation;
          deduplicationSum += result.metrics.deduplicationRate;
          tokenSum += result.metrics.tokenCompliance;
          relevanceSum += result.metrics.relevance;
          faithfulnessSum += result.metrics.faithfulness;
          citationSum += result.metrics.citationCorrectness;
          utilizationSum += result.metrics.contextUtilization;
        } catch (error) {
          // Scenario failures must not crash the entire benchmark run. Count as failed and proceed.
          failedCount++;
          console.error(`Tuning scenario ${scenario.scenarioId} execution failure:`, error);
        }
      }

      const divisor = totalScenarios > 0 ? totalScenarios : 1;
      const averageMetrics: EvalScenarioMetrics = {
        retrievalRecall: recallSum / divisor,
        contextPrecision: precisionSum / divisor,
        userIsolation: isolationSum / divisor,
        deduplicationRate: deduplicationSum / divisor,
        tokenCompliance: tokenSum / divisor,
        relevance: relevanceSum / divisor,
        faithfulness: faithfulnessSum / divisor,
        citationCorrectness: citationSum / divisor,
        contextUtilization: utilizationSum / divisor
      };

      const overallBenchmarkScore = calculateBenchmarkScore(averageMetrics, this.scoringWeights);

      matrixResults.push({
        config,
        passedCount,
        failedCount,
        averageMetrics,
        overallBenchmarkScore
      });
    }

    // Deterministic ranking tie-breakers
    matrixResults.sort((a, b) => {
      // 1. Overall benchmark score DESC
      if (Math.abs(b.overallBenchmarkScore - a.overallBenchmarkScore) > 1e-9) {
        return b.overallBenchmarkScore - a.overallBenchmarkScore;
      }
      // 2. Passed scenario count DESC
      if (b.passedCount !== a.passedCount) {
        return b.passedCount - a.passedCount;
      }
      // 3. Semantic Weight DESC
      if (Math.abs(b.config.semanticWeight - a.config.semanticWeight) > 1e-9) {
        return b.config.semanticWeight - a.config.semanticWeight;
      }
      // 4. Min Similarity DESC
      if (Math.abs(b.config.minSimilarity - a.config.minSimilarity) > 1e-9) {
        return b.config.minSimilarity - a.config.minSimilarity;
      }
      // 5. Diversity Threshold DESC
      if (Math.abs(b.config.diversityThreshold - a.config.diversityThreshold) > 1e-9) {
        return b.config.diversityThreshold - a.config.diversityThreshold;
      }
      // 6. Max Snippets DESC
      return b.config.maxConversationSnippets - a.config.maxConversationSnippets;
    });

    const bestResult = matrixResults[0];
    const bestConfig = bestResult.config;
    const recommendationExplanation = `Config recommendation derived from deterministic benchmark matrix run. Best configuration achieved an overall benchmark score of ${(bestResult.overallBenchmarkScore * 100).toFixed(1)}% by passing ${bestResult.passedCount} out of ${totalScenarios} test scenarios.`;

    return {
      matrixResults,
      bestConfig,
      recommendationExplanation
    };
  }
}
