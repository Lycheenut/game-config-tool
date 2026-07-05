import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateConfigCodeFromDirectory } from '../src/codegen.mjs';

const displayName = '\u663e\u793a\u540d\u79f0';
const garbledDisplayName = '\u93c4\u5267\u305a\u935a\u5d87\u041e';

test('codegen preserves Chinese field comments and avoids trailing blank lines', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'game-config-codegen-'));
    const inputRoot = path.join(root, 'config');
    const outputRoot = path.join(root, 'generated');
    await mkdir(inputRoot, { recursive: true });
    await writeFile(path.join(inputRoot, 'manifest.json'), `${JSON.stringify({ modules: { items: 'items.csv' } }, null, 4)}\n`, 'utf8');
    await writeFile(path.join(inputRoot, 'schema.json'), `${JSON.stringify({
        version: 1,
        tables: {
            items: {
                fields: [
                    { key: 'id', type: 'number', description: 'ID' },
                    { key: 'name', type: 'string', description: displayName }
                ]
            }
        },
        constants: {},
        structures: {},
        enums: {}
    }, null, 4)}\n`, 'utf8');
    await writeFile(path.join(inputRoot, 'items.csv'), `id,name\n1,${displayName}\n`, 'utf8');

    const result = await generateConfigCodeFromDirectory({ inputRoot, outputRoot });
    const tableModule = await readFile(path.join(outputRoot, 'items.ts'), 'utf8');

    assert.match(tableModule, new RegExp(`/\\*\\* ${displayName} \\*/`));
    assert.doesNotMatch(tableModule, new RegExp(garbledDisplayName));

    for (const filePath of result.files) {
        const code = await readFile(filePath, 'utf8');
        assert.equal(code.match(/\n+$/)?.[0], '\n', `${path.basename(filePath)} should end with exactly one LF`);
    }
});

test('codegen emits kv pair structure field types', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'game-config-codegen-'));
    const inputRoot = path.join(root, 'config');
    const outputRoot = path.join(root, 'generated');
    await mkdir(inputRoot, { recursive: true });
    await writeFile(path.join(inputRoot, 'manifest.json'), `${JSON.stringify({ modules: { items: 'items.csv' } }, null, 4)}\n`, 'utf8');
    await writeFile(path.join(inputRoot, 'schema.json'), `${JSON.stringify({
        version: 1,
        tables: {
            items: {
                fields: [
                    { key: 'id', type: 'number', description: 'ID' },
                    { key: 'name', type: 'string', description: displayName },
                    { key: 'stats', type: 'json', description: 'Stats', structure: 'ItemStats' },
                    {
                        key: 'modifiers',
                        type: 'kvPairs',
                        description: 'Modifiers',
                        keyType: 'string',
                        valueType: 'number',
                        valueNumberConstraint: { kind: 'enum', enum: 'StatKind' }
                    }
                ]
            }
        },
        constants: {},
        structures: {
            ItemStats: {
                description: 'Item stats',
                fields: [
                    {
                        key: 'bonuses',
                        type: 'kvPairs',
                        description: 'Bonus pairs',
                        keyType: 'string',
                        valueType: 'number',
                        valueNumberConstraint: { kind: 'enum', enum: 'StatKind' }
                    }
                ]
            }
        },
        enums: {
            StatKind: {
                description: 'Stat kind',
                values: [
                    { key: 'Attack', value: 1, description: 'Attack' }
                ]
            }
        }
    }, null, 4)}\n`, 'utf8');
    await writeFile(path.join(inputRoot, 'items.csv'), 'id,name,stats,modifiers\n1,Sword,"{""bonuses"":[{""key"":""atk"",""value"":1}]}","[{""key"":""atk"",""value"":1}]"\n', 'utf8');

    await generateConfigCodeFromDirectory({ inputRoot, outputRoot });
    const structuresModule = await readFile(path.join(outputRoot, 'structures.ts'), 'utf8');
    const tableModule = await readFile(path.join(outputRoot, 'items.ts'), 'utf8');

    assert.match(structuresModule, /import type \{ StatKind \} from "\.\/enum";/);
    assert.match(structuresModule, /bonuses: Array<\{ key: string; value: StatKind \}>;/);
    assert.match(tableModule, /import type \{ StatKind \} from "\.\/enum";/);
    assert.match(tableModule, /modifiers: Array<\{ key: string; value: StatKind \}>;/);
    assert.match(tableModule, /modifiers: jsonValue<Array<\{ key: string; value: StatKind \}>>\(row\["modifiers"\], \[\]\),/);
});
