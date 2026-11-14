import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { activate, createBeforeToolHandler } from './main.js';

const config = { executablePath: '/opt/tools/tokenjuice', shellPath: '/bin/bash' };
const handler = (overrides = {}) => createBeforeToolHandler(() => ({ ...config, ...overrides }), async () => true, 'linux');

test('wraps effective arguments without losing metadata or changing the input', async () => {
    const input = { tool: 'Bash', args: { command: 'original', timeout: 5 } };
    const effective = { command: 'git status --short', timeout: 10, description: 'status', custom: true };
    const output = { args: effective, other: 'preserved' };
    await handler()(input, output);
    assert.equal(output.args.command, "'/opt/tools/tokenjuice' wrap --keep-failures --source alma -- '/bin/bash' -lc 'git status --short'");
    assert.deepEqual({ ...output.args, command: effective.command }, effective);
    assert.equal(output.other, 'preserved');
    assert.equal(input.args.command, 'original');
    assert.equal(effective.command, 'git status --short');
});

test('shell metacharacters in paths and commands remain literal arguments', { skip: process.platform === 'win32' }, async () => {
    const executablePath = "/opt/tools/it's tokenjuice; $(false)";
    const shellPath = "/opt/shell's bash";
    const command = "printf '%s' \"$(printf value)\"\nexit 0";
    const output = {};
    await handler({ executablePath, shellPath })({ tool: 'Bash', args: { command } }, output);
    const words = execFileSync('/bin/sh', ['-c', `set -- ${output.args.command}; printf '%s\\0' "$@"`], { encoding: 'utf8' }).split('\0');
    assert.deepEqual(words, [executablePath, 'wrap', '--keep-failures', '--source', 'alma', '--', shellPath, '-lc', command, '']);
});

test('cancellation and background requests are untouched', async () => {
    const cancelled = { cancel: true };
    await handler()({ tool: 'Bash', args: { command: 'git status' } }, cancelled);
    assert.deepEqual(cancelled, { cancel: true });
    const background = {};
    await handler()({ tool: 'Bash', args: { command: 'git status', run_in_background: true } }, background);
    assert.deepEqual(background, {});
});

test('existing wrappers and raw output requests are untouched', async () => {
    for (const command of [
        'tokenjuice wrap --raw -- git status',
        "cd project && '/opt/tools/tokenjuice' wrap -- git status",
        'node /opt/build/main.js wrap --raw -- cat file',
        "'/opt/tj' wrap -- git status",
    ]) {
        const output = {};
        await handler({ executablePath: '/opt/tj' })({ tool: 'Bash', args: { command } }, output);
        assert.deepEqual(output, {});
    }
});

test('malformed, unrelated, and unsupported calls fail open', async () => {
    for (const input of [null, [], {}, { tool: 'Other', args: { command: 'git status' } },
        { tool: 'Bash', args: null }, { tool: 'Bash', args: { command: '' } },
        { tool: 'Bash', args: { command: 7 } }]) {
        const output = {};
        await handler()(input, output);
        assert.deepEqual(output, {});
    }
    const output = {};
    await createBeforeToolHandler(() => config, async () => true, 'win32')({ tool: 'Bash', args: { command: 'git status' } }, output);
    assert.deepEqual(output, {});
    await handler()({ tool: 'Bash', args: { command: 'git status' } }, null);
});

test('invalid binaries, missing settings, and lookup failures leave output unchanged', async () => {
    for (const create of [
        () => createBeforeToolHandler(() => ({ executablePath: '', shellPath: '/bin/bash' })),
        () => createBeforeToolHandler(() => ({ executablePath: 'tokenjuice', shellPath: '/bin/bash' })),
        () => createBeforeToolHandler(() => ({ executablePath: '/does-not-exist/tokenjuice', shellPath: '/bin/bash' })),
        () => createBeforeToolHandler(() => config, async () => false, 'linux'),
        () => createBeforeToolHandler(() => { throw new Error('settings unavailable'); }, async () => true, 'linux'),
        () => createBeforeToolHandler(() => config, async () => { throw new Error('access denied'); }, 'linux'),
    ]) {
        const output = { other: 'preserved' };
        await create()({ tool: 'Bash', args: { command: 'git status' } }, output);
        assert.deepEqual(output, { other: 'preserved' });
    }
});

test('uses the original arguments when no earlier plugin replaced them', async () => {
    const output = {};
    await handler()({ tool: 'Bash', args: { command: 'git status', timeout: 15 } }, output);
    assert.equal(output.args.timeout, 15);
    assert.match(output.args.command, /-lc 'git status'$/);
});

test('disposes its native hook subscription on unload', async () => {
    let registrations = 0;
    let disposed = false;
    const plugin = await activate({
        events: { on(event, callback) {
            assert.equal(event, 'tool.willExecute');
            assert.equal(typeof callback, 'function');
            registrations++;
            return { dispose() { disposed = true; } };
        } },
        settings: { get() { throw new Error('settings should be read when handling a call'); } },
    });
    assert.equal(registrations, 1);
    plugin.dispose();
    assert.equal(disposed, true);
});
