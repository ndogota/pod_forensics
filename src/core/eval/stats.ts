// Uncertainty helpers for the eval matrix.
//
// The matrix reports each (model, scenario) cell as a rate over N runs. A rate
// over a handful of runs is a point on a wide distribution, not a fact: five
// runs that all pass do not prove a 100 percent pass rate. These helpers turn a
// point estimate into an interval so the showcase reports the uncertainty
// instead of hiding it.
//
// Two methods, one per kind of metric:
//   - Proportions of runs (completion, symptom, cause, evidence recall) get a
//     Wilson score interval. Wilson is the right tool at small N and extreme
//     proportions: unlike the normal approximation it never runs off the [0,1]
//     ends and stays sensible when every run agrees. At p = 1 it returns an
//     asymmetric [lower, 1], not [1, 1]: five successes are consistent with a
//     true rate below one, and Wilson says so.
//   - The root-cause judge is a mean of continuous 0..1 scores, not a
//     proportion of runs, so a binomial interval does not apply. It reports the
//     mean and the standard deviation of the per-run scores instead.

// A closed interval on a proportion, both ends within [0, 1].
export interface Interval {
  lower: number;
  upper: number;
}

// Wilson score interval for a binomial proportion p observed over n runs.
// z defaults to 1.96 for a 95 percent two-sided interval. p is the point
// estimate (successes / n for a per-run success rate; the mean per-run fraction
// for evidence recall, which the matrix treats as a proportion of runs). With no
// runs the interval is the whole [0, 1]: no data, no information.
export function wilsonInterval(p: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { lower: 0, upper: 1 };
  const phat = Math.max(0, Math.min(1, p));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin =
    (z / denom) * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

// Mean and standard deviation of a set of continuous scores. Reported for the
// root-cause judge, whose per-run scores are means of a rubric, not run-level
// pass/fail. The standard deviation is the sample standard deviation (divided by
// n - 1); it is 0 for fewer than two runs, where spread is undefined.
export interface MeanStdDev {
  mean: number;
  stdDev: number;
}

export function meanStdDev(values: number[]): MeanStdDev {
  const n = values.length;
  if (n === 0) return { mean: 0, stdDev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, stdDev: 0 };
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, stdDev: Math.sqrt(variance) };
}
