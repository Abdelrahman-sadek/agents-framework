/**
 * @agent-framework/evaluation — datasets, evaluators, reports and regression checks.
 */
export { compareReports, defineDataset, defineEvaluation, evaluators, formatReport } from "./evaluation.js";
export type {
  CaseResult,
  Dataset,
  EvalCase,
  EvalTarget,
  Evaluation,
  EvaluationConfig,
  EvaluationReport,
  Evaluator,
  Observation,
  RegressionComparison,
  Score,
} from "./evaluation.js";
