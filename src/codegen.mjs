import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fieldTypes = new Set(['string', 'number', 'boolean', 'number[]', 'string[]', 'boolean[]', 'json', 'json[]']);
const structureFieldTypes = new Set(['string', 'number', 'boolean', 'number[]', 'string[]', 'boolean[]']);
const numberConstraintKinds = new Set(['number', 'reference', 'enum']);
const requiredCsvFields = ['id', 'name'];
const reservedWords = new Set([
    'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class', 'const',
    'constructor', 'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export',
    'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in',
    'infer', 'instanceof', 'interface', 'is', 'keyof', 'let', 'module', 'namespace', 'never', 'new',
    'null', 'number', 'object', 'of', 'package', 'private', 'protected', 'public', 'readonly', 'require',
    'return', 'set', 'static', 'string', 'super', 'switch', 'symbol', 'this', 'throw', 'true', 'try',
    'type', 'typeof', 'undefined', 'unique', 'unknown', 'var', 'void', 'while', 'with', 'yield'
]);

export async function generateConfigCodeFromDirectory(options = {}) {
    const inputRoot = path.resolve(stringValue(options.inputRoot || options.configRoot || 'public/config'));
    const outputRoot = path.resolve(requiredString(options.outputRoot, 'Missing codegen outputRoot.'));
    const outputFile = normalizeOutputFile(options.outputFile || 'index.ts');
    const payload = await readConfigSnapshot(inputRoot);
    const generatedFiles = generateConfigFiles(payload, { ...options, outputFile });
    const files = [];

    for (const file of generatedFiles) {
        const outputPath = resolveOutputPath(outputRoot, file.fileName);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, file.code, 'utf8');
        files.push(outputPath);
    }

    return {
        inputRoot,
        outputRoot,
        files
    };
}

export function generateConfigCode(payload, options = {}) {
    const outputFile = normalizeOutputFile(options.outputFile || 'index.ts');
    const files = generateConfigFiles(payload, { ...options, outputFile });
    return files.find((file) => file.fileName === outputFile)?.code || '';
}

export function generateConfigFiles(payload, options = {}) {
    const schema = normalizeSchema(payload.schema || {});
    const tables = arrayValue(payload.tables);
    const constants = arrayValue(payload.constants)
        .map((constant) => ({
            ...constant,
            parsedValue: JSON.parse(stringValue(constant.text))
        }));
    const outputFile = normalizeOutputFile(options.outputFile || 'index.ts');
    assertEntryFileDoesNotCollide(outputFile);
    const names = createNameRegistry(schema, tables, constants, { ...options, outputFile });
    return [
        {
            fileName: outputFile,
            code: generateRepositoryModule(tables, constants, names, options)
        },
        {
            fileName: siblingOutputFile(outputFile, 'enum.ts'),
            code: generateEnumModule(schema, names)
        },
        {
            fileName: siblingOutputFile(outputFile, 'structures.ts'),
            code: generateStructureModule(schema, names)
        },
        {
            fileName: siblingOutputFile(outputFile, 'constants.ts'),
            code: generateConstantsModule(constants, names)
        },
        {
            fileName: siblingOutputFile(outputFile, 'runtime.ts'),
            code: generateRuntimeModule()
        },
        ...tables.map((table) => ({
            fileName: siblingOutputFile(outputFile, `${names.tableFiles.get(table.moduleKey)}.ts`),
            code: generateTableModule(table, names)
        }))
    ];
}

async function readConfigSnapshot(configRoot) {
    const manifest = await readJsonFile(path.join(configRoot, 'manifest.json'), { modules: {} });
    const schema = normalizeSchema(await readJsonFile(path.join(configRoot, 'schema.json'), {
        version: 1,
        tables: {},
        constants: {},
        structures: {},
        enums: {}
    }));
    const tables = [];
    const constants = [];

    for (const [moduleKey, configPath] of moduleEntries(manifest.modules || {})) {
        if (configPath.toLowerCase().endsWith('.csv')) {
            const text = await readFile(resolveConfigPath(configRoot, configPath), 'utf8');
            const { headers, rows } = csvToRows(text);
            const fields = fieldsForTable(schema, moduleKey, headers, rows);
            tables.push({
                moduleKey,
                path: configPath,
                fields,
                rows: rows.map((row) => withFieldDefaults(row, fields))
            });
            continue;
        }

        if (configPath.toLowerCase().endsWith('.json')) {
            const text = await readFile(resolveConfigPath(configRoot, configPath), 'utf8');
            JSON.parse(text);
            constants.push({
                moduleKey,
                path: configPath,
                description: stringValue(schema.constants[moduleKey]?.description),
                text
            });
        }
    }

    return {
        writable: true,
        manifest,
        schema,
        tables,
        constants
    };
}

function generateEnumDefinitions(schema, names) {
    const lines = [];
    for (const [enumKey, enumSchema] of Object.entries(schema.enums)) {
        lines.push(...commentLines(enumSchema.description || enumKey));
        lines.push(`export enum ${names.enumTypes.get(enumKey)} {`);
        const usedMembers = new Set();
        for (const enumValue of enumSchema.values) {
            const memberName = uniqueName(usedMembers, enumMemberName(enumValue.key));
            lines.push(...commentLines(enumValue.description || enumValue.key, '    '));
            lines.push(`    ${memberName} = ${JSON.stringify(enumValue.value)},`);
        }
        lines.push('}');
        lines.push('');
    }
    return lines;
}

function generateStructureDefinitions(schema, names) {
    const lines = [];
    for (const [structureKey, structure] of Object.entries(schema.structures)) {
        lines.push(...commentLines(structure.description || structureKey));
        lines.push(`export interface ${names.structureTypes.get(structureKey)} {`);
        for (const field of structure.fields) {
            lines.push(...commentLines(field.description, '    '));
            lines.push(`    ${propertyKey(field.key)}: ${structureFieldType(field, names)};`);
        }
        lines.push('}');
        lines.push('');
    }
    return lines;
}

function generateEnumModule(schema, names) {
    const lines = generatedHeaderLines();
    lines.push(...generateEnumDefinitions(schema, names));
    ensureModuleExport(lines);
    return codeFromLines(lines);
}

function generateStructureModule(schema, names) {
    const lines = generatedHeaderLines();
    const enumTypes = enumTypesForStructureDefinitions(schema, names);
    if (enumTypes.length > 0) {
        lines.push(importLine([], enumTypes, './enum'));
        lines.push('');
    }
    lines.push(...generateStructureDefinitions(schema, names));
    ensureModuleExport(lines);
    return codeFromLines(lines);
}

function generateConstantsModule(constants, names) {
    const lines = generatedHeaderLines();
    const runtimeValues = ['joinConfigUrl', 'loadJson'];
    if (constants.length > 0) {
        runtimeValues.push('requireLoaded');
    }
    lines.push(importLine(runtimeValues, ['FetchLike'], './runtime'));
    lines.push('');
    lines.push(...generateConstantDefinitions(constants, names));
    lines.push('export async function loadConstantConfig<T>(');
    lines.push('    fetchImpl: FetchLike,');
    lines.push('    baseUrl: string,');
    lines.push('    configPath: string');
    lines.push('): Promise<T> {');
    lines.push('    return await loadJson<T>(fetchImpl, joinConfigUrl(baseUrl, configPath));');
    lines.push('}');
    lines.push('');

    for (const constant of constants) {
        const constantType = names.constantTypes.get(constant.moduleKey);
        const getterFunction = names.constantGetterFunctions.get(constant.moduleKey);
        lines.push(...commentLines(`Reads constants from ${constant.moduleKey}.`));
        lines.push(`export function ${getterFunction}(value: ${constantType} | undefined): ${constantType} {`);
        lines.push(`    return requireLoaded(value, ${JSON.stringify(constant.moduleKey)});`);
        lines.push('}');
        lines.push('');
    }

    return codeFromLines(lines);
}

function generateTableModule(table, names) {
    const lines = generatedHeaderLines();
    const runtimeValues = ['joinConfigUrl', 'loadCsv', ...runtimeHelpersForFieldParsers(table.fields)];
    const enumTypes = enumTypesForFields(table.fields, names);
    const structureTypes = structureTypesForFields(table.fields, names);
    lines.push(importLine(runtimeValues, ['FetchLike'], './runtime'));
    if (enumTypes.length > 0) {
        lines.push(importLine([], enumTypes, './enum'));
    }
    if (structureTypes.length > 0) {
        lines.push(importLine([], structureTypes, './structures'));
    }
    lines.push('');
    lines.push(...generateTableDefinition(table, names));
    lines.push(...generateTableLoader(table, names));
    lines.push(...generateTableGetter(table, names));
    lines.push(...generateTableParser(table, names));
    return codeFromLines(lines);
}

function generateRepositoryModule(tables, constants, names, options) {
    const repositoryName = names.repositoryName;
    const staticBaseUrl = stringValue(options.staticBaseUrl || '/config');
    const lines = generatedHeaderLines();

    lines.push("export * from './enum';");
    lines.push("export * from './structures';");
    lines.push("export * from './constants';");
    for (const table of tables) {
        lines.push(`export * from './${names.tableFiles.get(table.moduleKey)}';`);
    }
    lines.push("export type { ConfigLoadOptions, FetchLike, FetchLikeResponse } from './runtime';");
    lines.push('');
    lines.push(importLine(['resolveFetch'], ['ConfigLoadOptions'], './runtime'));
    for (const table of tables) {
        lines.push(importLine([
            names.tableLoaderFunctions.get(table.moduleKey),
            names.tableGetterTypes.get(table.moduleKey)
        ], [names.tableTypes.get(table.moduleKey)], `./${names.tableFiles.get(table.moduleKey)}`));
    }
    if (constants.length > 0) {
        lines.push(importLine([
            'loadConstantConfig',
            ...constants.map((constant) => names.constantGetterFunctions.get(constant.moduleKey))
        ], constants.map((constant) => names.constantTypes.get(constant.moduleKey)), './constants'));
    }
    lines.push('');
    lines.push(`export class ${repositoryName} {`);

    for (const table of tables) {
        const property = names.tableProperties.get(table.moduleKey);
        const getterType = names.tableGetterTypes.get(table.moduleKey);
        lines.push(`    private ${property}Getter = new ${getterType}([]);`);
    }
    for (const constant of constants) {
        const property = names.constantProperties.get(constant.moduleKey);
        const constantType = names.constantTypes.get(constant.moduleKey);
        lines.push(`    private ${property}Value: ${constantType} | undefined;`);
    }
    if (tables.length > 0 || constants.length > 0) {
        lines.push('');
    }

    lines.push('    async load(options: ConfigLoadOptions = {}): Promise<void> {');
    lines.push(`        const baseUrl = options.baseUrl ?? ${JSON.stringify(staticBaseUrl)};`);
    lines.push('        const fetchImpl = resolveFetch(options.fetchImpl);');
    if (tables.length + constants.length === 0) {
        lines.push('        void baseUrl;');
        lines.push('        void fetchImpl;');
    } else {
        lines.push('        const [');
        for (const table of tables) {
            lines.push(`            ${names.tableProperties.get(table.moduleKey)}Rows,`);
        }
        for (const constant of constants) {
            lines.push(`            ${names.constantProperties.get(constant.moduleKey)}Value,`);
        }
        lines.push('        ] = await Promise.all([');
        for (const table of tables) {
            lines.push(`            ${names.tableLoaderFunctions.get(table.moduleKey)}(fetchImpl, baseUrl),`);
        }
        for (const constant of constants) {
            lines.push(`            loadConstantConfig<${names.constantTypes.get(constant.moduleKey)}>(fetchImpl, baseUrl, ${JSON.stringify(constant.path)}),`);
        }
        lines.push('        ]);');
        for (const table of tables) {
            const property = names.tableProperties.get(table.moduleKey);
            const getterType = names.tableGetterTypes.get(table.moduleKey);
            lines.push(`        this.${property}Getter = new ${getterType}(${property}Rows);`);
        }
        for (const constant of constants) {
            const property = names.constantProperties.get(constant.moduleKey);
            lines.push(`        this.${property}Value = ${property}Value;`);
        }
    }
    lines.push('    }');

    for (const table of tables) {
        const property = names.tableProperties.get(table.moduleKey);
        const rowType = names.tableTypes.get(table.moduleKey);
        const method = names.tableMethods.get(table.moduleKey);
        lines.push('');
        lines.push(...commentLines(`Reads all rows from ${table.moduleKey}.`, '    '));
        lines.push(`    get${method}List(): readonly ${rowType}[] {`);
        lines.push(`        return this.${property}Getter.getList();`);
        lines.push('    }');
        lines.push('');
        lines.push(...commentLines(`Reads one row from ${table.moduleKey} by id.`, '    '));
        lines.push(`    get${method}ById(id: number): ${rowType} | undefined {`);
        lines.push(`        return this.${property}Getter.getById(id);`);
        lines.push('    }');
        lines.push('');
        lines.push(...commentLines(`Reads one row from ${table.moduleKey} by id and throws when missing.`, '    '));
        lines.push(`    require${method}ById(id: number): ${rowType} {`);
        lines.push(`        return this.${property}Getter.requireById(id);`);
        lines.push('    }');
    }

    for (const constant of constants) {
        const property = names.constantProperties.get(constant.moduleKey);
        const constantType = names.constantTypes.get(constant.moduleKey);
        const method = names.constantMethods.get(constant.moduleKey);
        const getterFunction = names.constantGetterFunctions.get(constant.moduleKey);
        lines.push('');
        lines.push(...commentLines(`Reads constants from ${constant.moduleKey}.`, '    '));
        lines.push(`    get${method}(): ${constantType} {`);
        lines.push(`        return ${getterFunction}(this.${property}Value);`);
        lines.push('    }');
    }

    lines.push('}');
    lines.push('');
    lines.push(`export async function loadConfig(options: ConfigLoadOptions = {}): Promise<${repositoryName}> {`);
    lines.push(`    const repository = new ${repositoryName}();`);
    lines.push('    await repository.load(options);');
    lines.push('    return repository;');
    lines.push('}');
    lines.push('');

    return codeFromLines(lines);
}

function generateTableDefinition(table, names) {
    const lines = [];
    lines.push(...commentLines(table.moduleKey));
    lines.push(`export interface ${names.tableTypes.get(table.moduleKey)} {`);
    for (const field of table.fields) {
        lines.push(...commentLines(field.description, '    '));
        lines.push(`    ${propertyKey(field.key)}: ${fieldType(field, names)};`);
    }
    lines.push('}');
    lines.push('');
    return lines;
}

function generateConstantDefinitions(constants, names) {
    const lines = [];
    for (const constant of constants) {
        lines.push(...commentLines(constant.description || constant.moduleKey));
        lines.push(`export type ${names.constantTypes.get(constant.moduleKey)} = ${jsonType(constant.parsedValue, 0)};`);
        lines.push('');
    }
    return lines;
}

function generateTableLoader(table, names) {
    const rowType = names.tableTypes.get(table.moduleKey);
    const loaderFunction = names.tableLoaderFunctions.get(table.moduleKey);
    return [
        `export async function ${loaderFunction}(fetchImpl: FetchLike, baseUrl: string): Promise<${rowType}[]> {`,
        `    return await loadCsv(fetchImpl, joinConfigUrl(baseUrl, ${JSON.stringify(table.path)}), parse${rowType});`,
        '}',
        ''
    ];
}

function generateTableGetter(table, names) {
    const rowType = names.tableTypes.get(table.moduleKey);
    const getterType = names.tableGetterTypes.get(table.moduleKey);
    return [
        `export class ${getterType} {`,
        `    private readonly rows: readonly ${rowType}[];`,
        `    private readonly byId: ReadonlyMap<number, ${rowType}>;`,
        '',
        `    constructor(rows: readonly ${rowType}[]) {`,
        '        this.rows = rows;',
        '        this.byId = new Map(rows.map((row) => [row.id, row]));',
        '    }',
        '',
        `    getList(): readonly ${rowType}[] {`,
        '        return this.rows;',
        '    }',
        '',
        `    getById(id: number): ${rowType} | undefined {`,
        '        return this.byId.get(id);',
        '    }',
        '',
        `    requireById(id: number): ${rowType} {`,
        '        const value = this.getById(id);',
        '        if (!value) {',
        `            throw new Error(${JSON.stringify(`${table.moduleKey} config row not found: `)} + id);`,
        '        }',
        '        return value;',
        '    }',
        '}',
        ''
    ];
}

function generateTableParser(table, names) {
    const rowType = names.tableTypes.get(table.moduleKey);
    const lines = [
        `function parse${rowType}(row: Record<string, string>): ${rowType} {`,
        '    return {'
    ];
    for (const field of table.fields) {
        lines.push(`        ${propertyKey(field.key)}: ${fieldParserExpression(field, names)},`);
    }
    lines.push('    };');
    lines.push('}');
    lines.push('');
    return lines;
}

function generateRuntimeModule() {
    const lines = generatedHeaderLines();
    lines.push(...runtimeHelpers());
    return codeFromLines(lines);
}

function runtimeHelpers() {
    return [
        'export interface ConfigLoadOptions {',
        '    baseUrl?: string;',
        '    fetchImpl?: FetchLike;',
        '}',
        '',
        'export type FetchLike = (input: string, init?: unknown) => Promise<FetchLikeResponse>;',
        '',
        'export interface FetchLikeResponse {',
        '    ok: boolean;',
        '    status: number;',
        '    text(): Promise<string>;',
        '    json(): Promise<unknown>;',
        '}',
        '',
        'export function resolveFetch(fetchImpl?: FetchLike): FetchLike {',
        '    if (fetchImpl) {',
        '        return fetchImpl;',
        '    }',
        '    if (typeof fetch === \'function\') {',
        '        return fetch as FetchLike;',
        '    }',
        '    throw new Error(\'Config loading requires a fetch implementation.\');',
        '}',
        '',
        'export async function loadCsv<T>(',
        '    fetchImpl: FetchLike,',
        '    url: string,',
        '    parseRow: (row: Record<string, string>) => T',
        '): Promise<T[]> {',
        '    const response = await fetchImpl(url);',
        '    if (!response.ok) {',
        '        throw new Error(`Unable to load ${url}: ${response.status}`);',
        '    }',
        '    const { rows } = csvToRows(await response.text());',
        '    return rows.map(parseRow);',
        '}',
        '',
        'export async function loadJson<T>(fetchImpl: FetchLike, url: string): Promise<T> {',
        '    const response = await fetchImpl(url);',
        '    if (!response.ok) {',
        '        throw new Error(`Unable to load ${url}: ${response.status}`);',
        '    }',
        '    return await response.json() as T;',
        '}',
        '',
        'export function joinConfigUrl(baseUrl: string, configPath: string): string {',
        '    const base = baseUrl.replace(/\\/+$/, \'\');',
        '    const relativePath = configPath.replace(/^\\/+/, \'\');',
        '    return base ? `${base}/${relativePath}` : `/${relativePath}`;',
        '}',
        '',
        'function csvToRows(text: string): { headers: string[]; rows: Array<Record<string, string>> } {',
        '    const table = parseCsv(text.trimEnd());',
        '    const [headers, ...records] = table;',
        '    if (!headers || (headers.length === 1 && headers[0] === \'\')) {',
        '        return { headers: [], rows: [] };',
        '    }',
        '    return {',
        '        headers,',
        '        rows: records',
        '            .filter((record) => record.some((value) => value.length > 0))',
        '            .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? \'\'])))',
        '    };',
        '}',
        '',
        'function parseCsv(text: string): string[][] {',
        '    const rows: string[][] = [];',
        '    let row: string[] = [];',
        '    let value = \'\';',
        '    let quoted = false;',
        '',
        '    for (let index = 0; index < text.length; index += 1) {',
        '        const char = text[index];',
        '        const next = text[index + 1];',
        '',
        '        if (char === \'"\' && quoted && next === \'"\') {',
        '            value += \'"\'',
        '            index += 1;',
        '            continue;',
        '        }',
        '',
        '        if (char === \'"\') {',
        '            quoted = !quoted;',
        '            continue;',
        '        }',
        '',
        '        if (char === \',\' && !quoted) {',
        '            row.push(value);',
        '            value = \'\';',
        '            continue;',
        '        }',
        '',
        '        if ((char === \'\\n\' || char === \'\\r\') && !quoted) {',
        '            if (char === \'\\r\' && next === \'\\n\') {',
        '                index += 1;',
        '            }',
        '            row.push(value);',
        '            rows.push(row);',
        '            row = [];',
        '            value = \'\';',
        '            continue;',
        '        }',
        '',
        '        value += char;',
        '    }',
        '',
        '    row.push(value);',
        '    rows.push(row);',
        '    return rows;',
        '}',
        '',
        'export function stringValue(value: string | undefined): string {',
        '    return value ?? \'\';',
        '}',
        '',
        'export function numberValue(value: string | undefined): number {',
        '    if (value === undefined || value === \'\') {',
        '        return 0;',
        '    }',
        '    const nextValue = Number(value);',
        '    if (!Number.isFinite(nextValue)) {',
        '        throw new Error(`Invalid number value: ${value}`);',
        '    }',
        '    return nextValue;',
        '}',
        '',
        'export function booleanValue(value: string | undefined): boolean {',
        '    return value === \'true\';',
        '}',
        '',
        'export function stringArrayValue(value: string | undefined): string[] {',
        '    return parseArrayValue<string>(value, \'string\');',
        '}',
        '',
        'export function numberArrayValue(value: string | undefined): number[] {',
        '    return parseArrayValue<number>(value, \'number\');',
        '}',
        '',
        'export function booleanArrayValue(value: string | undefined): boolean[] {',
        '    return parseArrayValue<boolean>(value, \'boolean\');',
        '}',
        '',
        'function parseArrayValue<T>(value: string | undefined, itemType: string): T[] {',
        '    if (value === undefined || value === \'\') {',
        '        return [];',
        '    }',
        '    const parsed = JSON.parse(value);',
        '    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === itemType)) {',
        '        throw new Error(`Invalid ${itemType} array value: ${value}`);',
        '    }',
        '    return parsed as T[];',
        '}',
        '',
        'export function jsonValue<T>(value: string | undefined, fallback: unknown): T {',
        '    if (value === undefined || value === \'\') {',
        '        return fallback as T;',
        '    }',
        '    return JSON.parse(value) as T;',
        '}',
        '',
        'export function requireLoaded<T>(value: T | undefined, label: string): T {',
        '    if (value === undefined) {',
        '        throw new Error(`${label} config has not been loaded.`);',
        '    }',
        '    return value;',
        '}',
        ''
    ];
}

function runtimeHelpersForFieldParsers(fields) {
    const helpers = new Set();
    for (const field of fields) {
        if (field.type === 'number') {
            helpers.add('numberValue');
        } else if (field.type === 'boolean') {
            helpers.add('booleanValue');
        } else if (field.type === 'number[]') {
            helpers.add('numberArrayValue');
        } else if (field.type === 'string[]') {
            helpers.add('stringArrayValue');
        } else if (field.type === 'boolean[]') {
            helpers.add('booleanArrayValue');
        } else if (field.type === 'json' || field.type === 'json[]') {
            helpers.add('jsonValue');
        } else {
            helpers.add('stringValue');
        }
    }
    return Array.from(helpers);
}

function enumTypesForStructureDefinitions(schema, names) {
    return enumTypesForFields(Object.values(schema.structures).flatMap((structure) => structure.fields), names);
}

function enumTypesForFields(fields, names) {
    const enumTypes = new Set();
    for (const field of fields) {
        const enumKey = field.numberConstraint?.kind === 'enum' ? field.numberConstraint.enum : undefined;
        if (enumKey && names.enumTypes.has(enumKey)) {
            enumTypes.add(names.enumTypes.get(enumKey));
        }
    }
    return Array.from(enumTypes);
}

function structureTypesForFields(fields, names) {
    const structureTypes = new Set();
    for (const field of fields) {
        if ((field.type === 'json' || field.type === 'json[]') && field.structure && names.structureTypes.has(field.structure)) {
            structureTypes.add(names.structureTypes.get(field.structure));
        }
    }
    return Array.from(structureTypes);
}

function generatedHeaderLines() {
    return [
        '/* eslint-disable */',
        '// This file is generated by @lycheenut/game-config-tool. Do not edit.',
        ''
    ];
}

function codeFromLines(lines) {
    const outputLines = lines.slice();
    while (outputLines[outputLines.length - 1] === '') {
        outputLines.pop();
    }
    return `${outputLines.join('\n')}\n`;
}

function ensureModuleExport(lines) {
    if (!lines.some((line) => /^export\s/.test(line))) {
        lines.push('export {};');
        lines.push('');
    }
}

function importLine(valueImports, typeImports, source) {
    if (valueImports.length === 0) {
        return `import type { ${typeImports.join(', ')} } from ${JSON.stringify(source)};`;
    }
    const imports = valueImports.concat(typeImports.map((typeName) => `type ${typeName}`));
    return `import { ${imports.join(', ')} } from ${JSON.stringify(source)};`;
}
function fieldParserExpression(field, names) {
    const access = `row[${JSON.stringify(field.key)}]`;
    if (field.type === 'number') {
        return `numberValue(${access})`;
    }
    if (field.type === 'boolean') {
        return `booleanValue(${access})`;
    }
    if (field.type === 'number[]') {
        return `numberArrayValue(${access})`;
    }
    if (field.type === 'string[]') {
        return `stringArrayValue(${access})`;
    }
    if (field.type === 'boolean[]') {
        return `booleanArrayValue(${access})`;
    }
    if (field.type === 'json') {
        return `jsonValue<${fieldType(field, names)}>(${access}, {})`;
    }
    if (field.type === 'json[]') {
        return `jsonValue<${fieldType(field, names)}>(${access}, [])`;
    }
    return `stringValue(${access})`;
}

function fieldType(field, names) {
    if (field.type === 'number' && field.numberConstraint?.kind === 'enum' && names.enumTypes.has(field.numberConstraint.enum)) {
        return names.enumTypes.get(field.numberConstraint.enum);
    }
    if (field.type === 'number[]' && field.numberConstraint?.kind === 'enum' && names.enumTypes.has(field.numberConstraint.enum)) {
        return `${names.enumTypes.get(field.numberConstraint.enum)}[]`;
    }
    if (field.type === 'json' && field.structure && names.structureTypes.has(field.structure)) {
        return names.structureTypes.get(field.structure);
    }
    if (field.type === 'json[]' && field.structure && names.structureTypes.has(field.structure)) {
        return `${names.structureTypes.get(field.structure)}[]`;
    }
    if (field.type === 'json') {
        return 'unknown';
    }
    if (field.type === 'json[]') {
        return 'unknown[]';
    }
    return field.type;
}

function structureFieldType(field, names) {
    if (field.type === 'number' && field.numberConstraint?.kind === 'enum' && names.enumTypes.has(field.numberConstraint.enum)) {
        return names.enumTypes.get(field.numberConstraint.enum);
    }
    if (field.type === 'number[]' && field.numberConstraint?.kind === 'enum' && names.enumTypes.has(field.numberConstraint.enum)) {
        return `${names.enumTypes.get(field.numberConstraint.enum)}[]`;
    }
    return field.type;
}

function jsonType(value, indentLevel) {
    if (value === null) {
        return 'unknown';
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return 'unknown[]';
        }
        const itemTypes = Array.from(new Set(value.map((item) => jsonType(item, indentLevel))));
        const itemType = itemTypes.join(' | ');
        return itemTypes.length > 1 ? `(${itemType})[]` : `${itemType}[]`;
    }
    if (typeof value === 'string') {
        return 'string';
    }
    if (typeof value === 'number') {
        return 'number';
    }
    if (typeof value === 'boolean') {
        return 'boolean';
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length === 0) {
            return 'Record<string, unknown>';
        }
        const indent = '    '.repeat(indentLevel + 1);
        const closingIndent = '    '.repeat(indentLevel);
        return `{\n${entries.map(([key, item]) => `${indent}readonly ${propertyKey(key)}: ${jsonType(item, indentLevel + 1)};`).join('\n')}\n${closingIndent}}`;
    }
    return 'unknown';
}


function createNameRegistry(schema, tables, constants, options) {
    const usedTypes = new Set();
    const usedValues = new Set(['loadConfig', 'loadConstantConfig', 'resolveFetch']);
    const usedProperties = new Set();
    const usedMethods = new Set();
    const usedFileStems = new Set(['enum', 'runtime', 'structures', 'constants', fileStemFromOutputFile(options.outputFile || 'index.ts').toLowerCase()]);
    const enumTypes = new Map();
    const structureTypes = new Map();
    const tableTypes = new Map();
    const constantTypes = new Map();
    const tableProperties = new Map();
    const constantProperties = new Map();
    const tableMethods = new Map();
    const constantMethods = new Map();
    const tableFiles = new Map();
    const tableGetterTypes = new Map();
    const tableLoaderFunctions = new Map();
    const constantGetterFunctions = new Map();

    for (const enumKey of Object.keys(schema.enums)) {
        enumTypes.set(enumKey, uniqueName(usedTypes, pascalCase(enumKey, 'ConfigEnum')));
    }
    for (const structureKey of Object.keys(schema.structures)) {
        structureTypes.set(structureKey, uniqueName(usedTypes, pascalCase(structureKey, 'ConfigStructure')));
    }
    for (const table of tables) {
        const baseName = pascalCase(table.moduleKey, 'ConfigTable');
        const typeName = baseName.endsWith('Config') ? baseName : `${baseName}Config`;
        const rowType = uniqueName(usedTypes, typeName);
        tableTypes.set(table.moduleKey, rowType);
        tableProperties.set(table.moduleKey, uniqueName(usedProperties, camelCase(table.moduleKey, 'configTable')));
        tableMethods.set(table.moduleKey, uniqueName(usedMethods, baseName));
        tableFiles.set(table.moduleKey, uniqueFileStem(usedFileStems, camelCase(table.moduleKey, 'configTable')));
        tableGetterTypes.set(table.moduleKey, uniqueBindingName(usedTypes, usedValues, `${rowType}Getter`));
        tableLoaderFunctions.set(table.moduleKey, uniqueName(usedValues, `load${rowType}`));
    }
    for (const constant of constants) {
        const baseName = pascalCase(constant.moduleKey, 'ConfigConstants');
        const typeName = baseName.endsWith('Constants') ? baseName : `${baseName}Constants`;
        constantTypes.set(constant.moduleKey, uniqueName(usedTypes, typeName));
        constantProperties.set(constant.moduleKey, uniqueName(usedProperties, camelCase(constant.moduleKey, 'configConstants')));
        constantMethods.set(constant.moduleKey, uniqueName(usedMethods, baseName));
        constantGetterFunctions.set(constant.moduleKey, uniqueName(usedValues, `get${baseName}`));
    }

    return {
        repositoryName: uniqueBindingName(usedTypes, usedValues, pascalCase(options.repositoryName || 'GeneratedConfigRepository', 'GeneratedConfigRepository')),
        enumTypes,
        structureTypes,
        tableTypes,
        constantTypes,
        tableProperties,
        constantProperties,
        tableMethods,
        constantMethods,
        tableFiles,
        tableGetterTypes,
        tableLoaderFunctions,
        constantGetterFunctions
    };
}

function normalizeSchema(schema) {
    return {
        version: Number(schema.version || 1),
        tables: schema.tables || {},
        constants: schema.constants || {},
        structures: normalizeStructureRecord(schema.structures),
        enums: normalizeEnumRecord(schema.enums)
    };
}

function normalizeStructureRecord(structures) {
    return Object.fromEntries(Object.entries(structures && typeof structures === 'object' ? structures : {}).map(([key, structure]) => [
        key,
        {
            description: stringValue(structure?.description),
            fields: arrayValue(structure?.fields).map((field) => {
                const type = structureFieldTypes.has(field?.type) ? field.type : 'string';
                return {
                    key: stringValue(field?.key).trim(),
                    type,
                    description: stringValue(field?.description),
                    numberConstraint: normalizeNumberConstraint(type, field?.numberConstraint)
                };
            }).filter((field) => field.key)
        }
    ]));
}

function normalizeEnumRecord(enums) {
    return Object.fromEntries(Object.entries(enums && typeof enums === 'object' ? enums : {}).map(([key, enumSchema]) => [
        key,
        {
            description: stringValue(enumSchema?.description),
            values: sortEnumValues(arrayValue(enumSchema?.values).map((enumValue) => ({
                key: stringValue(enumValue?.key).trim(),
                value: Number(enumValue?.value),
                description: stringValue(enumValue?.description)
            })).filter((enumValue) => enumValue.key && Number.isFinite(enumValue.value)))
        }
    ]));
}

function fieldsForTable(schema, moduleKey, headers, rows) {
    const schemaFields = arrayValue(schema.tables[moduleKey]?.fields)
        .filter((field) => field?.key)
        .map((field) => {
            const type = fieldTypes.has(field.type) ? field.type : 'string';
            return {
                key: stringValue(field.key).trim(),
                type,
                description: stringValue(field.description),
                structure: stringValue(field.structure).trim() || undefined,
                numberConstraint: normalizeNumberConstraint(type, field.numberConstraint)
            };
        });
    const knownKeys = new Set(schemaFields.map((field) => field.key));
    const inferred = headers
        .filter((header) => header && !knownKeys.has(header))
        .map((header) => ({
            key: header,
            type: inferFieldType(header, rows.map((row) => row[header] || '')),
            description: ''
        }));
    return ensureRequiredFields(schemaFields.length > 0 ? schemaFields.concat(inferred) : inferred);
}

function ensureRequiredFields(fields) {
    const normalizedFields = fields.map(normalizeRequiredField);
    const keys = new Set(normalizedFields.map((field) => field.key));
    const missingFields = [];
    if (!keys.has('id')) {
        missingFields.push({ key: 'id', type: 'number', description: 'ID' });
    }
    if (!keys.has('name')) {
        missingFields.push({ key: 'name', type: 'string', description: '显示名称' });
    }
    return missingFields.concat(normalizedFields);
}

function normalizeRequiredField(field) {
    if (field.key === 'id') {
        return { key: field.key, type: 'number', description: 'ID' };
    }
    if (field.key === 'name') {
        return { key: field.key, type: 'string', description: '显示名称' };
    }
    return field;
}

function normalizeNumberConstraint(type, constraint) {
    if (baseFieldType(type) !== 'number') {
        return undefined;
    }
    const kind = numberConstraintKinds.has(constraint?.kind) ? constraint.kind : 'number';
    if (kind === 'number') {
        const min = optionalNumber(constraint?.min);
        const max = optionalNumber(constraint?.max);
        if (min === undefined && max === undefined) {
            return undefined;
        }
        return {
            kind,
            ...(min === undefined ? {} : { min }),
            ...(max === undefined ? {} : { max })
        };
    }
    if (kind === 'reference') {
        const table = stringValue(constraint?.table).trim();
        return table ? { kind, table } : { kind };
    }
    const enumKey = stringValue(constraint?.enum).trim();
    return enumKey ? { kind, enum: enumKey } : { kind };
}

function baseFieldType(type) {
    return stringValue(type).replace('[]', '');
}

function optionalNumber(value) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
}

function inferFieldType(key, values) {
    const filledValues = values.filter((value) => value !== '');
    if (/_ids?$/.test(key) || key === 'id' || key.endsWith('_id')) {
        return 'number';
    }
    if (['tags', 'positions', 'base_abilities', 'ability_slots'].includes(key)) {
        return 'number[]';
    }
    if (['nodes', 'effects'].includes(key)) {
        return 'json[]';
    }
    if (key.endsWith('_json')) {
        return 'json';
    }
    if (filledValues.length > 0 && filledValues.every((value) => Number.isFinite(Number(value)))) {
        return 'number';
    }
    if (filledValues.length > 0 && filledValues.every((value) => value === 'true' || value === 'false')) {
        return 'boolean';
    }
    return 'string';
}

function csvToRows(text) {
    const table = parseCsv(text.trimEnd());
    const [headers, ...records] = table;
    if (!headers || (headers.length === 1 && headers[0] === '')) {
        return { headers: [], rows: [] };
    }
    return {
        headers,
        rows: records
            .filter((record) => record.some((value) => value.length > 0))
            .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] || ''])))
    };
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = '';
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (char === '"' && quoted && next === '"') {
            value += '"';
            index += 1;
            continue;
        }

        if (char === '"') {
            quoted = !quoted;
            continue;
        }

        if (char === ',' && !quoted) {
            row.push(value);
            value = '';
            continue;
        }

        if ((char === '\n' || char === '\r') && !quoted) {
            if (char === '\r' && next === '\n') {
                index += 1;
            }
            row.push(value);
            rows.push(row);
            row = [];
            value = '';
            continue;
        }

        value += char;
    }

    row.push(value);
    rows.push(row);
    return rows;
}

function withFieldDefaults(row, fields) {
    return Object.fromEntries(fields.map((field) => [field.key, row[field.key] || '']));
}

function moduleEntries(modules, prefix = []) {
    return Object.entries(modules).flatMap(([key, value]) => {
        const nextPrefix = prefix.concat(key);
        if (typeof value === 'string') {
            return [[nextPrefix.join('.'), value]];
        }
        if (value && typeof value === 'object') {
            return moduleEntries(value, nextPrefix);
        }
        return [];
    });
}

async function readJsonFile(filePath, fallback) {
    try {
        return JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return fallback;
        }
        throw error;
    }
}

function resolveConfigPath(configRoot, configPath) {
    const normalized = stringValue(configPath).trim().replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized.includes('://') || normalized.split('/').includes('..')) {
        throw new Error(`Invalid config path: ${configPath}`);
    }
    const root = path.resolve(configRoot);
    const target = path.resolve(root, normalized);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Config path escapes config root: ${configPath}`);
    }
    return target;
}

function resolveOutputPath(outputRoot, outputFile) {
    const root = path.resolve(outputRoot);
    const target = path.resolve(root, outputFile);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Output file escapes output root: ${outputFile}`);
    }
    return target;
}

function normalizeOutputFile(outputFile) {
    const normalized = stringValue(outputFile).trim().replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized.includes('://') || normalized.split('/').includes('..')) {
        throw new Error(`Invalid output file: ${outputFile}`);
    }
    if (!normalized.endsWith('.ts')) {
        throw new Error(`Output file must end with .ts: ${outputFile}`);
    }
    return normalized;
}

function assertEntryFileDoesNotCollide(outputFile) {
    const entryStem = fileStemFromOutputFile(outputFile).toLowerCase();
    if (['enum', 'runtime', 'structures', 'constants'].includes(entryStem)) {
        throw new Error(`Output entry file conflicts with generated ${entryStem}.ts: ${outputFile}`);
    }
}

function siblingOutputFile(outputFile, fileName) {
    const directory = path.posix.dirname(outputFile);
    return directory === '.' ? fileName : `${directory}/${fileName}`;
}

function fileStemFromOutputFile(outputFile) {
    return path.posix.basename(outputFile).replace(/\.ts$/, '');
}

function commentLines(text, indent = '') {
    const content = stringValue(text).trim();
    if (!content) {
        return [];
    }
    const safeLines = content.split(/\r?\n/).map((line) => line.replace(/\*\//g, '*\\/'));
    if (safeLines.length === 1) {
        return [`${indent}/** ${safeLines[0]} */`];
    }
    return [
        `${indent}/**`,
        ...safeLines.map((line) => `${indent} * ${line}`),
        `${indent} */`
    ];
}

function propertyKey(key) {
    return isIdentifier(key) && !reservedWords.has(key) ? key : JSON.stringify(key);
}

function enumMemberName(key) {
    const identifier = identifierFromParts([key], 'Value');
    return /^[A-Za-z_$]/.test(identifier) && !reservedWords.has(identifier) ? identifier : `Value${identifier}`;
}

function pascalCase(value, fallback) {
    const identifier = identifierFromParts(splitWords(value), fallback);
    return uppercaseFirst(identifier);
}

function camelCase(value, fallback) {
    const identifier = identifierFromParts(splitWords(value), fallback);
    return lowercaseFirst(identifier);
}

function splitWords(value) {
    return stringValue(value).split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function identifierFromParts(parts, fallback) {
    const words = parts.length > 0 ? parts : [fallback];
    const identifier = words
        .map((word) => stringValue(word).replace(/[^A-Za-z0-9_$]/g, ''))
        .filter(Boolean)
        .map(uppercaseFirst)
        .join('');
    const normalized = identifier || fallback;
    return /^[A-Za-z_$]/.test(normalized) ? normalized : `${fallback}${normalized}`;
}

function uppercaseFirst(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function lowercaseFirst(value) {
    return value.charAt(0).toLowerCase() + value.slice(1);
}

function isIdentifier(value) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function uniqueName(usedNames, baseName) {
    let name = baseName;
    let index = 2;
    while (usedNames.has(name) || reservedWords.has(name)) {
        name = `${baseName}${index}`;
        index += 1;
    }
    usedNames.add(name);
    return name;
}

function uniqueBindingName(usedTypes, usedValues, baseName) {
    let name = baseName;
    let index = 2;
    while (usedTypes.has(name) || usedValues.has(name) || reservedWords.has(name)) {
        name = `${baseName}${index}`;
        index += 1;
    }
    usedTypes.add(name);
    usedValues.add(name);
    return name;
}

function uniqueFileStem(usedFileStems, baseName) {
    const normalizedBase = stringValue(baseName).replace(/[^A-Za-z0-9_-]/g, '') || 'config';
    let stem = normalizedBase;
    let index = 2;
    while (usedFileStems.has(stem.toLowerCase())) {
        stem = `${normalizedBase}${index}`;
        index += 1;
    }
    usedFileStems.add(stem.toLowerCase());
    return stem;
}

function sortEnumValues(values) {
    return values.slice().sort((left, right) => {
        const valueDelta = left.value - right.value;
        if (valueDelta !== 0) {
            return valueDelta;
        }
        return left.key.localeCompare(right.key);
    });
}

function arrayValue(value) {
    return Array.isArray(value) ? value : [];
}

function stringValue(value) {
    return value === undefined || value === null ? '' : String(value);
}

function requiredString(value, message) {
    const text = stringValue(value).trim();
    if (!text) {
        throw new Error(message);
    }
    return text;
}
