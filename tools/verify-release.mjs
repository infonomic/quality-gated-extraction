#!/usr/bin/env node
// Recompute the hashes listed in README.md from the released files.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = (b) => createHash('sha256').update(b).digest('hex')
const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, c]) => `${JSON.stringify(k)}:${canonicalJson(c)}`).join(',')}}`
}
const read = (p) => readFileSync(path.join(ROOT, p))
const json = (p) => JSON.parse(read(p).toString('utf8'))
const { policyHash: gateHash, ...gate } = json('policy/gate-calibration.frozen.json')
const routing = json('policy/routing-calibration.frozen.json')
const checks = [
  ['gate policy', sha(canonicalJson(gate)), gateHash],
  ['routing policy', sha(canonicalJson({ selected: routing.selected, calibrationCaseIds: routing.calibrationCaseIds, candidates: routing.candidates })), routing.policyHash],
  ['gate contract', sha(read('config/gate-calibration-v1.json')), gate.contractHash],
  ['evaluation oracle', sha(read('annotations/oracle-evaluation.json')), json('traces/policy-analysis.json').evaluationOracleHash],
  ['calibration oracle', sha(read('annotations/oracle-calibration.json')), gate.calibrationOracleHash],
]
let ok = true
for (const [name, got, want] of checks) { const pass = got === want; ok &&= pass; console.log(`${pass ? 'OK  ' : 'FAIL'} ${name} ${got}`) }
process.exit(ok ? 0 : 1)
