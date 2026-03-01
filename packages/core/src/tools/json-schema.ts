import type { ToolParameterSchema } from "./types.js";

type JsonSchema = Record<string, unknown>;

const FALLBACK_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true
};

interface ConvertResult {
  schema: JsonSchema;
  optional: boolean;
}

function cloneFallbackSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: true
  };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function convertStringSchema(def: Record<string, unknown>): JsonSchema {
  const schema: JsonSchema = {
    type: "string"
  };
  const checks = Array.isArray(def.checks) ? def.checks : [];
  for (const check of checks) {
    const record = toRecord(check);
    if (!record) {
      continue;
    }
    const kind = typeof record.kind === "string" ? record.kind : "";
    if (kind === "min" && typeof record.value === "number" && Number.isFinite(record.value)) {
      schema.minLength = record.value;
    } else if (kind === "max" && typeof record.value === "number" && Number.isFinite(record.value)) {
      schema.maxLength = record.value;
    }
  }
  return schema;
}

function convertNumberSchema(def: Record<string, unknown>): JsonSchema {
  let isInteger = false;
  const schema: JsonSchema = {
    type: "number"
  };
  const checks = Array.isArray(def.checks) ? def.checks : [];
  for (const check of checks) {
    const record = toRecord(check);
    if (!record) {
      continue;
    }
    const kind = typeof record.kind === "string" ? record.kind : "";
    if (kind === "int") {
      isInteger = true;
      continue;
    }
    if ((kind === "min" || kind === "max") && typeof record.value === "number" && Number.isFinite(record.value)) {
      const inclusive = record.inclusive !== false;
      if (kind === "min") {
        if (inclusive) {
          schema.minimum = record.value;
        } else {
          schema.exclusiveMinimum = record.value;
        }
      } else if (inclusive) {
        schema.maximum = record.value;
      } else {
        schema.exclusiveMaximum = record.value;
      }
    }
  }
  if (isInteger) {
    schema.type = "integer";
  }
  return schema;
}

function convertShape(def: Record<string, unknown>): Record<string, unknown> {
  const rawShape = typeof def.shape === "function" ? def.shape() : def.shape;
  return toRecord(rawShape) ?? {};
}

function convertSchema(value: unknown): ConvertResult {
  const schemaObject = toRecord(value);
  const definition = schemaObject && toRecord(schemaObject._def);
  const typeName = definition && typeof definition.typeName === "string" ? definition.typeName : "";

  if (!definition || !typeName) {
    return {
      schema: cloneFallbackSchema(),
      optional: false
    };
  }

  if (typeName === "ZodOptional") {
    const inner = convertSchema(definition.innerType);
    return {
      schema: inner.schema,
      optional: true
    };
  }

  if (typeName === "ZodDefault") {
    const inner = convertSchema(definition.innerType);
    const defaultValue = typeof definition.defaultValue === "function"
      ? safeJson(definition.defaultValue())
      : safeJson(definition.defaultValue);
    if (defaultValue !== undefined) {
      inner.schema.default = defaultValue;
    }
    return {
      schema: inner.schema,
      optional: true
    };
  }

  if (typeName === "ZodNullable") {
    const inner = convertSchema(definition.innerType);
    return {
      schema: {
        anyOf: [inner.schema, { type: "null" }]
      },
      optional: inner.optional
    };
  }

  if (typeName === "ZodEffects") {
    return convertSchema(definition.schema);
  }

  if (typeName === "ZodObject") {
    const shape = convertShape(definition);
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, propertySchema] of Object.entries(shape)) {
      const converted = convertSchema(propertySchema);
      properties[key] = converted.schema;
      if (!converted.optional) {
        required.push(key);
      }
    }
    const objectSchema: JsonSchema = {
      type: "object",
      properties,
      additionalProperties: false
    };
    if (required.length > 0) {
      objectSchema.required = required;
    }
    return {
      schema: objectSchema,
      optional: false
    };
  }

  if (typeName === "ZodDiscriminatedUnion") {
    const options = Array.isArray(definition.options) ? definition.options : [];
    const oneOf = options
      .map((option) => convertSchema(option).schema)
      .filter((candidate) => toRecord(candidate));
    return {
      schema: oneOf.length > 0 ? { oneOf } : cloneFallbackSchema(),
      optional: false
    };
  }

  if (typeName === "ZodUnion") {
    const options = Array.isArray(definition.options) ? definition.options : [];
    const anyOf = options
      .map((option) => convertSchema(option).schema)
      .filter((candidate) => toRecord(candidate));
    return {
      schema: anyOf.length > 0 ? { anyOf } : cloneFallbackSchema(),
      optional: false
    };
  }

  if (typeName === "ZodLiteral") {
    return {
      schema: { const: safeJson(definition.value) },
      optional: false
    };
  }

  if (typeName === "ZodEnum") {
    const values = Array.isArray(definition.values)
      ? definition.values.filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      schema: values.length > 0 ? { type: "string", enum: values } : { type: "string" },
      optional: false
    };
  }

  if (typeName === "ZodString") {
    return {
      schema: convertStringSchema(definition),
      optional: false
    };
  }

  if (typeName === "ZodNumber") {
    return {
      schema: convertNumberSchema(definition),
      optional: false
    };
  }

  if (typeName === "ZodBoolean") {
    return {
      schema: { type: "boolean" },
      optional: false
    };
  }

  if (typeName === "ZodArray") {
    return {
      schema: {
        type: "array",
        items: convertSchema(definition.type).schema
      },
      optional: false
    };
  }

  if (typeName === "ZodRecord") {
    return {
      schema: {
        type: "object",
        additionalProperties: convertSchema(definition.valueType).schema
      },
      optional: false
    };
  }

  if (typeName === "ZodAny" || typeName === "ZodUnknown") {
    return {
      schema: {},
      optional: false
    };
  }

  return {
    schema: cloneFallbackSchema(),
    optional: false
  };
}

function ensureTopLevelObjectSchema(schema: JsonSchema): JsonSchema {
  const type = schema.type;
  if (type === "object" || Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    return schema;
  }
  return cloneFallbackSchema();
}

export function toolInputSchemaFromParameters(parameters?: ToolParameterSchema<unknown>): JsonSchema {
  if (!parameters) {
    return cloneFallbackSchema();
  }
  try {
    const converted = convertSchema(parameters);
    return ensureTopLevelObjectSchema(converted.schema);
  } catch {
    return cloneFallbackSchema();
  }
}

export function fallbackToolInputSchema(): JsonSchema {
  return { ...FALLBACK_SCHEMA };
}
