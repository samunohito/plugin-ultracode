"use strict";

// Codex sends `--output-schema` to the Responses API with `strict: true`, which
// rejects any object schema unless it sets `additionalProperties: false` and
// lists EVERY property in `required`. Claude-style Workflow schemas (and most
// hand-written ones) omit both, so the API answers 400 `invalid_json_schema`
// and the worker dies before the model runs.
//
// toStrictSchema() derives the wire schema sent to Codex: it closes every object
// and makes originally-optional properties required-but-nullable, which is how
// strict mode expresses "optional". stripOptionalNulls() undoes that on the
// returned value so callers (and validateAgainstSchema) still see the shape the
// ORIGINAL schema describes: an optional property the model left empty is
// absent, not `null`.
//
// Both are pure and leave their inputs untouched. An explicit
// `additionalProperties` value is preserved as written.

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isObjectSchema(schema) {
  return isPlainObject(schema) && (schema.type === "object" || isPlainObject(schema.properties));
}

function allowsNull(schema) {
  if (!isPlainObject(schema)) return false;
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key]) && schema[key].some(allowsNull)) return true;
  }
  return false;
}

function makeNullable(schema) {
  if (allowsNull(schema)) return schema;
  if (typeof schema.type === "string" || Array.isArray(schema.type)) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const out = { ...schema, type: [...types, "null"] };
    if (Array.isArray(schema.enum)) out.enum = [...schema.enum, null];
    return out;
  }
  return { anyOf: [schema, { type: "null" }] };
}

function mapSchemaRecord(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) out[key] = toStrictSchema(value);
  return out;
}

function toStrictSchema(schema) {
  if (!isPlainObject(schema)) return schema;
  const out = { ...schema };

  if (isObjectSchema(schema)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const originalRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
    const strictProperties = {};
    for (const [key, value] of Object.entries(properties)) {
      const strict = toStrictSchema(value);
      strictProperties[key] = originalRequired.has(key) || !isPlainObject(strict) ? strict : makeNullable(strict);
    }
    out.properties = strictProperties;
    out.required = Object.keys(strictProperties);
    if (out.additionalProperties === undefined) out.additionalProperties = false;
  }

  if (Array.isArray(schema.items)) out.items = schema.items.map(toStrictSchema);
  else if (isPlainObject(schema.items)) out.items = toStrictSchema(schema.items);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[key])) out[key] = schema[key].map(toStrictSchema);
  }
  for (const key of ["$defs", "definitions"]) {
    if (isPlainObject(schema[key])) out[key] = mapSchemaRecord(schema[key]);
  }
  return out;
}

function stripOptionalNulls(value, schema) {
  if (!isPlainObject(schema)) return value;
  if (Array.isArray(value)) {
    if (Array.isArray(schema.items)) return value.map((item, index) => stripOptionalNulls(item, schema.items[index]));
    if (isPlainObject(schema.items)) return value.map((item) => stripOptionalNulls(item, schema.items));
    return value;
  }
  if (!isPlainObject(value) || !isObjectSchema(schema)) return value;
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (item === null && propertySchema && !required.has(key) && !allowsNull(propertySchema)) continue;
    out[key] = propertySchema ? stripOptionalNulls(item, propertySchema) : item;
  }
  return out;
}

module.exports = { toStrictSchema, stripOptionalNulls };
