type JsonSchema = boolean | Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function valueType(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	if (Number.isInteger(value)) return "integer";
	return typeof value;
}

function acceptsType(value: unknown, expected: string): boolean {
	switch (expected) {
		case "object":
			return isRecord(value);
		case "array":
			return Array.isArray(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "null":
			return value === null;
		default:
			return typeof value === expected;
	}
}

function pointer(root: Record<string, unknown>, reference: string): JsonSchema {
	if (!reference.startsWith("#/"))
		throw new Error(
			`Only local JSON Schema references are supported: ${reference}`,
		);
	let current: unknown = root;
	for (const segment of reference
		.slice(2)
		.split("/")
		.map((value) => value.replaceAll("~1", "/").replaceAll("~0", "~"))) {
		if (!isRecord(current) || !(segment in current))
			throw new Error(`Unresolved JSON Schema reference: ${reference}`);
		current = current[segment];
	}
	if (typeof current !== "boolean" && !isRecord(current))
		throw new Error(`JSON Schema reference is not a schema: ${reference}`);
	return current;
}

function validateNode(
	value: unknown,
	schema: JsonSchema,
	root: Record<string, unknown>,
	path: string,
): string[] {
	if (schema === true) return [];
	if (schema === false) return [`${path} is forbidden by the schema`];
	if (typeof schema["$ref"] === "string") {
		return validateNode(value, pointer(root, schema["$ref"]), root, path);
	}

	const errors: string[] = [];
	const allOf = schema["allOf"];
	if (Array.isArray(allOf)) {
		for (const branch of allOf) {
			if (typeof branch === "boolean" || isRecord(branch))
				errors.push(...validateNode(value, branch, root, path));
		}
	}
	const oneOf = schema["oneOf"];
	if (Array.isArray(oneOf)) {
		const results = oneOf
			.filter(
				(branch): branch is JsonSchema =>
					typeof branch === "boolean" || isRecord(branch),
			)
			.map((branch) => validateNode(value, branch, root, path));
		const passing = results.filter((result) => result.length === 0).length;
		if (passing !== 1)
			errors.push(
				`${path} must satisfy exactly one oneOf branch (matched ${passing})`,
			);
		return errors;
	}

	const expectedTypes = Array.isArray(schema["type"])
		? schema["type"]
		: schema["type"] === undefined
			? []
			: [schema["type"]];
	if (
		expectedTypes.length > 0 &&
		!expectedTypes.some(
			(expected) =>
				typeof expected === "string" && acceptsType(value, expected),
		)
	) {
		errors.push(
			`${path} has type ${valueType(value)}; expected ${expectedTypes.join("|")}`,
		);
		return errors;
	}

	if ("const" in schema && !sameValue(value, schema["const"]))
		errors.push(`${path} must equal ${JSON.stringify(schema["const"])}`);
	if (
		Array.isArray(schema["enum"]) &&
		!schema["enum"].some((candidate) => sameValue(value, candidate))
	) {
		errors.push(`${path} must be one of ${JSON.stringify(schema["enum"])}`);
	}

	if (typeof value === "string") {
		if (
			typeof schema["minLength"] === "number" &&
			value.length < schema["minLength"]
		) {
			errors.push(
				`${path} must have at least ${schema["minLength"]} characters`,
			);
		}
		if (
			typeof schema["pattern"] === "string" &&
			!new RegExp(schema["pattern"], "u").test(value)
		) {
			errors.push(`${path} does not match ${schema["pattern"]}`);
		}
		if (
			schema["format"] === "date-time" &&
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
		) {
			errors.push(`${path} must be a UTC date-time`);
		}
	}

	if (typeof value === "number") {
		if (typeof schema["minimum"] === "number" && value < schema["minimum"])
			errors.push(`${path} must be at least ${schema["minimum"]}`);
		if (typeof schema["maximum"] === "number" && value > schema["maximum"])
			errors.push(`${path} must be at most ${schema["maximum"]}`);
	}

	if (Array.isArray(value)) {
		if (
			typeof schema["minItems"] === "number" &&
			value.length < schema["minItems"]
		)
			errors.push(`${path} must contain at least ${schema["minItems"]} items`);
		if (
			schema["uniqueItems"] === true &&
			new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length
		) {
			errors.push(`${path} must contain unique items`);
		}
		const itemSchema = schema["items"];
		if (typeof itemSchema === "boolean" || isRecord(itemSchema)) {
			for (const [index, entry] of value.entries()) {
				errors.push(
					...validateNode(entry, itemSchema, root, `${path}[${index}]`),
				);
			}
		}
	}

	if (isRecord(value)) {
		if (
			typeof schema["minProperties"] === "number" &&
			Object.keys(value).length < schema["minProperties"]
		) {
			errors.push(
				`${path} must contain at least ${schema["minProperties"]} properties`,
			);
		}
		const required = Array.isArray(schema["required"])
			? schema["required"]
			: [];
		for (const key of required) {
			if (typeof key === "string" && !(key in value))
				errors.push(`${path}.${key} is required`);
		}
		const properties = isRecord(schema["properties"])
			? schema["properties"]
			: {};
		for (const [key, entry] of Object.entries(value)) {
			const propertySchema = properties[key];
			if (typeof propertySchema === "boolean" || isRecord(propertySchema)) {
				errors.push(
					...validateNode(entry, propertySchema, root, `${path}.${key}`),
				);
				continue;
			}
			const additional = schema["additionalProperties"];
			if (additional === false) errors.push(`${path}.${key} is not allowed`);
			else if (typeof additional === "boolean" || isRecord(additional))
				errors.push(...validateNode(entry, additional, root, `${path}.${key}`));
		}
	}

	return errors;
}

export function validateJsonSchema(
	value: unknown,
	schema: Record<string, unknown>,
): string[] {
	return validateNode(value, schema, schema, "$").sort();
}
