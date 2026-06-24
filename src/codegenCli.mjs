#!/usr/bin/env node
import path from 'node:path';
import { generateConfigCodeFromDirectory } from './codegen.mjs';

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }

    const inputRoot = requiredArg(args.inputRoot, '--input');
    const output = requiredArg(args.output, '--output');
    const outputTarget = resolveOutputTarget(output, args.outputFile);
    const result = await generateConfigCodeFromDirectory({
        inputRoot,
        outputRoot: outputTarget.outputRoot,
        outputFile: outputTarget.outputFile,
        repositoryName: args.repositoryName,
        staticBaseUrl: args.staticBaseUrl
    });

    process.stdout.write(`Generated ${result.files.length} file(s):\n`);
    result.files.forEach((filePath) => {
        process.stdout.write(`- ${filePath}\n`);
    });
}

function parseArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') {
            args.help = true;
            continue;
        }
        if (arg === '--input' || arg === '-i') {
            args.inputRoot = nextValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === '--output' || arg === '-o') {
            args.output = nextValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === '--file') {
            args.outputFile = nextValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === '--base-url') {
            args.staticBaseUrl = nextValue(argv, index, arg);
            index += 1;
            continue;
        }
        if (arg === '--repository-name') {
            args.repositoryName = nextValue(argv, index, arg);
            index += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function resolveOutputTarget(output, outputFile) {
    if (outputFile) {
        return {
            outputRoot: output,
            outputFile
        };
    }
    if (path.extname(output) === '.ts') {
        return {
            outputRoot: path.dirname(output),
            outputFile: path.basename(output)
        };
    }
    return {
        outputRoot: output,
        outputFile: 'index.ts'
    };
}

function nextValue(argv, index, arg) {
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
        throw new Error(`Missing value for ${arg}`);
    }
    return value;
}

function requiredArg(value, name) {
    if (!value) {
        throw new Error(`Missing required argument: ${name}`);
    }
    return value;
}

function printHelp() {
    process.stdout.write(`Usage: game-config-codegen --input <configRoot> --output <outputPath> [options]

Options:
  -i, --input <path>           Directory containing manifest.json and schema.json.
  -o, --output <path>          Output directory, or a .ts output file path.
      --file <name.ts>         Output file name when --output is a directory. Defaults to index.ts.
      --base-url <url>         Default runtime base URL for generated loaders. Defaults to /config.
      --repository-name <name> Generated repository class name. Defaults to GeneratedConfigRepository.
  -h, --help                   Show this help.
`);
}

main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
