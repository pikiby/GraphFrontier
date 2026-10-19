const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const fs = require('node:fs');
const vm = require('node:vm');
const { build } = require('esbuild');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');
const {
  createPluginBuildOptions,
  transformZodModule,
} = require('../scripts/plugin-build-options.cjs');

const root = path.resolve(__dirname, '..');
let production;
let providerBundle;

test.before(async () => {
  production = await build({
    ...createPluginBuildOptions({ production: true }),
    absWorkingDir: root,
    write: false,
    sourcemap: false,
    metafile: true,
    logLevel: 'silent',
  });
  const options = createPluginBuildOptions({ production: true });
  delete options.entryPoints;
  providerBundle = await build({
    ...options,
    absWorkingDir: root,
    stdin: {
      contents: `
        const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
        const { CfWorkerJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/cfworker');
        const { z } = require('./src/schema-runtime');
        const server = new Server({ name: 'no-codegen-test', version: '1.0.0' });
        module.exports = { provider: server._jsonSchemaValidator, CfWorkerJsonSchemaValidator, z };
      `,
      resolveDir: root,
      sourcefile: 'no-codegen-provider-entry.cjs',
      loader: 'js',
    },
    write: false,
    sourcemap: false,
    metafile: true,
    logLevel: 'silent',
  });
});

function dynamicCodeReferences(code) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', locations: true, ranges: true });
  const scope = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'script' });
  const forbidden = new Set(['Function', 'AsyncFunction', 'GeneratorFunction', 'eval']);
  const references = scope.globalScope.through
    .filter((reference) => forbidden.has(reference.identifier.name))
    .map(({ identifier }) => `${identifier.name}:${identifier.loc.start.line}`);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'MemberExpression' &&
      node.object.type === 'Identifier' &&
      ['globalThis', 'global', 'window', 'self'].includes(node.object.name)
    ) {
      const name = node.computed ? node.property.value : node.property.name;
      if (forbidden.has(name))
        references.push(`${node.object.name}.${name}:${node.loc.start.line}`);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  visit(ast);
  return references;
}

test('AST codegen check ignores comments, strings and ordinary local constructors', () => {
  assert.deepEqual(
    dynamicCodeReferences(`
      // new Function('return 1'); eval('1');
      const description = 'new Function and eval are forbidden';
      class F {};
      new F();
      function ordinary(Function) { return new Function(); }
    `),
    []
  );
  for (const code of [
    'new Function("return 1")',
    'const F = Function; new F("return 1")',
    'eval("1")',
    '(0, eval)("1")',
    'const evaluate = eval; evaluate("1")',
    'globalThis.Function("return 1")',
    'const F = window["Function"]; new F("return 1")',
  ]) {
    assert.notEqual(dynamicCodeReferences(code).length, 0, code);
  }
});

test('production bundle contains no AJV package or executable dynamic-code reference', () => {
  for (const result of [production, providerBundle]) {
    const inputs = Object.keys(result.metafile.inputs);
    assert.equal(
      inputs.some((name) => /(?:^|\/)node_modules\/(?:ajv|ajv-formats)(?:\/|$)/.test(name)),
      false,
      'AJV must not be included, even as an unused default provider'
    );
    assert.ok(
      inputs.some((name) => name.includes('node_modules/@cfworker/json-schema/')),
      'The actual cfworker validator implementation must be bundled'
    );
    assert.deepEqual(dynamicCodeReferences(result.outputFiles[0].text), []);
  }
});

test('reviewed Zod transforms fail closed on dependency source drift', () => {
  const zodRoot = path.dirname(require.resolve('zod/package.json'));
  for (const name of ['doc.cjs', 'doc.js', 'util.cjs', 'util.js', 'compile.cjs', 'compile.js']) {
    const source = fs.readFileSync(path.join(zodRoot, 'v4/core', name), 'utf8');
    const transformed = transformZodModule(name, source);
    assert.equal(typeof transformed, 'string', name);
    assert.notEqual(transformed, source, name);
    assert.throws(() => transformZodModule(name, `${source}\n// drift`), {
      message: /Unreviewed no-dynamic-code dependency source/,
    });
  }
  assert.throws(() => transformZodModule('unexpected.cjs', 'module.exports = {};'), {
    message: /Unreviewed no-dynamic-code dependency source/,
  });
});

test('direct source keeps the full Zod runtime configured jitless', () => {
  const runtime = require('../src/schema-runtime');
  const zod = require('zod');
  const core = require('zod/v4/core');
  assert.equal(runtime, zod);
  assert.equal(core.globalConfig.jitless, true);
  assert.equal(runtime.z.compile, core.compile);
  assert.equal(runtime.z.core.compileFn, core.compileFn);
  assert.equal(typeof core.compileFn, 'function');
});

function loadProvider() {
  const compiled = { exports: {} };
  const imports = [];
  const context = vm.createContext(
    {
      module: compiled,
      exports: compiled.exports,
      require(id) {
        imports.push(id);
        assert.equal(Module.isBuiltin(id), true, `Unbundled dependency ${id}`);
        return require(id);
      },
      Buffer,
      console,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
    },
    { codeGeneration: { strings: false, wasm: false } }
  );
  const script = new vm.Script(
    `(function (exports, require, module) {\n${providerBundle.outputFiles[0].text}\n})`,
    {
      filename: 'no-codegen-provider.cjs',
    }
  );
  script.runInContext(context)(compiled.exports, context.require, compiled);
  return { ...compiled.exports, imports };
}

test('bundled Zod compiler fallback preserves strict schema validation without codegen', () => {
  const { z } = loadProvider();
  assert.equal(z.core.globalConfig.jitless, true);
  const schema = z
    .object({
      mode: z.enum(['find', 'filter']),
      nodes: z.array(z.object({ weight: z.number().int().min(1).max(10) }).strict()).min(1),
    })
    .strict();
  const fallback = z.compile(schema);
  assert.equal(fallback, schema, 'Disabled compiler must fall back to the original schema');
  assert.throws(() => z.compile(schema, { strict: true }), {
    name: 'ZodCompileUnsupportedError',
  });
  const valid = { mode: 'find', nodes: [{ weight: 1 }, { weight: 10 }] };
  assert.equal(fallback.safeParse(valid).success, true);
  for (const input of [
    { ...valid, mode: 'unknown' },
    { ...valid, nodes: [] },
    { ...valid, nodes: [{ weight: 0 }] },
    { ...valid, nodes: [{ weight: 11 }] },
    { ...valid, nodes: [{ weight: '1' }] },
    { ...valid, nodes: [{ weight: 1, extra: true }] },
    { ...valid, extra: true },
  ]) {
    assert.equal(fallback.safeParse(input).success, false, JSON.stringify(input));
  }
});

test('SDK default uses the real cfworker provider inside a codegen-disabled VM', () => {
  assert.equal(require('@cfworker/json-schema/package.json').version, '4.1.1');
  const { provider, CfWorkerJsonSchemaValidator } = loadProvider();
  assert.ok(provider instanceof CfWorkerJsonSchemaValidator);
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://graphfrontier.test/schema/settings',
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'groups'],
    properties: {
      mode: { enum: ['find', 'filter'] },
      groups: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: { $ref: '#/$defs/group' },
      },
    },
    $defs: {
      group: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'weights'],
        properties: {
          name: { type: 'string', minLength: 1 },
          weights: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: { $ref: '#/$defs/weight' },
          },
        },
      },
      weight: { type: 'integer', minimum: 1, maximum: 10 },
    },
  };
  const validate = provider.getValidator(schema);
  const valid = { mode: 'find', groups: [{ name: 'work', weights: [1, 5, 10] }] };
  const serialized = JSON.stringify(valid);
  const result = validate(valid);
  assert.equal(result.valid, true);
  assert.equal(result.data, valid);
  assert.equal(result.errorMessage, undefined);
  assert.equal(JSON.stringify(valid), serialized);

  const invalidCases = [
    ['missing required root property', { groups: valid.groups }],
    ['enum', { ...valid, mode: 'unknown' }],
    ['root additionalProperties', { ...valid, unexpected: true }],
    ['array type', { ...valid, groups: {} }],
    ['minimum array length', { ...valid, groups: [] }],
    ['maximum array length', { ...valid, groups: Array(3).fill(valid.groups[0]) }],
    ['referenced object required property', { ...valid, groups: [{ weights: [1] }] }],
    ['referenced object string length', { ...valid, groups: [{ name: '', weights: [1] }] }],
    ['nested additionalProperties', { ...valid, groups: [{ ...valid.groups[0], extra: 1 }] }],
    ['nested array type', { ...valid, groups: [{ name: 'x', weights: '1' }] }],
    ['nested minimum array length', { ...valid, groups: [{ name: 'x', weights: [] }] }],
    ['nested maximum array length', { ...valid, groups: [{ name: 'x', weights: [1, 2, 3, 4] }] }],
    ['referenced number minimum', { ...valid, groups: [{ name: 'x', weights: [0] }] }],
    ['referenced number maximum', { ...valid, groups: [{ name: 'x', weights: [11] }] }],
    ['referenced integer type', { ...valid, groups: [{ name: 'x', weights: [1.5] }] }],
    ['no type coercion', { ...valid, groups: [{ name: 'x', weights: ['1'] }] }],
  ];
  for (const [label, input] of invalidCases) {
    const before = JSON.stringify(input);
    const result = validate(input);
    assert.equal(result.valid, false, label);
    assert.equal(result.data, undefined, label);
    assert.equal(typeof result.errorMessage, 'string', label);
    assert.ok(result.errorMessage.length > 0, label);
    assert.equal(JSON.stringify(input), before, `${label}: validation must not mutate input`);
  }
  assert.equal(validate(valid).valid, true, 'A failed validation must not poison reuse');
});
