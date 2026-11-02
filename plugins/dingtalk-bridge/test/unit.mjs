/**
 * 纯函数单测：不碰网络，只验证纯逻辑。
 * 跑法：node test/unit.mjs
 */
import { DingTalkClient } from '../lib/dingtalk-client.ts';
import { DingTalkBridge } from '../lib/bridge.ts';

let pass = 0;
let fail = 0;

function eq(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
    if (!ok) {
        console.log(`     期望: ${JSON.stringify(expected)}`);
        console.log(`     实际: ${JSON.stringify(actual)}`);
        fail++;
    } else {
        pass++;
    }
}

function ok(name, cond) {
    console.log(`  ${cond ? '✅' : '❌'} ${name}`);
    cond ? pass++ : fail++;
}

/* ---------------- 分段 ---------------- */
console.log('\n[分段 chunk]');
eq('短文本不切', DingTalkClient.chunk('hello'), ['hello']);
eq('空文本返回空数组', DingTalkClient.chunk(''), []);

{
    const long = 'A'.repeat(9000);
    const parts = DingTalkClient.chunk(long);
    ok('超长文本被切分', parts.length > 1);
    ok('切分后每段不超限', parts.every((p) => p.length <= 4000));
    ok('切分不丢字符', parts.join('').length === 9000);
}

{
    /* 优先在换行处切 */
    const text = 'x'.repeat(3900) + '\n' + 'y'.repeat(1000);
    const parts = DingTalkClient.chunk(text);
    ok('优先按换行切分', parts[0].length === 3900);
    ok('换行被吃掉', !parts[1].startsWith('\n'));
}

/* ---------------- 流式截取 ---------------- */
console.log('\n[流式截取 takeFlushable]');

eq('无边界且过短时先攒着', DingTalkBridge.takeFlushable('short', 0), '');

{
    const text = '这是一句完整的话。后面还没写完';
    const piece = DingTalkBridge.takeFlushable(text, 0);
    ok('在句号处切断', piece.endsWith('。'));
    ok('切断内容非空', piece.length > 0);
}

{
    const text = 'line one\nline two\nline three with more content here';
    const piece = DingTalkBridge.takeFlushable(text, 0);
    ok('在换行处切断', piece.includes('\n'));
}

{
    /* 没有任何标点且超过 200 字符 -> 强切 */
    const text = 'a'.repeat(250);
    const piece = DingTalkBridge.takeFlushable(text, 0);
    ok('无标点超长强制切', piece.length === 250);
}

{
    const text = '已经发送的部分。新的内容在这里还没有结束';
    const piece = DingTalkBridge.takeFlushable(text, 9);
    ok('跳过已发送前缀', !piece.startsWith('已经发送'));
}

/* ---------------- 汇总 ---------------- */
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
