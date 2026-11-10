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

    // In shuffle the next song is the one the round's order puts next, not the next one in queue
    // order: judging by queue order arms a blend into an external song, or drops one it could have run.
    it('judges the next song of the shuffle round, not the next one in queue order', () => {
        const netease = (id: string): SongResult => ({ ...song(id), sourceRef: { kind: 'online', providerId: 'netease', mediaId: id } });
        const queue = [netease('a'), netease('b'), song('c')];
        // Queue order would have taken b (not external); the round takes c (external), so it blocks.
        expect(gate({ playQueue: queue, currentSong: queue[0], loopMode: 'shuffle', shuffleRound: { order: [0, 2, 1], history: [] } })).toBe(true);
        // Queue order would have taken c (external); the round takes a (not external), so it does not block.
        expect(gate({ playQueue: queue, currentSong: queue[1], loopMode: 'shuffle', shuffleRound: { order: [1, 0, 2], history: [] } })).toBe(false);
    });

    it('treats the end of a shuffle round as having no next song, and keeps queue order in Personal FM', () => {
        const netease = (id: string): SongResult => ({ ...song(id), sourceRef: { kind: 'online', providerId: 'netease', mediaId: id } });
        const queue = [netease('a'), netease('b'), song('c')];
        // Queue order would have taken c (external), but the round is at its end: the reshuffle decides, so there is no next song.
        expect(gate({ playQueue: queue, currentSong: queue[1], loopMode: 'shuffle', shuffleRound: { order: [0, 2, 1], history: [] } })).toBe(false);
        // Personal FM never follows the order.
        expect(gate({ playQueue: queue, currentSong: queue[1], loopMode: 'shuffle', isFmMode: true })).toBe(true);
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
