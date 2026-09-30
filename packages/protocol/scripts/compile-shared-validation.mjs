import { serialize } from "node:v8";

// zod-aot's lean mode shares issue/regex helpers, not schema validation bodies.
// Compose its IR emitters instead: only repeated, non-mutating containers become
// functions. Mutating/fallback/default branches retain the upstream output logic.
export function compileSharedSchemas(
  schemas,
  { extractSchema, generateFast, generateSlow, context },
) {
  return schemas.map(({ exportName, schema }) => {
    const refEntries = [];
    const ir = extractSchema(schema, refEntries);
    const ctx = {
      preamble: [],
      counter: 0,
      fnName: `safeParse_${exportName}`,
      regexCache: new Map(),
      mode: "inline",
      usedHelpers: new Set(),
    };
    const shareableContainers = new Set([
      "object",
      "array",
      "tuple",
      "record",
      "union",
      "discriminatedUnion",
    ]);
    // New upstream IR kinds must be reviewed before they can enter a shared
    // subtree. In particular, hasMutation alone misses recursiveRef writes.
    const pureTypes = new Set([
      ...shareableContainers,
      "set",
      "map",
      "intersection",
      "pipe",
      "optional",
      "nullable",
      "readonly",
      "string",
      "number",
      "boolean",
      "bigint",
      "date",
      "symbol",
      "null",
      "undefined",
      "void",
      "nan",
      "never",
      "any",
      "unknown",
      "literal",
      "enum",
      "file",
      "templateLiteral",
    ]);
    const children = (node) => {
      switch (node.type) {
        case "object":
          return Object.values(node.properties);
        case "array":
          return [node.element];
        case "tuple":
          return [...node.items, ...(node.rest ? [node.rest] : [])];
        case "union":
        case "discriminatedUnion":
          return node.options;
        case "record":
        case "map":
          return [node.keyType, node.valueType];
        case "set":
          return [node.valueType];
        case "intersection":
          return [node.left, node.right];
        case "pipe":
          return [node.in, node.out];
        case "optional":
        case "nullable":
        case "readonly":
        case "default":
        case "catch":
        case "effect":
          return [node.inner];
        default:
          return [];
      }
    };
    // recursiveRef writes output even though upstream hasMutation returns false.
    // Keep it (and every enclosing subtree) inline; it also depends on fnName.
    // Refinements can have side effects, so never run an extra fast guard on them.
    const pure = (node) =>
      pureTypes.has(node.type) &&
      !context.hasMutation(node) &&
      !(node.checks ?? []).some((check) => check.kind === "refine_effect") &&
      children(node).every(pure);
    const keys = new WeakMap();
    const occurrences = new Map();
    const count = (node) => {
      if (shareableContainers.has(node.type) && pure(node)) {
        // V8's build-time serialization preserves field order, undefined and
        // non-finite numbers. Unlike JSON keys, it cannot conflate IR values.
        const bytes = serialize(node);
        // Small bodies are cheaper inline; sharing must save more than a call.
        if (bytes.length >= 512) {
          const key = bytes.toString("base64");
          keys.set(node, key);
          occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
        }
      }
      children(node).forEach(count);
    };
    count(ir);
    const sharedKey = (node) => {
      const key = keys.get(node);
      return occurrences.get(key) > 1 ? key : undefined;
    };
    const fastHelpers = new Map();
    const slowHelpers = new Map();
    const fastGen = (input) => ({
      input,
      ctx,
      visit: (node, overrides) => fast(node, overrides?.input ?? input),
      temp: (prefix) => context.emitTemp(ctx, prefix),
      regex: (prefix, pattern) => context.emitRegex(ctx, prefix, pattern),
    });
    const fast = (node, input) => {
      const key = sharedKey(node);
      if (!key) return generateFast(node, fastGen(input));
      if (!fastHelpers.has(key)) {
        const name = context.emitTemp(ctx, "shared_fast");
        const expression = generateFast(node, fastGen("_v"));
        if (expression === null) {
          fastHelpers.set(key, null);
        } else {
          ctx.preamble.push(`function ${name}(_v){return ${expression};}`);
          fastHelpers.set(key, name);
        }
      }
      const name = fastHelpers.get(key);
      return name === null ? null : `${name}(${input})`;
    };
    const slowGen = (input, output, path, issues) => ({
      input,
      output,
      path,
      issues,
      ctx,
      visit: (node, overrides) =>
        slow(
          node,
          overrides?.input ?? input,
          overrides?.output ?? output,
          overrides?.path ?? path,
          overrides?.issues ?? issues,
        ),
      temp: (prefix) => context.emitTemp(ctx, prefix),
      regex: (prefix, pattern) => context.emitRegex(ctx, prefix, pattern),
      set: (prefix, values) => context.emitSet(ctx, prefix, values),
    });
    const slow = (node, input, output, path, issues) => {
      const key = sharedKey(node);
      // Non-mutating emitters never write output. Requiring identical input and
      // output also preserves intersection/pipe reads of the existing output.
      if (!key || input !== output) {
        return generateSlow(node, slowGen(input, output, path, issues));
      }
      if (!slowHelpers.has(key)) {
        const name = context.emitTemp(ctx, "shared_slow");
        const body = generateSlow(node, slowGen("_v", "_v", "_p", "_e"));
        ctx.preamble.push(`function ${name}(_v,_p,_e){${body}}`);
        slowHelpers.set(key, name);
      }
      const call = `${slowHelpers.get(key)}(${input},${path},${issues});`;
      const guard = fast(node, input);
      // Do not allocate a nested path array on successful validation. The
      // upstream fast emitters are allocation-free and only examine pure data;
      // detailed slow validation still records every issue on a failed guard.
      return guard === null ? `${call}\n` : `if(!(${guard})){${call}}\n`;
    };
    // Preserve the upstream allocation-free fast success path and __fin error
    // contract. Helpers receive the original issues array/path; unions therefore
    // retain ordered branch errors and nested array/record paths without wrappers.
    const fastExpr = fast(ir, "input");
    const slowCode = fastExpr === "true" ? "" : slow(ir, "_d", "_d", "[]", "_e");
    const body =
      fastExpr === "true"
        ? "return{success:true,data:input};"
        : [
            fastExpr === null ? "" : `if(${fastExpr}){return{success:true,data:input};}`,
            "var _e=[];var _d=input;",
            slowCode,
            "return __fin(_e,_d);",
          ].join("\n");
    return {
      exportName,
      refEntries,
      codegenResult: {
        code: ["/* zod-aot */", ...ctx.preamble].join("\n"),
        functionDef: `function ${ctx.fnName}(input){\n${body}\n}`,
        refCount: refEntries.length,
        usedHelpers: ctx.usedHelpers,
      },
    };
  });
}
