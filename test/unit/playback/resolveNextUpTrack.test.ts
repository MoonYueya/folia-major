import { describe, it, expect } from 'vitest';
import { resolveNextUpTrack } from '../../../src/components/app/overlays/now-playing-toast/resolveNextUpTrack';
import type { SongResult } from '../../../src/types';

// test/unit/playback/resolveNextUpTrack.test.ts
// now playing 卡片的「接下来播放」预览必须和 handleNextTrack 的下标规则一致：
// 预览错一首比不预览更难看，所以推不出来时一律 null。

const song = (id: string, name: string): SongResult => ({
    id,
    name,
    artists: [],
    album: {} as SongResult['album'],
    durationMs: 1000,
} as SongResult);

const queue = [song('a', 'Alpha'), song('b', 'Bravo'), song('c', 'Charlie')];

const resolve = (overrides: Partial<Parameters<typeof resolveNextUpTrack>[0]> = {}) =>
    resolveNextUpTrack({
        playQueue: queue,
        song: queue[1],
        loopMode: 'off',
        isFmMode: false,
        isStageActive: false,
        ...overrides,
    });

describe('resolveNextUpTrack', () => {
    it('returns the following track in the middle of the queue', () => {
        expect(resolve()?.name).toBe('Charlie');
    });

    it('returns null at the tail when loop is off', () => {
        expect(resolve({ song: queue[2] })).toBeNull();
    });

    it('wraps to the queue head at the tail when loopMode is all', () => {
        expect(resolve({ song: queue[2], loopMode: 'all' })?.name).toBe('Alpha');
    });

    it('returns null for loopMode one — the same track repeats, there is no next up', () => {
        expect(resolve({ loopMode: 'one' })).toBeNull();
    });

    it('returns null while the stage is active — it does not advance the main queue', () => {
        expect(resolve({ isStageActive: true })).toBeNull();
    });

    it('returns null without a base song or with an empty queue', () => {
        expect(resolve({ song: null })).toBeNull();
        expect(resolve({ playQueue: [] })).toBeNull();
    });

    // FM 只在队尾那一首上不确定：它的后继是刚拉回来的第一首，此刻还不存在。
    it('returns null on the last FM track', () => {
        expect(resolve({ song: queue[2], isFmMode: true })).toBeNull();
    });

    // 倒数第二首上 handleNextTrack 也会去拉新曲目，但拉完播的是 nextQueue[currentIndex + 1]，
    // 也就是旧队列的最后一首 —— 已经在手里了，所以这一首照常预览。
    it('previews the known successor on the penultimate FM track', () => {
        expect(resolve({ song: queue[1], isFmMode: true })?.name).toBe('Charlie');
    });

    // 队尾也不能落到 loopMode === 'all' 那条：FM 到底是拉新歌，不是回到队首。
    it('does not offer the FM queue head as the successor of the last track', () => {
        expect(resolve({ song: queue[2], isFmMode: true, loopMode: 'all' })).toBeNull();
    });

    it('still previews further from the FM tail', () => {
        expect(resolve({ song: queue[0], isFmMode: true })?.name).toBe('Bravo');
    });

    // 随机模式的「下一首」是这一轮排列里的那一首，不是队列顺序里的那一首（按队列顺序报出来的是另一首）。
    it('returns the shuffle order successor rather than the queue one', () => {
        // 队列顺序里 Bravo 的下一首是 Charlie，排列说下一首是 Alpha。
        expect(resolve({ song: queue[1] })?.name).toBe('Charlie');
        expect(resolve({ song: queue[1], loopMode: 'shuffle', shuffleRound: { order: [2, 1, 0], history: [] } })?.name).toBe('Alpha');
    });

    // 走到排列末尾要重洗，那一刻是谁还不知道：宁可 null 也不猜。
    it('returns null at the end of a shuffle round', () => {
        expect(resolve({ song: queue[1], loopMode: 'shuffle', shuffleRound: { order: [0, 2, 1], history: [] } })).toBeNull();
    });

    // 排列里没有这一首（这一轮洗完之后队列又添了歌），推不出下一首：不能退回队列顺序里猜一个。
    it('returns null when the current song is not in the shuffle order', () => {
        expect(resolve({ song: queue[2], loopMode: 'shuffle', shuffleRound: { order: [0, 1], history: [] } })).toBeNull();
    });

    it('only falls back to the queue head for an off-queue song when asked', () => {
        const outsider = song('zzz', 'Outsider');
        expect(resolve({ song: outsider })).toBeNull();
        expect(resolve({ song: outsider, fallbackToQueueHead: true })?.name).toBe('Alpha');
    });
});
