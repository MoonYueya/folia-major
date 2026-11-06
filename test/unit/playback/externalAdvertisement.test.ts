// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import type { ProviderExternalPlaybackStatus } from '@/types/onlineMusic';

// test/unit/playback/externalAdvertisement.test.ts — an advertisement of the player itself, and the
// player answering through its fallback channel: what the app is told, once, and that the song it
// shows is not moved on by either (so no lyric read is started for a song that is not playing).

const omniMock = vi.hoisted(() => ({
    canPlayExternally: vi.fn(() => true),
    canPlaySong: vi.fn(() => true),
    prepareExternalPlaybackQueue: vi.fn(async () => {}),
    playSongExternally: vi.fn(async () => {}),
    pauseExternalPlayback: vi.fn(async () => {}),
    resumeExternalPlayback: vi.fn(async () => {}),
    seekExternalPlayback: vi.fn(async () => {}),
    setExternalPlaybackVolume: vi.fn(async () => {}),
    getExternalPlaybackStatus: vi.fn(async (): Promise<ProviderExternalPlaybackStatus> => ({
        mediaId: '123', isPlaying: true, positionMs: 10000, durationMs: 200000, ended: false,
    })),
    isExternalPlaybackStatusForSong: vi.fn(() => true),
}));

vi.mock('@/services/onlineMusic/omni', () => ({ omni: omniMock }));

const engine = await import('@/services/onlineMusic/externalPlayback');
const { usePlaybackStore } = await import('@/stores/usePlaybackStore');
const { PlayerState } = await import('@/types');

const song: SongResult = {
    id: '123',
    name: 'Example',
    artists: [{ id: '', name: 'Artist' }],
    album: { id: '', name: 'Album' },
    durationMs: 200000,
    sourceRef: { kind: 'online', providerId: 'appleMusic', mediaId: '123', providerData: { resourceType: 'songs' } },
};

const status = (overrides: Partial<ProviderExternalPlaybackStatus> = {}): ProviderExternalPlaybackStatus => ({
    mediaId: '123', isPlaying: true, positionMs: 10000, durationMs: 200000, ended: false, ...overrides,
});

const advertisement = (): ProviderExternalPlaybackStatus => status({
    isPlaying: false, positionMs: 0, durationMs: 30000, starting: true, advertisement: true,
});

describe('an advertisement of the external player', () => {
    let events: string[] = [];
    let unsubscribe = () => {};

    beforeEach(async () => {
        vi.useFakeTimers();
        engine.installExternalPlayback();
        engine.stopExternalPlayback('test reset');
        usePlaybackStore.setState({ playbackRoute: 'web', audioSrc: null, playerState: PlayerState.IDLE, duration: 0, currentSong: null });
        omniMock.playSongExternally.mockReset().mockResolvedValue(undefined);
        omniMock.getExternalPlaybackStatus.mockReset().mockResolvedValue(status());
        events = [];
        unsubscribe = engine.subscribeExternalPlayback(event => {
            if (event.type === 'advertisement') events.push(`advertisement:${event.active}`);
            if (event.type === 'degraded') events.push(`degraded:${event.active}`);
            if (event.type === 'ended') events.push('ended');
        });
    });

    afterEach(() => {
        unsubscribe();
        engine.stopExternalPlayback('test end');
        usePlaybackStore.setState({ playbackRoute: 'web', audioSrc: null, playerState: PlayerState.IDLE });
        vi.useRealTimers();
    });

    it('is told once when it starts and once when it is over', async () => {
        await engine.beginExternalPlayback(song);
        engine.announceExternalPlayback();
        expect(engine.isExternalAdvertisement()).toBe(false);

        omniMock.getExternalPlaybackStatus.mockResolvedValue(advertisement());
        await vi.advanceTimersByTimeAsync(600);
        expect(engine.isExternalAdvertisement()).toBe(true);
        expect(engine.isExternalPlaying()).toBe(false);

        omniMock.getExternalPlaybackStatus.mockResolvedValue(status({ positionMs: 40000 }));
        await vi.advanceTimersByTimeAsync(600);
        expect(engine.isExternalAdvertisement()).toBe(false);
        expect(events.filter(event => event.startsWith('advertisement:'))).toEqual(['advertisement:true', 'advertisement:false']);
    });

    it('does not end the song Folia shows, so no lyric read is started for another one', async () => {
        await engine.beginExternalPlayback(song);
        engine.announceExternalPlayback();
        omniMock.getExternalPlaybackStatus.mockResolvedValue(advertisement());
        await vi.advanceTimersByTimeAsync(1200);

        expect(events).not.toContain('ended');
        expect(engine.getExternalSong()).toBe(song);
        // The advertised minute is the player's, so the song's clock stands where it was.
        const held = engine.getExternalPosition();
        await vi.advanceTimersByTimeAsync(2000);
        expect(engine.getExternalPosition()).toBe(held);
    });

    it('tells the fallback once in a run of Folia, not once an episode (L8)', async () => {
        await engine.beginExternalPlayback(song);
        engine.announceExternalPlayback();

        omniMock.getExternalPlaybackStatus.mockResolvedValue(status({ mediaId: '', isPlaying: true, degraded: true }));
        await vi.advanceTimersByTimeAsync(1200);
        expect(events.filter(event => event.startsWith('degraded:'))).toEqual(['degraded:true']);

        // The player comes back to its precise channel and falls back again: the listener was told
        // once already, and is not told again in this run.
        omniMock.getExternalPlaybackStatus.mockResolvedValue(status({ positionMs: 20000 }));
        await vi.advanceTimersByTimeAsync(600);
        omniMock.getExternalPlaybackStatus.mockResolvedValue(status({ mediaId: '', degraded: true }));
        await vi.advanceTimersByTimeAsync(600);
        expect(events.filter(event => event.startsWith('degraded:'))).toEqual(['degraded:true']);
    });
});
