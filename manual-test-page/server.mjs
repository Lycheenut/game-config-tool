import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { createConfigToolMiddleware } from '../src/nodeMiddleware.mjs';

const pageRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(pageRoot, '..');
const configRoot = path.join(pageRoot, 'config');
const preferredPort = Number(process.env.PORT ?? 4173);
const middleware = createConfigToolMiddleware({ configRoot });

const server = createServer(async (request, response) => {
    let forwarded = false;
    try {
        await middleware(request, response, () => {
            forwarded = true;
        });
        if (!forwarded || response.writableEnded) {
            return;
        }
        await servePageRequest(request, response);
    } catch (error) {
        console.error(error);
        if (!response.headersSent) {
            sendText(response, 500, 'Internal server error.');
        } else {
            response.destroy();
        }
    }
});

const port = await listenWithFallback(server, preferredPort);
console.log(`Config tool test page: http://localhost:${port}/`);

async function servePageRequest(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendText(response, 405, 'Method not allowed.');
        return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/index.html') {
        await sendFile(response, pageRoot, 'index.html');
        return;
    }
    if (url.pathname === '/style.css') {
        await sendFile(response, projectRoot, 'style.css');
        return;
    }
    if (url.pathname === '/src/ConfigTool.js') {
        await sendConfigToolModule(response);
        return;
    }
    if (url.pathname.startsWith('/config/')) {
        await sendFile(response, configRoot, url.pathname.slice('/config/'.length));
        return;
    }
    if (url.pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
    }

    sendText(response, 404, 'Not found.');
}

async function sendConfigToolModule(response) {
    const source = await readFile(path.join(projectRoot, 'src', 'ConfigTool.ts'), 'utf8');
    const result = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ES2020,
            target: ts.ScriptTarget.ES2020,
            useDefineForClassFields: true
        }
    });
    sendBuffer(response, 200, 'text/javascript; charset=utf-8', Buffer.from(result.outputText, 'utf8'));
}

async function sendFile(response, root, relativePath) {
    const targetPath = resolveInside(root, relativePath);
    const fileStat = await stat(targetPath).catch(() => undefined);
    if (!fileStat?.isFile()) {
        sendText(response, 404, 'Not found.');
        return;
    }
    sendBuffer(response, 200, mimeType(targetPath), await readFile(targetPath));
}

function sendText(response, statusCode, text) {
    sendBuffer(response, statusCode, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

function sendBuffer(response, statusCode, contentType, body) {
    response.writeHead(statusCode, {
        'Content-Type': contentType,
        'Content-Length': body.byteLength
    });
    response.end(body);
}

function resolveInside(root, relativePath) {
    const targetPath = path.resolve(root, decodeURIComponent(relativePath));
    const relative = path.relative(root, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Request path escapes root: ${relativePath}`);
    }
    return targetPath;
}

function mimeType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.html') {
        return 'text/html; charset=utf-8';
    }
    if (extension === '.json') {
        return 'application/json; charset=utf-8';
    }
    if (extension === '.csv') {
        return 'text/csv; charset=utf-8';
    }
    if (extension === '.js') {
        return 'text/javascript; charset=utf-8';
    }
    if (extension === '.css') {
        return 'text/css; charset=utf-8';
    }
    return 'application/octet-stream';
}

async function listenWithFallback(server, startPort) {
    for (let offset = 0; offset < 20; offset += 1) {
        const port = startPort + offset;
        try {
            await listen(server, port);
            return port;
        } catch (error) {
            if (error?.code !== 'EADDRINUSE') {
                throw error;
            }
        }
    }
    throw new Error(`No available port from ${startPort} to ${startPort + 19}.`);
}

function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
            server.off('error', reject);
            resolve();
        });
    });
}
