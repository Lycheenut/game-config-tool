# @lycheenut/game-config-tool

A browser editor for game configuration data stored as CSV tables and JSON constants.

The package provides:

- `newConfigTool` for mounting the config editor into a DOM container.
- `createConfigToolMiddleware` for loading and saving config files from any Node-based development server.
- `game-config-codegen` for generating TypeScript config readers and enum definitions.
- TypeScript types for config payloads, schemas, fields, enums, structures, save requests, and code generation requests.

## Installation

```sh
npm install @lycheenut/game-config-tool
```

> This package is currently marked as private in `package.json`. Remove `"private": true` before publishing it to npm.

## Requirements

- ESM runtime or bundler support.
- A browser environment for `newConfigTool`.
- A Node-based development server when using writable config editing.

## Quick Start

### 1. Add the Node middleware

```js
import { createConfigToolMiddleware } from '@lycheenut/game-config-tool/node';

const configToolMiddleware = createConfigToolMiddleware({
    configRoot: 'public/config',
    codegen: {
        outputRoot: 'src/generated/config'
    }
});
```

`configRoot` defaults to `public/config`. The middleware exposes:

- `GET /__config-tool/api/config` to load the current config snapshot.
- `POST /__config-tool/api/save` to save the edited snapshot.
- `POST /__config-tool/api/generate` to generate TypeScript config readers when codegen options are provided.

### 2. Mount the editor

```ts
import { newConfigTool } from '@lycheenut/game-config-tool';

const container = document.getElementById('config-tool');

if (!container) {
    throw new Error('Missing #config-tool container.');
}

const configTool = newConfigTool({
    container,
    path: '/config',
    codegen: true
});

await configTool.load();
```

When the development API is unavailable, the editor falls back to readonly static loading from `path` or `/config`.

Set `codegen` to `true` to show the web `生成代码` action and use middleware codegen options, or pass an object such as `{ outputRoot: 'src/generated/config' }` to send request-specific options.

## Server Integration

### Express

```js
import express from 'express';
import { createConfigToolMiddleware } from '@lycheenut/game-config-tool/node';

const app = express();

app.use(createConfigToolMiddleware({
    configRoot: 'public/config'
}));
```

### Webpack Dev Server

```js
import { createConfigToolMiddleware } from '@lycheenut/game-config-tool/node';

export default {
    devServer: {
        setupMiddlewares(middlewares, devServer) {
            devServer.app.use(createConfigToolMiddleware({
                configRoot: 'public/config'
            }));
            return middlewares;
        }
    }
};
```

### Node HTTP Server

```js
import http from 'node:http';
import { createConfigToolMiddleware } from '@lycheenut/game-config-tool/node';

const middleware = createConfigToolMiddleware({
    configRoot: 'public/config'
});

http.createServer((request, response) => {
    middleware(request, response, () => {
        response.statusCode = 404;
        response.end('Not found');
    });
}).listen(3000);
```

## Config Directory

The default config directory is `public/config`.

```text
public/config/
  manifest.json
  schema.json
  items.csv
  constants.json
```

### `manifest.json`

`manifest.json` maps module keys to CSV or JSON config files.

```json
{
    "modules": {
        "items": "items.csv",
        "game": {
            "constants": "game/constants.json"
        }
    }
}
```

Nested manifest objects become dotted module keys such as `game.constants`.

### CSV tables

CSV tables must include `id` and `name` fields. The editor stores table schema in `schema.json` and row data in CSV files.

```csv
id,name,price
1,Sword,100
2,Shield,150
```

### JSON constants

JSON files are edited as constant payloads and saved with formatted JSON.

```json
{
    "maxLevel": 100,
    "startingGold": 500
}
```

## Code Generation

The generator reads `manifest.json`, `schema.json`, CSV tables, and JSON constants, then writes a TypeScript module set. The generated files include:

- `enum.ts` for custom `enum` definitions, with comments from enum and value descriptions.
- `structures.ts` for custom structure interfaces.
- One module per CSV table with the row interface, table loader, and table getter.
- `constants.ts` with JSON constant type aliases, a generic constant loader, and per-constant getters.
- An entry module with a repository class, `loadConfig()`, and re-exports for the generated modules.

### Web trigger

Configure local paths on the middleware, then enable the button in the browser editor:

```js
createConfigToolMiddleware({
    configRoot: 'public/config',
    codegen: {
        inputRoot: 'public/config',
        outputRoot: 'src/generated/config',
        outputFile: 'index.ts'
    }
});
```

```ts
newConfigTool({
    container,
    path: '/config',
    codegen: true
});
```

The web action reads the configured input directory from disk. If the editor has unsaved changes, save first so generated code matches the files.

### CLI trigger

```sh
game-config-codegen --input public/config --output src/generated/config
```

Use `--output src/generated/config/index.ts` to choose the entry file path; sibling modules such as `enum.ts`, `constants.ts`, and table files are generated next to it. `--file config.ts` changes the entry file name when `--output` is a directory. `--base-url` changes the generated loader's default runtime URL.

Example generated usage:

```ts
import { loadConfig } from './generated/config';

const config = await loadConfig({ baseUrl: '/config' });
const item = config.requireItemsById(1);
const gameConstants = config.getGameConstants();
```

## API

### `newConfigTool(options)`

Creates a config editor handle.

```ts
import { newConfigTool, type ConfigToolHandle } from '@lycheenut/game-config-tool';

const handle: ConfigToolHandle = newConfigTool({
    container: document.body,
    path: '/config'
});
```

Options:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `container` | `HTMLElement` | Yes | DOM element that receives the config editor UI. |
| `path` | `string` | No | Static config base URL used by readonly fallback loading. Defaults to `/config`. |
| `codegen` | `boolean \| ConfigToolCodegenRequestOptions` | No | Shows the web codegen action. `true` uses middleware options; an object is posted to the generate endpoint. |

Handle methods:

| Method | Description |
| --- | --- |
| `load()` | Loads the current config snapshot. |
| `refresh()` | Reloads the current config snapshot. |
| `destroy()` | Clears the mounted editor UI. |

### `createConfigToolMiddleware(options)`

Creates a Node HTTP middleware.

```js
import { createConfigToolMiddleware } from '@lycheenut/game-config-tool/node';

createConfigToolMiddleware({
    configRoot: 'public/config'
});
```

Options:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `configRoot` | `string` | No | Directory containing `manifest.json`, `schema.json`, and config files. Defaults to `public/config`. |
| `codegen` | `ConfigToolCodegenRequestOptions` | No | Default codegen input/output options for `POST /__config-tool/api/generate`. `inputRoot` defaults to `configRoot`; `outputRoot` is required before generating. |

Middleware signature:

```ts
(request, response, next?: () => void) => Promise<void>
```

## Exported Types

The root module exports the following TypeScript types:

- `ConfigModuleTree`
- `ConfigRepository`
- `ConfigSchema`
- `ConfigToolCodegenRequestOptions`
- `ConfigToolCodegenResult`
- `ConfigToolHandle`
- `ConfigToolOptions`
- `ConfigToolPayload`
- `ConfigToolSaveRequest`
- `ConstantPayload`
- `CsvRow`
- `CsvTablePayload`
- `EnumSchema`
- `EnumValueSchema`
- `FieldSchema`
- `FieldType`
- `HttpConfigRepositoryOptions`
- `Manifest`
- `MountConfigToolOptions`
- `NumberConstraintKind`
- `StaticConfigRepositoryOptions`
- `StructureFieldSchema`
- `StructureFieldType`
- `StructureSchema`

## Development

Install dependencies:

```sh
npm install
```

Run type checking:

```sh
npm run typecheck
```

## Publishing

Before publishing to npm, update `package.json` as needed:

- Remove `"private": true`.
- Add a `license` field or a `LICENSE` file.
- Ensure package entry points and exported files match the intended published artifact.

## License

No license is currently specified.
