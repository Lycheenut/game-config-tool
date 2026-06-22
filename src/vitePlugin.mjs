import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fieldTypes = new Set(['string', 'number', 'boolean', 'number[]', 'string[]', 'boolean[]', 'json', 'json[]']);
const structureFieldTypes = new Set(['string', 'number', 'boolean', 'number[]', 'string[]', 'boolean[]']);
const numberConstraintKinds = new Set(['number', 'reference', 'enum']);
const requiredCsvFields = ['id', 'name'];

export function configToolPlugin(options = {}) {
    const context = createConfigToolContext(options);
    return {
        name: 'config-tool',
        configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
                const route = request.url?.split('?')[0];
                if (route === '/__config-tool/api/config' && request.method === 'GET') {
                    await handleRequest(response, () => readConfigSnapshot(context));
                    return;
                }

                if (route === '/__config-tool/api/save' && request.method === 'POST') {
                    await handleRequest(response, async () => {
                        const payload = await readBody(request);
                        return await saveConfigSnapshot(context, payload);
                    });
                    return;
                }

                next();
            });
        }
    };
}


function createConfigToolContext(options) {
    const configRoot = path.resolve(options.configRoot ?? 'public/config');
    return {
        configRoot,
        manifestPath: path.join(configRoot, 'manifest.json'),
        schemaPath: path.join(configRoot, 'schema.json')
    };
}

async function handleRequest(response, action) {
    try {
        writeJson(response, 200, await action());
    } catch (error) {
        console.error(error);
        writeJson(response, 400, { error: error instanceof Error ? error.message : 'Unknown config tool error.' });
    }
}

function writeJson(response, statusCode, payload) {
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(payload));
}

async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(chunk);
    }

    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) {
        return {};
    }
    return JSON.parse(text);
}

async function readConfigSnapshot(context) {
    const manifest = await readJsonFile(context.manifestPath, { modules: {} });
    const schema = normalizeSchema(await readJsonFile(context.schemaPath, { version: 1, tables: {}, constants: {}, structures: {}, enums: {} }));
    const tables = [];
    const constants = [];

    for (const [moduleKey, configPath] of moduleEntries(manifest.modules ?? {})) {
        if (configPath.toLowerCase().endsWith('.csv')) {
            const text = await readConfigText(context, configPath);
            const { headers, rows } = csvToRows(text);
            const fields = fieldsForTable(schema, moduleKey, configPath, headers, rows);
            tables.push({
                moduleKey,
                path: configPath,
                fields,
                rows: rows.map((row) => withFieldDefaults(row, fields))
            });
            continue;
        }

        if (configPath.toLowerCase().endsWith('.json')) {
            const text = await readConfigText(context, configPath);
            JSON.parse(text);
            constants.push({
                moduleKey,
                path: configPath,
                description: stringValue(schema.constants?.[moduleKey]?.description),
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

async function saveConfigSnapshot(context, payload) {
    const manifest = payload.manifest && typeof payload.manifest === 'object' ? { ...payload.manifest } : {};
    const modules = {};
    const nextSchema = {
        version: Number(payload.schema?.version ?? 1),
        tables: {},
        constants: {},
        enums: normalizeEnums(payload.schema?.enums)
    };
    nextSchema.structures = normalizeStructures(payload.schema?.structures);
    const activePaths = new Set();
    const moduleKeys = new Set();
    const writes = [];

    for (const table of arrayValue(payload.tables)) {
        const moduleKey = normalizeModuleKey(table.moduleKey);
        const configPath = normalizeConfigPath(pathForModuleKey(moduleKey, '.csv'), '.csv');
        rejectDuplicate(moduleKeys, moduleKey, 'module key');
        rejectDuplicate(activePaths, configPath, 'config path');

        const fields = normalizeFields(table.fields);
        const rows = normalizeRows(table.rows, fields);
        setModulePath(modules, moduleKey, configPath);
        nextSchema.tables[moduleKey] = { path: configPath, fields };
        writes.push([configPath, rowsToCsv(fields, rows)]);
    }

    for (const constant of arrayValue(payload.constants)) {
        const moduleKey = normalizeModuleKey(constant.moduleKey);
        const configPath = normalizeConfigPath(pathForModuleKey(moduleKey, '.json'), '.json');
        rejectDuplicate(moduleKeys, moduleKey, 'module key');
        rejectDuplicate(activePaths, configPath, 'config path');

        const parsed = JSON.parse(stringValue(constant.text));
        setModulePath(modules, moduleKey, configPath);
        nextSchema.constants[moduleKey] = {
            path: configPath,
            description: stringValue(constant.description)
        };
        writes.push([configPath, `${JSON.stringify(parsed, null, 4)}\n`]);
    }

    for (const [configPath, text] of writes) {
        await writeConfigText(context, configPath, text);
    }
    manifest.modules = modules;
    await writeFile(context.manifestPath, `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');
    await writeFile(context.schemaPath, `${JSON.stringify(nextSchema, null, 4)}\n`, 'utf8');

    for (const deletedPath of arrayValue(payload.deletedPaths)) {
        const configPath = normalizeConfigPath(deletedPath);
        if (activePaths.has(configPath) || configPath === 'manifest.json' || configPath === 'schema.json') {
            continue;
        }
        await rm(resolveConfigPath(context, configPath), { force: true });
    }

    return await readConfigSnapshot(context);
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

async function readConfigText(context, configPath) {
    return await readFile(resolveConfigPath(context, configPath), 'utf8');
}

async function writeConfigText(context, configPath, text) {
    const targetPath = resolveConfigPath(context, configPath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, text, 'utf8');
}

function resolveConfigPath(context, configPath) {
    const normalized = normalizeConfigPath(configPath);
    const root = path.resolve(context.configRoot);
    const target = path.resolve(root, normalized);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Config path escapes public/config: ${configPath}`);
    }
    return target;
}

function normalizeConfigPath(configPath, extension) {
    const normalized = stringValue(configPath).trim().replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized.includes('://') || normalized.split('/').includes('..')) {
        throw new Error(`Invalid config path: ${configPath}`);
    }
    if (extension && !normalized.toLowerCase().endsWith(extension)) {
        throw new Error(`Config path must end with ${extension}: ${configPath}`);
    }
    if (!normalized.toLowerCase().endsWith('.csv') && !normalized.toLowerCase().endsWith('.json')) {
        throw new Error(`Config path must be a CSV or JSON file: ${configPath}`);
    }
    return normalized;
}

function normalizeModuleKey(moduleKey) {
    const normalized = stringValue(moduleKey).trim();
    if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(normalized)) {
        throw new Error(`Invalid module key: ${moduleKey}`);
    }
    return normalized;
}

function pathForModuleKey(moduleKey, extension) {
    const parts = moduleKey.split('.');
    const fileName = `${parts[parts.length - 1]}${extension}`;
    if (parts.length === 1) {
        return fileName;
    }
    return `${parts.slice(0, -1).join('/')}/${fileName}`;
}

function normalizeFields(fields) {
    const keys = new Set();
    const normalized = arrayValue(fields).map((field) => {
        const key = stringValue(field.key).trim();
        const type = requiredFieldType(key) ?? (fieldTypes.has(field.type) ? field.type : 'string');
        const structure = requiredFieldType(key) ? '' : stringValue(field.structure).trim();
        const numberConstraint = requiredFieldType(key) ? undefined : normalizeNumberConstraint(type, field.numberConstraint);
        if (!/^[A-Za-z0-9_]+$/.test(key)) {
            throw new Error(`Invalid field key: ${key}`);
        }
        if (structure && type !== 'json' && type !== 'json[]') {
            throw new Error(`Only json/json[] fields can reference structures: ${key}`);
        }
        rejectDuplicate(keys, key, 'field key');
        const nextField = {
            key,
            type,
            description: requiredFieldDescription(key) ?? stringValue(field.description)
        };
        if (structure) {
            nextField.structure = structure;
        }
        if (numberConstraint) {
            nextField.numberConstraint = numberConstraint;
        }
        return nextField;
    });

    if (normalized.length === 0) {
        throw new Error('CSV table must have at least one field.');
    }
    requiredCsvFields.forEach((fieldKey) => {
        if (!keys.has(fieldKey)) {
            throw new Error(`CSV table must include field: ${fieldKey}`);
        }
    });
    return normalized;
}

function normalizeSchema(schema) {
    return {
        version: Number(schema.version ?? 1),
        tables: schema.tables ?? {},
        constants: schema.constants ?? {},
        structures: normalizeStructures(schema.structures),
        enums: normalizeEnums(schema.enums)
    };
}

function normalizeStructures(structures) {
    const normalized = {};
    const keys = new Set();
    Object.entries(structures && typeof structures === 'object' ? structures : {}).forEach(([key, value]) => {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
            throw new Error(`Invalid structure key: ${key}`);
        }
        rejectDuplicate(keys, key, 'structure key');
        const fieldKeys = new Set();
        normalized[key] = {
            description: stringValue(value?.description),
            fields: arrayValue(value?.fields).map((field) => {
                const fieldKey = stringValue(field.key).trim();
                const type = structureFieldTypes.has(field.type) ? field.type : 'string';
                const numberConstraint = normalizeNumberConstraint(type, field.numberConstraint);
                if (!/^[A-Za-z0-9_]+$/.test(fieldKey)) {
                    throw new Error(`Invalid structure field key: ${key}.${fieldKey}`);
                }
                rejectDuplicate(fieldKeys, fieldKey, `${key} structure field key`);
                const nextField = {
                    key: fieldKey,
                    type,
                    description: stringValue(field.description)
                };
                if (numberConstraint) {
                    nextField.numberConstraint = numberConstraint;
                }
                return nextField;
            })
        };
    });
    return normalized;
}

function normalizeEnums(enums) {
    const normalized = {};
    const keys = new Set();
    Object.entries(enums && typeof enums === 'object' ? enums : {}).forEach(([key, value]) => {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
            throw new Error(`Invalid enum key: ${key}`);
        }
        rejectDuplicate(keys, key, 'enum key');
        const valueKeys = new Set();
        const enumValues = new Set();
        normalized[key] = {
            description: stringValue(value?.description),
            values: sortEnumValues(arrayValue(value?.values).map((enumValue) => {
                const valueKey = stringValue(enumValue.key).trim();
                const numericValue = Number(enumValue.value);
                if (!/^[A-Za-z0-9_]+$/.test(valueKey)) {
                    throw new Error(`Invalid enum value key: ${key}.${valueKey}`);
                }
                if (!Number.isFinite(numericValue)) {
                    throw new Error(`Invalid enum value for ${key}.${valueKey}: ${enumValue.value}`);
                }
                rejectDuplicate(valueKeys, valueKey, `${key} enum value key`);
                rejectDuplicate(enumValues, numericValue, `${key} enum value`);
                return {
                    key: valueKey,
                    value: numericValue,
                    description: stringValue(enumValue.description)
                };
            }))
        };
    });
    return normalized;
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

function normalizeRows(rows, fields) {
    return arrayValue(rows).map((row) => {
        const nextRow = {};
        fields.forEach((field) => {
            nextRow[field.key] = stringValue(row?.[field.key]);
        });
        return nextRow;
    });
}

function rejectDuplicate(values, value, label) {
    if (values.has(value)) {
        throw new Error(`Duplicate ${label}: ${value}`);
    }
    values.add(value);
}

function setModulePath(root, moduleKey, configPath) {
    const parts = moduleKey.split('.');
    let cursor = root;
    parts.slice(0, -1).forEach((part) => {
        if (typeof cursor[part] === 'string') {
            throw new Error(`Module key conflicts with file path: ${moduleKey}`);
        }
        cursor[part] ??= {};
        cursor = cursor[part];
    });
    cursor[parts[parts.length - 1]] = configPath;
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

function fieldsForTable(schema, moduleKey, configPath, headers, rows) {
    const schemaFields = arrayValue(schema.tables?.[moduleKey]?.fields)
        .map((field) => {
            const type = fieldTypes.has(field.type) ? field.type : 'string';
            return {
                key: stringValue(field.key).trim(),
                type,
                description: stringValue(field.description),
                structure: stringValue(field.structure).trim() || undefined,
                numberConstraint: normalizeNumberConstraint(type, field.numberConstraint)
            };
        })
        .filter((field) => field.key);
    const knownKeys = new Set(schemaFields.map((field) => field.key));
    const inferred = headers
        .filter((header) => header && !knownKeys.has(header))
        .map((header) => ({
            key: header,
            type: inferFieldType(header, rows.map((row) => row[header] ?? '')),
            description: ''
        }));

    if (schemaFields.length > 0) {
        return ensureRequiredFields(schemaFields.concat(inferred));
    }

    return ensureRequiredFields(headers.map((header) => ({
        key: header,
        type: inferFieldType(header, rows.map((row) => row[header] ?? '')),
        description: ''
    })));
}

function ensureRequiredFields(fields) {
    const normalizedFields = fields.map(normalizeRequiredField);
    const keys = new Set(normalizedFields.map((field) => field.key));
    const missingFields = [];
    if (!keys.has('id')) {
        missingFields.push({ key: 'id', type: 'number', description: requiredFieldDescription('id') });
    }
    if (!keys.has('name')) {
        missingFields.push({ key: 'name', type: 'string', description: requiredFieldDescription('name') });
    }
    return missingFields.concat(normalizedFields);
}

function normalizeRequiredField(field) {
    const type = requiredFieldType(field.key);
    if (!type) {
        return field;
    }
    return {
        key: field.key,
        type,
        description: requiredFieldDescription(field.key)
    };
}

function requiredFieldType(key) {
    if (key === 'id') {
        return 'number';
    }
    if (key === 'name') {
        return 'string';
    }
    return undefined;
}

function requiredFieldDescription(key) {
    if (key === 'id') {
        return 'ID';
    }
    if (key === 'name') {
        return '显示名称';
    }
    return undefined;
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

function withFieldDefaults(row, fields) {
    return Object.fromEntries(fields.map((field) => [field.key, row[field.key] ?? '']));
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
            .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ''])))
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

function rowsToCsv(fields, rows) {
    const matrix = [
        fields.map((field) => field.key),
        ...rows.map((row) => fields.map((field) => stringValue(row[field.key])))
    ];
    return `${matrix.map((row) => row.map(escapeCsvCell).join(',')).join('\n')}\n`;
}

function escapeCsvCell(value) {
    if (/[",\r\n]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

function arrayValue(value) {
    return Array.isArray(value) ? value : [];
}

function stringValue(value) {
    return value === undefined || value === null ? '' : String(value);
}

