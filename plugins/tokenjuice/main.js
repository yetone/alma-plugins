import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;

async function isExecutable(path) {
    if (typeof path !== 'string' || !isAbsolute(path)) return false;
    try {
        await access(path, constants.X_OK);
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

/** Only command text changes; Alma keeps ownership of approval and execution. */
export function createBeforeToolHandler(getConfig, executableCheck = isExecutable, platform = process.platform) {
    return async (input, output) => {
        try {
            if (platform === 'win32' || !isRecord(input) || !isRecord(output)
                || input.tool !== 'Bash' || output.cancel === true) return;
            const args = output.args ?? input.args;
            if (!isRecord(args) || typeof args.command !== 'string' || !args.command.trim()
                || args.run_in_background === true) return;
            const { executablePath, shellPath } = getConfig();
            // Conservative bypass also covers explicit raw wrappers and aliased launchers.
            if (args.command.includes('tokenjuice') || /\bwrap\s+--raw\b/.test(args.command)
                || (typeof executablePath === 'string' && executablePath.length > 0
                    && args.command.includes(executablePath) && /\bwrap\b/.test(args.command))) return;
            if (!await executableCheck(executablePath) || !await executableCheck(shellPath)) return;
            output.args = {
                ...args,
                command: `${quote(executablePath)} wrap --keep-failures --source alma -- ${quote(shellPath)} -lc ${quote(args.command)}`,
            };
        } catch {
            // Missing settings, binaries, or an incompatible payload leave the call unchanged.
        }
    };
}

export async function activate(context) {
    const subscription = context.events.on('tool.willExecute', createBeforeToolHandler(() => ({
        executablePath: context.settings.get('tokenjuice.executablePath', ''),
        shellPath: context.settings.get('tokenjuice.shellPath', '/bin/bash'),
    })));
    return { dispose: () => subscription.dispose() };
}
