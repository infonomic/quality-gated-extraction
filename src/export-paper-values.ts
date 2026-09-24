import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createSchemaRegistry, formatValidationErrors } from './schema-registry.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SOURCE_RUN_ID = 'phase3-matrix-20260805'
const EXPORT_RUN_ID = 'phase5-paper-20260806'
const WORK = path.join(ROOT, 'work', SOURCE_RUN_ID)
const OUTPUT = path.join(ROOT, 'results', EXPORT_RUN_ID)

type Label = 'observed' | 'sampled' | 'projected' | 'unavailable'
type Tier = 'T0' | 'T1' | 'T2' | 'T3'
type PolicyName = 'allT0' | 'staticInspection' | 'gated'
type AxisName = 'readingSufficiency' | 'structuralAdequacy'

interface Metric {
  numerator: number
  denominator: number
  excludedCount: number
  value: number
}

interface PaperValue {
  schemaVersion: 1
  key: string
  name: string
  label: Label
  value: number | string | null
  unit?: string
  sourceRunId: string
  sourceMetric: string
  numerator?: number
  denominator?: number
  excludedCount?: number
  caseIds?: string[]
  note?: string
}

interface PolicySummary {
  selectedDocuments: Metric
  observedTimingDocuments: Metric
  timingCoverage: Metric
  tierCounts: Record<Tier, Metric>
  observedWallMs: Metric & { label: 'observed' }
  meanWallMs: Metric
  quality: {
    pages: Metric
    gateErrors: Record<AxisName, { falseAccepts: Metric; falseEscalations: Metric }>
  }
}

interface PolicyResult {
  routingPolicyHash: string
  gatePolicyHash: string
  evaluationOracleHash: string
  analysis: {
    denominator: { documents: number; qualityPages: number }
    policies: Record<PolicyName, PolicySummary>
    allT3PageBaseline: {
      pages: Metric
      observedWallMs: Metric
      quality: Record<AxisName, { falseAccepts: Metric; falseEscalations: Metric }>
    }
  }
}

interface GateResult {
  policyHash: string
  contractHash: string
  calibrationOracleHash: string
  denominators: {
    documents: number
    pages: number
    documentTierExamples: number
    axisJudgements: number
  }
  pageScripts: Record<string, number>
  selected: {
    thresholds: Record<string, number>
    reading: { falseAccepts: number; falseRejects: number }
    structural: { falseAccepts: number; falseRejects: number }
  }
}

interface CorpusSummary {
  runId: string
  counts: {
    documents: number
    attachments: number
    includedPdfs: number
    excludedNonPdfs: number
    unreadablePdfs: number
    inspectedPdfs: number
    inspectedPages: number
  }
}

interface ProviderProbe {
  tier: Tier
  id: string
  execution: string
  status: string
  version?: string
}

interface TierTiming {
  documents: Metric
  timing: {
    wallMs: number
    meanWallMsPerSucceededDocument: number
  }
  costProxy: { value: number; unit: string; billedSpend: boolean }
}

interface ReliabilityAudit {
  providerCompletion: Metric
  seriousOutputDefects: Metric
}

interface ThaiAudit {
  thaiShortRunDensity: { aggregate: Metric }
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}

async function fileHash(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

function metricValue(options: {
  key: string
  name?: string
  label: Exclude<Label, 'unavailable'>
  metric: Metric
  sourceRunId: string
  sourceMetric: string
  unit?: string
  note?: string
  caseIds?: string[]
}): PaperValue {
  return {
    schemaVersion: 1,
    key: options.key,
    name: options.name ?? paperValueName(options.key),
    label: options.label,
    value: options.metric.value,
    unit: options.unit,
    sourceRunId: options.sourceRunId,
    sourceMetric: options.sourceMetric,
    numerator: options.metric.numerator,
    denominator: options.metric.denominator,
    excludedCount: options.metric.excludedCount,
    caseIds: options.caseIds,
    note: options.note,
  }
}

function countValue(options: {
  key: string
  name?: string
  label: Exclude<Label, 'unavailable'>
  value: number
  denominator: number
  sourceRunId: string
  sourceMetric: string
  unit?: string
  note?: string
}): PaperValue {
  return metricValue({
    ...options,
    metric: {
      numerator: options.value,
      denominator: options.denominator,
      excludedCount: 0,
      value: options.value,
    },
  })
}

function unavailableValue(key: string, sourceMetric: string, note: string): PaperValue {
  return {
    schemaVersion: 1,
    key,
    name: paperValueName(key),
    label: 'unavailable',
    value: null,
    sourceRunId: EXPORT_RUN_ID,
    sourceMetric,
    note,
  }
}

function paperValueName(key: string): string {
  const named: Record<string, string> = {
    'corpus.publications': 'Publications represented in the collection',
    'corpus.pdf_attachments': 'Readable PDF attachments',
    'corpus.excluded_non_pdf_attachments': 'Excluded non-PDF attachments',
    'corpus.pages': 'Inspected PDF pages',
    'corpus.text_layer_coverage_ge_0_95': 'PDFs with at least 95% text-layer coverage',
    'corpus.text_layer_coverage_lt_0_10': 'PDFs with less than 10% text-layer coverage',
    'corpus.text_layer_coverage_middle': 'PDFs with 10% to less than 95% text-layer coverage',
  }
  return (
    named[key] ??
    key
      .replaceAll('.', ' ')
      .replaceAll('_', ' ')
      .replace(/^./u, (character) => character.toUpperCase())
  )
}

function csv(rows: Array<Array<string | number>>): string {
  return `${rows
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell)
          return /[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
        })
        .join(',')
    )
    .join('\n')}\n`
}

function pct(metric: Metric): string {
  return `${(metric.value * 100).toFixed(1)}% (${metric.numerator}/${metric.denominator})`
}

async function main(): Promise<void> {
  const corpusPath = path.join(ROOT, 'work/phase2-authoritative-20260805/summary.json')
  const inspectionPath = path.join(ROOT, 'work/phase2-authoritative-20260805/inspection.jsonl')
  const cacheContractPath = path.join(ROOT, 'src/artifact-cache.ts')
  const gateContractPath = path.join(ROOT, 'src/quality-gate.ts')
  const policyPath = path.join(WORK, 'policy-analysis.json')
  const gatePath = path.join(WORK, 'gate-calibration.json')
  const probePath = path.join(ROOT, 'work/phase1-authoritative-20260805/provider-probe.json')
  const timingPath = path.join(ROOT, 'results/phase3-matrix-20260805/timing-summary.json')
  const t3TimingPath = path.join(ROOT, 'results/phase3-matrix-20260805/t3-page-timing-summary.json')
  const reliabilityPath = path.join(
    ROOT,
    'results/phase4-annotations-20260805/t3-output-reliability-audit.json'
  )
  const thaiPath = path.join(
    ROOT,
    'results/phase4-annotations-20260805/t2-script-conditioned-failure-audit.json'
  )
  const consistencyPath = path.join(
    ROOT,
    'results/phase4-annotations-20260805/oracle-consistency-audit.json'
  )
  const calibrationOraclePath = path.join(WORK, 'adjudication/oracle-calibration.json')

  const [
    corpus,
    inspectionRaw,
    policy,
    gate,
    probes,
    timing,
    t3Timing,
    reliability,
    thai,
    consistency,
    calibrationOracle,
  ] = await Promise.all([
    readJson<CorpusSummary>(corpusPath),
    readFile(inspectionPath, 'utf8'),
    readJson<PolicyResult>(policyPath),
    readJson<GateResult>(gatePath),
    readJson<{ probes: ProviderProbe[] }>(probePath),
    readJson<{ byTier: Record<'T0' | 'T1' | 'T2', { overall: TierTiming }> }>(timingPath),
    readJson<{
      byPartition: {
        evaluation: { timing: { totalWallMs: number; meanWallMsPerSucceededPage: number } }
      }
    }>(t3TimingPath),
    readJson<ReliabilityAudit>(reliabilityPath),
    readJson<ThaiAudit>(thaiPath),
    readJson<{
      derivedHigherTierDegradation: Metric & { degradedTierCounts: Record<Tier, number> }
    }>(consistencyPath),
    readJson<Record<string, unknown>>(calibrationOraclePath),
  ])

  if (policy.gatePolicyHash !== gate.policyHash) {
    throw new Error('Policy analysis does not use the frozen quality-gate hash')
  }
  if (
    policy.analysis.denominator.documents !== 16 ||
    policy.analysis.denominator.qualityPages !== 32
  ) {
    throw new Error('Policy analysis denominators differ from the frozen evaluation set')
  }
  const providerVersions = new Map<Tier, string>()
  for (const probe of probes.probes) {
    if (probe.status !== 'available' || !probe.version) {
      throw new Error(`Provider identity for ${probe.tier} is unavailable`)
    }
    providerVersions.set(probe.tier, `${probe.id} ${probe.version} (${probe.execution})`)
  }
  if (providerVersions.size !== 4) throw new Error('Expected identities for T0-T3')

  const inspections = inspectionRaw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { signals: { textLayerCoverage: number } })
  if (inspections.length !== corpus.counts.inspectedPdfs) {
    throw new Error('Inspection records do not reconcile with the corpus PDF count')
  }
  const highTextLayerCoverage = inspections.filter(
    (record) => record.signals.textLayerCoverage >= 0.95
  ).length
  const lowTextLayerCoverage = inspections.filter(
    (record) => record.signals.textLayerCoverage < 0.1
  ).length
  const middleTextLayerCoverage = inspections.length - highTextLayerCoverage - lowTextLayerCoverage
  if (
    highTextLayerCoverage !== 231 ||
    lowTextLayerCoverage !== 81 ||
    middleTextLayerCoverage !== 29
  ) {
    throw new Error('Frozen text-layer coverage regime counts changed')
  }

  const calibrationRecords = Object.entries(calibrationOracle).filter(([key]) =>
    /^F\d+:\d+$/u.test(key)
  )
  if (calibrationRecords.length !== 16) throw new Error('Calibration oracle must contain 16 pages')
  const calibrationDegradation = calibrationRecords.filter(([, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const tiers = (value as { degradedTiers?: unknown }).degradedTiers
    return Array.isArray(tiers) && tiers.length > 0
  }).length
  if (calibrationDegradation !== 2) throw new Error('Expected two calibration degradation pages')

  const values: PaperValue[] = []
  const corpusCounts: Array<[string, number, string, string]> = [
    ['corpus.publications', corpus.counts.documents, 'publications', 'counts.documents'],
    ['corpus.pdf_attachments', corpus.counts.includedPdfs, 'PDFs', 'counts.includedPdfs'],
    [
      'corpus.excluded_non_pdf_attachments',
      corpus.counts.excludedNonPdfs,
      'attachments',
      'counts.excludedNonPdfs',
    ],
    ['corpus.pages', corpus.counts.inspectedPages, 'pages', 'counts.inspectedPages'],
  ]
  for (const [key, value, unit, sourceMetric] of corpusCounts) {
    values.push(
      countValue({
        key,
        label: 'observed',
        value,
        denominator: value,
        unit,
        sourceRunId: corpus.runId,
        sourceMetric,
        note:
          key === 'corpus.publications'
            ? 'Publication records represented by 341 readable PDF attachments.'
            : undefined,
      })
    )
  }

  values.push(
    countValue({
      key: 'corpus.text_layer_coverage_ge_0_95',
      label: 'observed',
      value: highTextLayerCoverage,
      denominator: inspections.length,
      unit: 'PDFs',
      sourceRunId: 'phase2-authoritative-20260805',
      sourceMetric: 'inspection.jsonl signals.textLayerCoverage >= 0.95',
      note: 'Cut-point is inclusive at 0.95.',
    }),
    countValue({
      key: 'corpus.text_layer_coverage_lt_0_10',
      label: 'observed',
      value: lowTextLayerCoverage,
      denominator: inspections.length,
      unit: 'PDFs',
      sourceRunId: 'phase2-authoritative-20260805',
      sourceMetric: 'inspection.jsonl signals.textLayerCoverage < 0.10',
      note: 'Cut-point is exclusive at 0.10.',
    }),
    countValue({
      key: 'corpus.text_layer_coverage_middle',
      label: 'observed',
      value: middleTextLayerCoverage,
      denominator: inspections.length,
      unit: 'PDFs',
      sourceRunId: 'phase2-authoritative-20260805',
      sourceMetric: 'inspection.jsonl 0.10 <= signals.textLayerCoverage < 0.95',
      note: 'Reconciliation band; 231 + 81 + 29 = 341 PDFs.',
    })
  )

  for (const [tier, version] of providerVersions) {
    values.push({
      schemaVersion: 1,
      key: `provider.${tier}.identity`,
      name: `${tier} provider identity`,
      label: 'observed',
      value: version,
      sourceRunId: 'phase1-authoritative-20260805',
      sourceMetric: `probes[${tier}]`,
    })
  }

  values.push(
    {
      schemaVersion: 1,
      key: 'cache.identity_contract',
      name: 'Content-addressed extraction cache identity',
      label: 'observed',
      value:
        'SHA-256 over content hash, provider id and version, model, canonical parameter hash, and representation schema version',
      sourceRunId: SOURCE_RUN_ID,
      sourceMetric: 'src/artifact-cache.ts artifactCacheKey',
      note: 'The replay exposes this provenance trace; corpus-wide cache savings were not evaluated.',
    },
    {
      schemaVersion: 1,
      key: 'gate.decision_contract',
      name: 'Post-extraction quality-gate decision contract',
      label: 'observed',
      value:
        'Accept only when every available quality component meets its frozen minimum; preserve unavailable optional evidence as null',
      sourceRunId: SOURCE_RUN_ID,
      sourceMetric: 'src/quality-gate.ts decideQualityGate',
    }
  )

  values.push(
    countValue({
      key: 'sample.calibration_documents',
      label: 'sampled',
      value: 8,
      denominator: 24,
      unit: 'documents',
      sourceRunId: SOURCE_RUN_ID,
      sourceMetric: 'gate-calibration.denominators.documents',
    }),
    countValue({
      key: 'sample.evaluation_documents',
      label: 'sampled',
      value: 16,
      denominator: 24,
      unit: 'documents',
      sourceRunId: SOURCE_RUN_ID,
      sourceMetric: 'policy-analysis.analysis.denominator.documents',
    }),
    countValue({
      key: 'sample.calibration_oracle_pages',
      label: 'sampled',
      value: gate.denominators.pages,
      denominator: gate.denominators.pages,
      unit: 'pages',
      sourceRunId: SOURCE_RUN_ID,
      sourceMetric: 'gate-calibration.denominators.pages',
    }),
    countValue({
      key: 'sample.evaluation_oracle_pages',
      label: 'sampled',
      value: policy.analysis.denominator.qualityPages,
      denominator: policy.analysis.denominator.qualityPages,
      unit: 'pages',
      sourceRunId: SOURCE_RUN_ID,
      sourceMetric: 'policy-analysis.analysis.denominator.qualityPages',
    })
  )

  for (const [component, value] of Object.entries(gate.selected.thresholds)) {
    values.push(
      countValue({
        key: `gate.threshold.${component}`,
        label: 'observed',
        value,
        denominator: gate.denominators.axisJudgements,
        unit: 'score threshold',
        sourceRunId: SOURCE_RUN_ID,
        sourceMetric: `gate-calibration.selected.thresholds.${component}`,
        note: `Frozen under policy hash ${gate.policyHash}; denominator records the calibration evidence volume, not a rate.`,
      })
    )
  }
  for (const [axis, result] of [
    ['reading', gate.selected.reading],
    ['structural', gate.selected.structural],
  ] as const) {
    values.push(
      countValue({
        key: `gate.calibration.${axis}.false_accepts`,
        label: 'sampled',
        value: result.falseAccepts,
        denominator: gate.denominators.documentTierExamples,
        unit: 'document-tier judgements',
        sourceRunId: SOURCE_RUN_ID,
        sourceMetric: `gate-calibration.selected.${axis}.falseAccepts`,
      }),
      countValue({
        key: `gate.calibration.${axis}.false_rejects`,
        label: 'sampled',
        value: result.falseRejects,
        denominator: gate.denominators.documentTierExamples,
        unit: 'document-tier judgements',
        sourceRunId: SOURCE_RUN_ID,
        sourceMetric: `gate-calibration.selected.${axis}.falseRejects`,
      })
    )
  }

  const policies = Object.entries(policy.analysis.policies) as Array<[PolicyName, PolicySummary]>
  for (const [policyName, summary] of policies) {
    for (const tier of ['T0', 'T1', 'T2', 'T3'] as const) {
      values.push(
        metricValue({
          key: `policy.${policyName}.tier.${tier}.documents`,
          label: 'sampled',
          metric: summary.tierCounts[tier],
          unit: 'documents',
          sourceRunId: SOURCE_RUN_ID,
          sourceMetric: `policy-analysis.analysis.policies.${policyName}.tierCounts.${tier}`,
        })
      )
    }
    for (const axis of ['readingSufficiency', 'structuralAdequacy'] as const) {
      for (const error of ['falseAccepts', 'falseEscalations'] as const) {
        values.push(
          metricValue({
            key: `policy.${policyName}.${axis}.${error}`,
            label: 'sampled',
            metric: summary.quality.gateErrors[axis][error],
            unit: 'fraction of evaluation pages',
            sourceRunId: SOURCE_RUN_ID,
            sourceMetric: `policy-analysis.analysis.policies.${policyName}.quality.gateErrors.${axis}.${error}`,
          })
        )
      }
    }
  }

  values.push(
    metricValue({
      key: 'policy.gated.observed_timing_coverage',
      label: 'sampled',
      metric: policy.analysis.policies.gated.timingCoverage,
      unit: 'fraction of evaluation documents',
      sourceRunId: SOURCE_RUN_ID,
      sourceMetric: 'policy-analysis.analysis.policies.gated.timingCoverage',
      note: 'Selected T3 documents have no completed full-document duration.',
    }),
    unavailableValue(
      'policy.gated.full_document_wall_time',
      'policy-analysis.analysis.policies.gated.observedWallMs',
      'Unavailable for the complete 16-document policy because 9 selected T3 arms were page-sampled only; the observed 7-document subtotal is not a policy total.'
    )
  )

  for (const tier of ['T0', 'T1', 'T2'] as const) {
    const observed = timing.byTier[tier].overall
    values.push(
      countValue({
        key: `timing.${tier}.mean_wall_ms_per_document`,
        label: 'sampled',
        value: observed.timing.meanWallMsPerSucceededDocument,
        denominator: observed.documents.denominator,
        unit: 'ms/document',
        sourceRunId: SOURCE_RUN_ID,
        sourceMetric: `timing-summary.byTier.${tier}.overall.timing.meanWallMsPerSucceededDocument`,
      }),
      countValue({
        key: `cost_proxy.${tier}.matrix_total`,
        label: 'sampled',
        value: observed.costProxy.value,
        denominator: observed.documents.denominator,
        unit: observed.costProxy.unit,
        sourceRunId: SOURCE_RUN_ID,
        sourceMetric: `timing-summary.byTier.${tier}.overall.costProxy`,
        note: 'Declared machine-time comparison proxy; not billed spend or energy.',
      })
    )
  }

  const t3Evaluation = t3Timing.byPartition.evaluation.timing
  values.push(
    countValue({
      key: 'timing.T3.evaluation_mean_wall_ms_per_page',
      label: 'sampled',
      value: t3Evaluation.meanWallMsPerSucceededPage,
      denominator: 32,
      unit: 'ms/page',
      sourceRunId: SOURCE_RUN_ID,
      sourceMetric:
        't3-page-timing-summary.byPartition.evaluation.timing.meanWallMsPerSucceededPage',
      note: 'Independent 128-DPI CPU-only page submissions at concurrency one.',
    }),
    countValue({
      key: 'timing.T3.projected_full_corpus_hours',
      label: 'projected',
      value: (t3Evaluation.meanWallMsPerSucceededPage * corpus.counts.inspectedPages) / 3_600_000,
      denominator: corpus.counts.inspectedPages,
      unit: 'hours',
      sourceRunId: EXPORT_RUN_ID,
      sourceMetric: 'evaluation T3 mean wall ms/page × inspected corpus pages',
      note: 'Projection on the measured CPU-only, concurrency-one configuration; not an observed migration run.',
    })
  )

  values.push(
    metricValue({
      key: 'T3.provider_completion',
      label: 'sampled',
      metric: { ...reliability.providerCompletion, value: 1 },
      unit: 'fraction of page submissions',
      sourceRunId: SOURCE_RUN_ID,
      sourceMetric: 't3-output-reliability-audit.providerCompletion',
      note: 'Provider completion is not output usability.',
    }),
    metricValue({
      key: 'T3.serious_output_defects',
      label: 'sampled',
      metric: reliability.seriousOutputDefects,
      unit: 'fraction of page submissions',
      sourceRunId: SOURCE_RUN_ID,
      sourceMetric: 't3-output-reliability-audit.seriousOutputDefects',
      note: 'Human audit of all 48 predeclared T3 pages; not a corpus prevalence estimate.',
    }),
    metricValue({
      key: 'T2.thai_short_run_density',
      label: 'sampled',
      metric: thai.thaiShortRunDensity.aggregate,
      unit: 'short runs per Thai codepoint',
      sourceRunId: SOURCE_RUN_ID,
      sourceMetric: 't2-script-conditioned-failure-audit.thaiShortRunDensity.aggregate',
      note: 'Seven substantive-Thai evaluation pages; not a glyph-error rate.',
    }),
    metricValue({
      key: 'oracle.evaluation.higher_tier_degradation',
      label: 'sampled',
      metric: consistency.derivedHigherTierDegradation,
      unit: 'fraction of evaluation pages',
      sourceRunId: SOURCE_RUN_ID,
      sourceMetric: 'oracle-consistency-audit.derivedHigherTierDegradation',
      note: 'T2 was the degraded tier in all seven held-out evaluation cases.',
    }),
    countValue({
      key: 'oracle.calibration.higher_tier_degradation',
      label: 'sampled',
      value: calibrationDegradation,
      denominator: calibrationRecords.length,
      unit: 'pages',
      sourceRunId: SOURCE_RUN_ID,
      sourceMetric: 'oracle-calibration derived degradedTiers',
      note: 'Reported separately from held-out evaluation.',
    }),
    countValue({
      key: 'oracle.all_judged_pages.T2_degradation',
      label: 'sampled',
      value: calibrationDegradation + consistency.derivedHigherTierDegradation.numerator,
      denominator: calibrationRecords.length + consistency.derivedHigherTierDegradation.denominator,
      unit: 'pages',
      sourceRunId: EXPORT_RUN_ID,
      sourceMetric: 'separate calibration and evaluation degradation counts',
      note: 'Descriptive audit across both oracle passes, not a held-out policy rate; all nine degraded tiers were T2.',
    })
  )

  for (const axis of ['readingSufficiency', 'structuralAdequacy'] as const) {
    for (const error of ['falseAccepts', 'falseEscalations'] as const) {
      values.push(
        metricValue({
          key: `policy.allT3PageBaseline.${axis}.${error}`,
          label: 'sampled',
          metric: policy.analysis.allT3PageBaseline.quality[axis][error],
          unit: 'fraction of evaluation pages',
          sourceRunId: SOURCE_RUN_ID,
          sourceMetric: `policy-analysis.analysis.allT3PageBaseline.quality.${axis}.${error}`,
          note: 'Independent page-sampled baseline, not a full-document policy arm.',
        })
      )
    }
  }

  values.push(
    unavailableValue(
      'accuracy.real_document_CER_WER',
      'annotation scope',
      'Exact real-document transcription was descoped to protect ground-truth validity.'
    ),
    unavailableValue(
      'accuracy.structural_precision_recall_F1',
      'annotation scope',
      'Element-level structural annotation was descoped; use the structural-adequacy oracle axis instead.'
    ),
    unavailableValue(
      'cost.billed_spend',
      'provider billing',
      'All providers ran locally; no provider invoice exists.'
    ),
    unavailableValue(
      'cost.energy_consumption',
      'energy instrumentation',
      'Energy was not instrumented.'
    )
  )

  const registry = await createSchemaRegistry()
  for (const value of values) {
    const validation = registry.validate('paper-value', value)
    if (!validation.valid) {
      throw new Error(`${value.key}: ${formatValidationErrors(validation.errors)}`)
    }
    if (typeof value.value === 'number') {
      if (value.numerator == null || value.denominator == null || value.excludedCount == null) {
        throw new Error(`${value.key}: numeric paper value lacks complete accounting`)
      }
    }
  }

  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        corpusPath,
        inspectionPath,
        cacheContractPath,
        gateContractPath,
        policyPath,
        gatePath,
        probePath,
        timingPath,
        t3TimingPath,
        reliabilityPath,
        thaiPath,
        consistencyPath,
        calibrationOraclePath,
      ].map(async (file) => [path.relative(ROOT, file), await fileHash(file)] as const)
    )
  )
  const bundle = {
    schemaVersion: 1,
    runId: EXPORT_RUN_ID,
    sourceRunId: SOURCE_RUN_ID,
    routingPolicyHash: policy.routingPolicyHash,
    gatePolicyHash: policy.gatePolicyHash,
    gateContractHash: gate.contractHash,
    evaluationOracleHash: policy.evaluationOracleHash,
    calibrationOracleHash: gate.calibrationOracleHash,
    sourceHashes,
    values,
  }

  const policyRows: Array<Array<string | number>> = [
    [
      'policy',
      'axis',
      'false_accepts',
      'denominator',
      'false_accept_rate',
      'false_escalations',
      'false_escalation_rate',
      'timed_documents',
      'selected_documents',
      'timing_scope',
    ],
  ]
  for (const [policyName, summary] of policies) {
    for (const axis of ['readingSufficiency', 'structuralAdequacy'] as const) {
      const errors = summary.quality.gateErrors[axis]
      policyRows.push([
        policyName,
        axis,
        errors.falseAccepts.numerator,
        errors.falseAccepts.denominator,
        errors.falseAccepts.value,
        errors.falseEscalations.numerator,
        errors.falseEscalations.value,
        summary.observedTimingDocuments.numerator,
        summary.selectedDocuments.numerator,
        policyName === 'gated'
          ? 'partial: selected T3 arms have page timing only'
          : 'complete full-document timing',
      ])
    }
  }
  for (const axis of ['readingSufficiency', 'structuralAdequacy'] as const) {
    const errors = policy.analysis.allT3PageBaseline.quality[axis]
    policyRows.push([
      'allT3PageBaseline',
      axis,
      errors.falseAccepts.numerator,
      errors.falseAccepts.denominator,
      errors.falseAccepts.value,
      errors.falseEscalations.numerator,
      errors.falseEscalations.value,
      32,
      32,
      'independent page submissions; not full documents',
    ])
  }

  const tierRows: Array<Array<string | number>> = [
    ['policy', 'tier', 'documents', 'denominator', 'label'],
  ]
  for (const [policyName, summary] of policies) {
    for (const tier of ['T0', 'T1', 'T2', 'T3'] as const) {
      tierRows.push([
        policyName,
        tier,
        summary.tierCounts[tier].numerator,
        summary.tierCounts[tier].denominator,
        'sampled',
      ])
    }
  }

  const gated = policy.analysis.policies.gated.quality.gateErrors
  const staticPolicy = policy.analysis.policies.staticInspection.quality.gateErrors
  const markdown = `# ICADL 2026 extraction benchmark — paper values

**Status:** final labelled export for reviewer and paper-drafter handoff  
**Source run:** \`${SOURCE_RUN_ID}\`  
**Gate policy:** \`${policy.gatePolicyHash}\`

## Headline policy result

On the 32 held-out oracle pages, quality-gated routing reduced unsafe acceptance compared with static inspection routing:

- reading sufficiency: ${pct(staticPolicy.readingSufficiency.falseAccepts)} → ${pct(gated.readingSufficiency.falseAccepts)};
- structural adequacy: ${pct(staticPolicy.structuralAdequacy.falseAccepts)} → ${pct(gated.structuralAdequacy.falseAccepts)}.

It also increased unnecessary escalation:

- reading sufficiency: ${pct(staticPolicy.readingSufficiency.falseEscalations)} → ${pct(gated.readingSufficiency.falseEscalations)};
- structural adequacy: ${pct(staticPolicy.structuralAdequacy.falseEscalations)} → ${pct(gated.structuralAdequacy.falseEscalations)}.

This is a safety/quality trade-off, not an observed end-to-end affordability win. Gated routing selected T3 for 9/16 documents, but T3 was measured only as independent pages. Complete gated full-document time and cost are therefore unavailable.

## Corpus regimes

- 284 publication records supplied 341 readable PDF attachments spanning 19,559 pages.
- 231/341 PDFs had at least 95% text-layer coverage.
- 81/341 had less than 10% text-layer coverage.
- The remaining 29/341 lay between those cut-points.

## Cache and gate contracts

Extraction artifacts are content-addressed by source hash, provider identity and version, model, canonical parameter hash and representation schema version. The replay's cache trace exposes this provenance; corpus-wide cache savings were not evaluated. The gate accepts an artifact only when every available component meets its frozen minimum, while unavailable optional evidence remains null rather than becoming zero.

## Frozen gate

- Calibration: 8 documents / 16 pages; 10 English, 4 mixed and 2 Thai pages.
- Thresholds: character sanity 0.99; text retention 0.75; usable-page ratio 0.75; structural yield 1.0; script consistency 0.95.
- Calibration errors over 24 document-tier examples per axis: reading false accepts 1, false rejects 6; structural false accepts 3, false rejects 6.
- The script-consistency threshold is weakly determined because calibration contains only two Thai pages.

## Tier selection

| Policy | T0 | T1 | T2 | T3 | Scope |
| --- | ---: | ---: | ---: | ---: | --- |
| All T0 | 16 | 0 | 0 | 0 | 16 evaluation documents |
| Static inspection | 4 | 4 | 8 | 0 | 16 evaluation documents |
| Quality-gated | 4 | 0 | 3 | 9 | 16 evaluation documents; T3 quality page-sampled |

## Reliability and non-monotonicity

- T3 provider completion: 48/48 page requests; serious human-observed defects: 6/48. These are different quantities.
- Higher-tier degradation: calibration 2/16; evaluation 7/32. Across both separately reported passes, all 9 degraded tiers were T2.
- T2 Thai short-run density: 9,091/10,746 (84.6%) on seven substantive-Thai evaluation pages. This is not a glyph-error rate.

## Timing and cost language

- T0/T1/T2 mean full-document wall times across the 24-document matrix: ${(timing.byTier.T0.overall.timing.meanWallMsPerSucceededDocument / 1000).toFixed(2)} s / ${(timing.byTier.T1.overall.timing.meanWallMsPerSucceededDocument / 1000).toFixed(2)} s / ${(timing.byTier.T2.overall.timing.meanWallMsPerSucceededDocument / 1000).toFixed(2)} s.
- T3 evaluation mean: ${(t3Evaluation.meanWallMsPerSucceededPage / 1000).toFixed(2)} s/page over 32 independent CPU-only page submissions.
- All-T3 corpus projection on that measured configuration: ${((t3Evaluation.meanWallMsPerSucceededPage * corpus.counts.inspectedPages) / 3_600_000).toFixed(1)} hours. This is projected, not observed.
- Machine-time dollar values are declared comparison proxies, not invoices or energy measurements.

## Claim audit

The paper must change or avoid any prose claiming:

1. an observed full-document time/cost saving for gated routing;
2. that gated routing outperformed static routing on every metric;
3. that T3 was evaluated as a full-document policy arm;
4. that 48/48 provider completion means 48/48 usable output;
5. that 84.6% is a Thai glyph-error rate;
6. that the gate re-compares an escalated artifact with the lower-tier artifact it left;
7. real-document CER/WER or element-level structural precision/recall/F1;
8. billed spend, energy reduction, retrieval improvement or production readiness; or
9. fully blinded threshold development—the calibration/evaluation data are separate, but evaluation examples were inspected before the final gate freeze.

## Files

- \`paper-values.json\`: schema-validated values and source hashes.
- \`figures/policy-comparison.csv\`: page-level quality comparisons.
- \`figures/tier-distribution.csv\`: document-level selected tiers.

Every numeric JSON value carries a numerator, denominator and excluded count. Values marked unavailable remain null.
`

  await mkdir(path.join(OUTPUT, 'figures'), { recursive: true })
  await writeFile(path.join(OUTPUT, 'paper-values.json'), `${JSON.stringify(bundle, null, 2)}\n`)
  await writeFile(path.join(OUTPUT, 'paper-values.md'), markdown)
  await writeFile(path.join(OUTPUT, 'figures/policy-comparison.csv'), csv(policyRows))
  await writeFile(path.join(OUTPUT, 'figures/tier-distribution.csv'), csv(tierRows))
  console.log(
    JSON.stringify(
      {
        output: path.relative(ROOT, OUTPUT),
        values: values.length,
        gatePolicyHash: policy.gatePolicyHash,
        headline: {
          staticReadingFalseAccepts: pct(staticPolicy.readingSufficiency.falseAccepts),
          gatedReadingFalseAccepts: pct(gated.readingSufficiency.falseAccepts),
          staticStructuralFalseAccepts: pct(staticPolicy.structuralAdequacy.falseAccepts),
          gatedStructuralFalseAccepts: pct(gated.structuralAdequacy.falseAccepts),
        },
      },
      null,
      2
    )
  )
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
