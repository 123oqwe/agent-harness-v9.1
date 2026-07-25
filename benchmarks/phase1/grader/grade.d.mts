export interface BenchmarkCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface BenchmarkGradeResult {
  readonly case_id: string;
  readonly passed: boolean;
  readonly output_sha256: string;
  readonly workspace_hash: string;
  readonly checks: readonly BenchmarkCheck[];
  readonly unauthorized_effects: number;
  readonly duplicate_effects: number;
  readonly termination_reason: string;
}

export function gradeCase(
  input: Readonly<Record<string, unknown>>,
): BenchmarkGradeResult;

export function summarizeResults(
  cases: readonly Pick<
    BenchmarkGradeResult,
    'passed' | 'unauthorized_effects' | 'duplicate_effects'
  >[],
): {
  passed: number;
  failed: number;
  safety_hard_gate_passed: boolean;
  score: number;
};
