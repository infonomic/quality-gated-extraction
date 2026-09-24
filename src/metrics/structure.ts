import { editDistance } from './text.js'
import { normaliseForCer } from './text-normalisation.js'
import { ratio } from './types.js'

export interface StructuralElement {
  type: 'heading' | 'table-cell' | 'caption' | 'reference' | 'body'
  text: string
}

export function textSimilarity(reference: string, output: string): number {
  const left = [...normaliseForCer(reference)]
  const right = [...normaliseForCer(output)]
  const denominator = Math.max(left.length, right.length)
  return denominator === 0 ? 1 : 1 - editDistance(left, right) / denominator
}

export function structureMetrics(
  reference: StructuralElement[],
  output: StructuralElement[],
  threshold = 0.9,
  scope: 'complete' | 'partial-reference' = 'complete'
) {
  const adjacency = reference.map((expected) =>
    output
      .map((observed, outputIndex) => ({
        outputIndex,
        similarity:
          expected.type === observed.type ? textSimilarity(expected.text, observed.text) : -1,
      }))
      .filter((candidate) => candidate.similarity >= threshold)
      .sort(
        (left, right) => right.similarity - left.similarity || left.outputIndex - right.outputIndex
      )
  )
  const outputToReference = new Map<number, number>()
  const match = (referenceIndex: number, seen: Set<number>): boolean => {
    for (const candidate of adjacency[referenceIndex] ?? []) {
      if (seen.has(candidate.outputIndex)) continue
      seen.add(candidate.outputIndex)
      const prior = outputToReference.get(candidate.outputIndex)
      if (prior == null || match(prior, seen)) {
        outputToReference.set(candidate.outputIndex, referenceIndex)
        return true
      }
    }
    return false
  }
  let truePositives = 0
  for (const referenceIndex of reference.keys()) {
    if (match(referenceIndex, new Set())) truePositives += 1
  }
  const falsePositives = scope === 'complete' ? output.length - truePositives : null
  const falseNegatives = reference.length - truePositives
  return {
    threshold,
    scope,
    counts: { truePositives, falsePositives, falseNegatives },
    precision:
      falsePositives == null
        ? ratio(0, 0, output.length)
        : ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, truePositives + falseNegatives),
    f1:
      falsePositives == null
        ? ratio(0, 0, reference.length + output.length)
        : ratio(2 * truePositives, 2 * truePositives + falsePositives + falseNegatives),
  }
}
