const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { test } = require('node:test');

const reply = 'Use for await...of.';
const messages = [
    { id: 'one', threadId: 'current', role: 'user', content: 'Explain async iteration.' },
    { id: 'two', threadId: 'current', role: 'assistant', content: { parts: [
        { type: 'text', text: reply }, { type: 'reasoning', text: 'PRIVATE REASONING' },
    ] } },
    { id: 'three', threadId: 'other', role: 'user', content: 'PRIVATE OTHER THREAD' },
];

async function fixture(t, enabled = true) {
    const { activate } = require('../main.js');
    const f = {
        active: { id: 'current' }, commands: new Map(), hooks: new Map(), settings: new Map(),
        bodies: [], previews: [], inputs: [], notices: [], confirm: true,
    };
    const server = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        f.bodies.push(JSON.parse(body));
        await f.onRequest?.();
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: 'Show a short example.' } }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    f.settings.set('draftAssistant.enabled', enabled);
    f.settings.set('draftAssistant.endpoint', `http://127.0.0.1:${server.address().port}/v1/chat/completions`);
    f.settings.set('draftAssistant.model', 'test-model');
    const register = (map) => (id, handler) => {
        map.set(id, handler);
        return { dispose: () => map.delete(id) };
    };
    const activation = await activate({
        id: 'draft-assistant',
        commands: { register: register(f.commands) },
        events: { on: register(f.hooks) },
        settings: { get: (key, fallback) => f.settings.get(key) ?? fallback, onDidChange: () => ({ dispose() {} }) },
        chat: { getActiveThread: async () => f.active, getMessages: async () => messages },
        ui: {
            showInputBox: async (options) => { f.inputs.push(options); return options.value ?? 'need an example plz'; },
            showConfirmDialog: async (text) => { f.previews.push(text); await f.onPreview?.(); return f.confirm; },
            showNotification: (message, options) => {
                f.notices.push({ message, options });
                f.onNotice?.(message);
            },
        },
    });
    t.after(() => activation.dispose());
    return f;
}

function receive(f, threadId = 'current') {
    return f.hooks.get('chat.message.didReceive')({ threadId, response: { content: reply } });
}

test('prediction previews one suggestion using only the active thread text', async (t) => {
    const f = await fixture(t);
    await f.commands.get('predict')();
    const payload = JSON.stringify(f.bodies);
    assert.equal(f.bodies.length, 1);
    assert.match(payload, /Explain async iteration/);
    assert.match(payload, /Use for await/);
    assert.doesNotMatch(payload, /PRIVATE/);
    assert.match(f.previews[0], /Show a short example/);
    assert.equal(f.inputs.at(-1).value, 'Show a short example.');
});

test('rewrite previews the handwritten draft with no chat history and honors cancellation', async (t) => {
    const f = await fixture(t);
    f.confirm = false;
    await f.commands.get('rewrite')();
    const payload = JSON.stringify(f.bodies);
    assert.equal(f.bodies.length, 1);
    assert.match(payload, /need an example plz/);
    assert.doesNotMatch(payload, /async iteration|PRIVATE/);
    assert.match(f.previews[0], /need an example plz/);
    assert.match(f.previews[0], /Show a short example/);
    assert.equal(f.inputs.length, 1);
});

test('an accepted prediction can seed the rewrite dialog', async (t) => {
    const f = await fixture(t);
    await f.commands.get('predict')();
    await f.commands.get('rewrite')();
    assert.equal(f.inputs[1].value, 'Show a short example.');
    assert.match(JSON.stringify(f.bodies[1]), /Show a short example/);
    assert.doesNotMatch(JSON.stringify(f.bodies[1]), /async iteration/);
});

test('configured endpoint stays unused until transmission is explicitly enabled', async (t) => {
    const f = await fixture(t, false);
    f.settings.set('draftAssistant.autoPredict', true);
    await receive(f);
    await f.commands.get('predict')();
    await f.commands.get('rewrite')();
    assert.equal(f.bodies.length, 0);
    assert.equal(f.previews.length, 0);
    assert.equal(f.inputs.length, 0);
});

test('automatic prediction is optional and ignores replies in background threads', { timeout: 3000 }, async (t) => {
    const f = await fixture(t);
    await receive(f);
    f.settings.set('draftAssistant.autoPredict', true);
    await receive(f, 'other');
    assert.equal(f.bodies.length, 0);
    const ready = new Promise((resolve) => { f.onNotice = resolve; });
    assert.equal(receive(f), undefined, 'reply hook must not wait for inference');
    assert.match(await ready, /suggestion is ready/);
    assert.equal(f.bodies.length, 1);
    assert.equal(f.previews.length, 0);
    await f.commands.get('predict')();
    assert.equal(f.bodies.length, 1);
    assert.match(f.previews[0], /Show a short example/);
});

test('a result arriving after switching threads is discarded', async (t) => {
    const f = await fixture(t);
    f.onRequest = () => { f.active = { id: 'other' }; };
    await f.commands.get('predict')();
    assert.equal(f.bodies.length, 1);
    assert.equal(f.previews.length, 0);
    assert.equal(f.inputs.length, 0);
});

test('a thread switch during preview prevents the draft handoff', async (t) => {
    const f = await fixture(t);
    f.onPreview = () => { f.hooks.get('thread.activated')({ threadId: 'other' }); };
    await f.commands.get('predict')();
    assert.equal(f.previews.length, 1);
    assert.equal(f.inputs.length, 0);
});

test('sending invalidates pending predictions and does not transform the message', async (t) => {
    const f = await fixture(t);
    const output = {};
    f.onRequest = () => f.hooks.get('chat.message.willSend')({ threadId: 'current', content: 'New turn' }, output);
    await f.commands.get('predict')();
    assert.equal(f.bodies.length, 1);
    assert.equal(f.previews.length, 0);
    assert.deepEqual(output, {});
});
