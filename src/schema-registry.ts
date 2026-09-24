import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'

export const schemaNames = [
  'benchmark-config',
  'corpus',
  'inspection',
  'sample',
  'artifact',
  'provider-probe',
  'provider-run',
  'decision',
  'annotation',
  'run',
  'paper-value',
] as const

export type SchemaName = (typeof schemaNames)[number]

export interface ValidationResult {
  valid: boolean
  errors: ErrorObject[]
}

export interface SchemaRegistry {
  validate(name: SchemaName, value: unknown): ValidationResult
}

const schemasDirectory = fileURLToPath(new URL('../schemas/', import.meta.url))

export async function readSchema(name: SchemaName): Promise<Record<string, unknown>> {
  const contents = await readFile(`${schemasDirectory}${name}.schema.json`, 'utf8')
  return JSON.parse(contents) as Record<string, unknown>
}

export async function createSchemaRegistry(): Promise<SchemaRegistry> {
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
    strictRequired: false,
  })
  const validators = new Map<SchemaName, ValidateFunction>()

  for (const name of schemaNames) {
    const schema = await readSchema(name)
    validators.set(name, ajv.compile(schema))
  }

  return {
    validate(name, value) {
      const validator = validators.get(name)
      if (!validator) {
        throw new Error(`Unknown schema: ${name}`)
      }

      const valid = validator(value)
      return {
        valid,
        errors: validator.errors ? [...validator.errors] : [],
      }
    },
  }
}

export function formatValidationErrors(errors: ErrorObject[]): string {
  return errors
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ')
}
