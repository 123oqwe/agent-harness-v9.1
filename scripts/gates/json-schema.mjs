const kindMatches = (value, kind) => {
  if (kind === "null") return value === null;
  if (kind === "array") return Array.isArray(value);
  if (kind === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (kind === "integer") return Number.isSafeInteger(value);
  if (kind === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === kind;
};

const pointerValue = (document, fragment) => {
  if (fragment === "" || fragment === "#") return document;
  if (!fragment.startsWith("#/")) throw new Error(`unsupported schema fragment: ${fragment}`);
  return fragment.slice(2).split("/").reduce((value, token) => {
    const key = decodeURIComponent(token).replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error(`unresolved schema fragment: ${fragment}`);
    return value[key];
  }, document);
};

const resolveReference = (reference, rootSchema, schemas) => {
  if (reference.startsWith("#")) return { schema: pointerValue(rootSchema, reference), root: rootSchema };
  const separator = reference.indexOf("#");
  const id = separator === -1 ? reference : reference.slice(0, separator);
  const root = schemas.get(id);
  if (root === undefined) throw new Error(`unknown schema reference: ${id}`);
  return { schema: pointerValue(root, separator === -1 ? "" : reference.slice(separator)), root };
};

const inspect = (value, schema, rootSchema, schemas, path, errors) => {
  if (schema === true) return;
  if (schema === false) { errors.push(`${path} is forbidden by schema`); return; }
  if (schema === null || typeof schema !== "object" || Array.isArray(schema))
    throw new Error(`invalid schema node at ${path}`);
  if (typeof schema.$ref === "string") {
    const resolved = resolveReference(schema.$ref, rootSchema, schemas);
    inspect(value, resolved.schema, resolved.root, schemas, path, errors);
    return;
  }
  for (const branch of schema.allOf ?? []) inspect(value, branch, rootSchema, schemas, path, errors);
  if (Array.isArray(schema.anyOf)) {
    const passed = schema.anyOf.some((branch) => {
      const branchErrors = [];
      inspect(value, branch, rootSchema, schemas, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (!passed) errors.push(`${path} does not match anyOf`);
  }
  if (schema.not !== undefined) {
    const branchErrors = [];
    inspect(value, schema.not, rootSchema, schemas, path, branchErrors);
    if (branchErrors.length === 0) errors.push(`${path} matches forbidden schema`);
  }
  const types = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types !== null && !types.some((kind) => kindMatches(value, kind))) {
    errors.push(`${path} must have type ${types.join("|")}`);
    return;
  }
  if (Object.hasOwn(schema, "const") && !Object.is(value, schema.const)) errors.push(`${path} must equal const`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) errors.push(`${path} must match enum`);
  if (typeof value === "string" && typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value))
    errors.push(`${path} does not match pattern`);
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum)
    errors.push(`${path} is below minimum ${schema.minimum}`);
  if (Array.isArray(value) && Number.isSafeInteger(schema.minItems) && value.length < schema.minItems)
    errors.push(`${path} must contain at least ${schema.minItems} items`);
  if (Array.isArray(value) && schema.items !== undefined)
    value.forEach((item, index) => inspect(item, schema.items, rootSchema, schemas, `${path}/${index}`, errors));
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? [])
      if (!Object.hasOwn(value, required)) errors.push(`${path}/${required} is required`);
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) inspect(item, properties[key], rootSchema, schemas, `${path}/${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}/${key} is an additional property`);
      else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true)
        inspect(item, schema.additionalProperties, rootSchema, schemas, `${path}/${key}`, errors);
    }
  }
};

export const validateSchemaDocument = (value, schema, schemas = new Map([[schema?.$id, schema]])) => {
  const errors = [];
  inspect(value, schema, schema, schemas, "$", errors);
  return errors;
};
