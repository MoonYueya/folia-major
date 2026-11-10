import { describe, expect, it } from 'vitest';
import type { SongResult } from '@/types';
import { externalBlocksAutomix } from '@/components/app/playback/externalPlaybackGate';

// test/unit/appleMusic/externalPlaybackGate.test.ts
// A blend needs two of the app's own decks; a song that sounds in a player outside the app blocks it,
// now, as the current song before its route switches, or as the next song.

const song = (id: string): SongResult => ({
    id,
    name: id,
    artists: [{ id: '', name: 'Artist' }],
    album: { id: '', name: 'Album' },
    durationMs: 200000,
    sourceRef: { kind: 'online', providerId: 'appleMusic', mediaId: id },
});
const external = (candidate: SongResult) => (
    candidate.sourceRef?.kind === 'online' && candidate.sourceRef.providerId === 'appleMusic'
);

const gate = (input: Partial<Parameters<typeof externalBlocksAutomix>[0]>) => externalBlocksAutomix({
    playbackRoute: 'web',
    playQueue: [],
    currentSong: null,
    loopMode: 'off',
    isFmMode: false,
    ...input,
}, external);

describe('externalBlocksAutomix', () => {
    it('blocks while the external route plays', () => {
        expect(gate({ playbackRoute: 'external' })).toBe(true);
    });

    it('blocks for the current song and the next one, and not for other providers', () => {
        const netease = (id: string): SongResult => ({ ...song(id), sourceRef: { kind: 'online', providerId: 'netease', mediaId: id } });
        expect(gate({ playQueue: [song('a'), netease('n')], currentSong: song('a') })).toBe(true);
        expect(gate({ playQueue: [netease('n'), song('a')], currentSong: netease('n') })).toBe(true);
        expect(gate({ playQueue: [song('a'), netease('n')], currentSong: netease('n') })).toBe(false);
    });

    // 随机模式下 handleNextTrack 走的是这一轮的排列，不是队列顺序：按队列顺序判断会去挡一首
    // 根本不会播的歌，或者放过一首真要接上的。
    it('follows the shuffle order instead of the queue order while shuffling', () => {
        const netease = (id: string): SongResult => ({ ...song(id), sourceRef: { kind: 'online', providerId: 'netease', mediaId: id } });
        const queue = [netease('n'), song('a'), netease('m')];
        // 队列顺序的下一首是 a（外部播放器）；这一轮排列说下一首是 m。
        expect(gate({ playQueue: queue, currentSong: queue[0] })).toBe(true);
        expect(gate({ playQueue: queue, currentSong: queue[0], loopMode: 'shuffle', shuffleRound: { order: [0, 2, 1], history: [] } })).toBe(false);
        expect(gate({ playQueue: queue, currentSong: queue[0], loopMode: 'shuffle', shuffleRound: { order: [0, 1, 2], history: [] } })).toBe(true);
    });

    // 走到排列末尾要重洗，那一刻是谁还不知道：不挡，和 resolveTransitionTarget 一样如实说没有。
    it('does not block at the end of a shuffle round', () => {
        const netease = (id: string): SongResult => ({ ...song(id), sourceRef: { kind: 'online', providerId: 'netease', mediaId: id } });
        const queue = [netease('n'), song('a')];
        expect(gate({ playQueue: queue, currentSong: queue[0], loopMode: 'shuffle', shuffleRound: { order: [1, 0], history: [] } })).toBe(false);
    });

    // 私人 FM 不随机：队列由电台续上，仍按队列顺序算。
    it('keeps the queue order in Personal FM', () => {
        const netease = (id: string): SongResult => ({ ...song(id), sourceRef: { kind: 'online', providerId: 'netease', mediaId: id } });
        const queue = [netease('n'), song('a'), netease('m')];
        expect(gate({ playQueue: queue, currentSong: queue[0], loopMode: 'shuffle', isFmMode: true, shuffleRound: { order: [0, 2, 1], history: [] } })).toBe(true);
    });

    it('wraps to the first song only with loop all, and never in Personal FM', () => {
        const queue = [song('a'), { ...song('n'), sourceRef: { kind: 'online' as const, providerId: 'netease', mediaId: 'n' } }];
        const currentSong = queue[1];
        expect(gate({ playQueue: queue, currentSong, loopMode: 'all' })).toBe(true);
        expect(gate({ playQueue: queue, currentSong, loopMode: 'off' })).toBe(false);
        expect(gate({ playQueue: queue, currentSong, loopMode: 'one' })).toBe(false);
        expect(gate({ playQueue: queue, currentSong, loopMode: 'all', isFmMode: true })).toBe(false);
    });
});
