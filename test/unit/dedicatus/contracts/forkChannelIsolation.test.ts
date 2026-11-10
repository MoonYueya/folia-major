import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../../../../dev/dedicatus/ipcChannels.mjs';
import { scanMainChannels } from '../../../../dev/dedicatus/ipc/scanIpc.mjs';

// test/unit/dedicatus/contracts/forkChannelIsolation.test.ts
// fork 自己加的三条外部播放通道（系统声音采集的开与关、系统媒体键的接管）状态都绑在主窗口上，
// 合并 upstream/main 之前就是内联的 isTrustedMainWindowContents(event.sender) 校验，只认主窗口。
// 上游的 firstParty 认主窗口和遥控窗口，套上它就把这三条放开给了遥控窗口，所以这里钉住内联那种写法，
// 并顺手钉住登记表的 level：登记的级别和处理函数的实现是同一件事的两半。

const ROOT = path.resolve(__dirname, '../../../..');
const MAIN = path.join(ROOT, 'electron', 'main.cjs');
/** fork 加的通道，按注册的先后列。 */
const FORK_CHANNELS = ['external-spectrum-capture-arm', 'external-spectrum-capture-stopped', 'external-media-keys-set'];

const stripLineComments = (text: string) => text.replace(/^\s*\/\/[^\n]*\n/gm, '');

/** 通道注册处到处理函数签名为止的那截文本，用来确认它没有交给守卫工厂。 */
const registrationOf = (source: string, channel: string) => {
    const start = source.indexOf(`ipcMain.handle('${channel}'`);
    if (start === -1) throw new Error(`electron/main.cjs 里找不到 ${channel} 的注册`);
    const signature = source.indexOf('=>', start);
    if (signature === -1) throw new Error(`${channel} 的处理函数不是箭头函数`);
    return source.slice(start, signature);
};

/** 处理函数花括号里的原文：处理函数自己的语句，不含外面的注册处。 */
const handlerBodyOf = (source: string, channel: string) => {
    const signature = source.indexOf('=>', source.indexOf(`ipcMain.handle('${channel}'`));
    const open = source.indexOf('{', signature);
    if (signature === -1 || open === -1) throw new Error(`${channel} 的处理函数没有函数体`);
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        else if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, index);
        }
    }
    throw new Error(`${channel} 的处理函数花括号不配对`);
};

/** 去掉开头的空行与注释后的第一条语句。 */
const firstStatementOf = (body: string) => {
    let rest = body;
    for (;;) {
        rest = rest.replace(/^\s+/, '');
        if (!rest.startsWith('//')) return rest;
        rest = rest.slice(rest.indexOf('\n') + 1);
    }
};

describe('D605 the channels the fork added keep the main-window-only check', () => {
    const main = scanMainChannels(ROOT);
    const source = fs.readFileSync(MAIN, 'utf8');

    it('registers them as first-party', () => {
        for (const channel of FORK_CHANNELS) {
            expect(IPC_CHANNELS[channel]?.level, channel).toBe('first-party');
        }
    });

    it('does not hand them to a guard factory, so firstParty cannot widen them to the remote window', () => {
        const found = main
            .filter(entry => FORK_CHANNELS.includes(entry.channel))
            .sort((left, right) => FORK_CHANNELS.indexOf(left.channel) - FORK_CHANNELS.indexOf(right.channel));
        expect(found.map(entry => entry.channel)).toEqual(FORK_CHANNELS);
        for (const entry of found) {
            expect([entry.channel, entry.factory, entry.via ?? null], entry.channel).toEqual([entry.channel, null, null]);
            expect(entry.guarded, entry.channel).toBe(true);
            expect(registrationOf(source, entry.channel), entry.channel).not.toContain('firstParty(');
        }
    });

    it('checks event.sender with isTrustedMainWindowContents in the first statement of each handler', () => {
        for (const channel of FORK_CHANNELS) {
            const first = firstStatementOf(stripLineComments(handlerBodyOf(source, channel)));
            expect(first.slice(0, 200), channel).toMatch(
                /^if \(!isTrustedMainWindowContents\(event\.sender\)\) \{\s*throw new Error\(/,
            );
        }
    });
});
