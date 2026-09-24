import { type EvaluationScript, normaliseForCer, tokeniseForWer } from './text-normalisation.js'
import { type MetricValue, ratio } from './types.js'

export function editDistance<T>(reference: readonly T[], output: readonly T[]): number {
  let previous = output.map((_, index) => index + 1)
  previous.unshift(0)
  for (const [referenceIndex, referenceValue] of reference.entries()) {
    const current = [referenceIndex + 1]
    for (const [outputIndex, outputValue] of output.entries()) {
      current.push(
        Math.min(
          (current[outputIndex] ?? 0) + 1,
          (previous[outputIndex + 1] ?? 0) + 1,
          (previous[outputIndex] ?? 0) + (referenceValue === outputValue ? 0 : 1)
        )
      )
    }
    previous = current
  }
  return previous.at(-1) ?? 0
}

function errorRate(reference: readonly string[], output: readonly string[]): MetricValue {
  const edits = editDistance(reference, output)
  if (reference.length === 0 && output.length > 0) return ratio(edits, 0, 1)
  return ratio(edits, reference.length)
}

export function characterErrorRate(reference: string, output: string): MetricValue {
  return errorRate([...normaliseForCer(reference)], [...normaliseForCer(output)])
}

export function wordErrorRate(
  reference: string,
  output: string,
  script: EvaluationScript
): MetricValue {
  return errorRate(tokeniseForWer(reference, script), tokeniseForWer(output, script))
}

export function textMetrics(reference: string, output: string, script: EvaluationScript) {
  return {
    cer: characterErrorRate(reference, output),
    wer: wordErrorRate(reference, output, script),
  }
}
