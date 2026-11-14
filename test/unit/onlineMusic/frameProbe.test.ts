// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import type { ExternalPlaybackTraits, ExternalTrackRepeatAnswer, ProviderExternalPlaybackStatus } from '@/types/onlineMusic';

// test/unit/onlineMusic/frameProbe.test.ts
// What the frame probe writes after one action of the listener's on the external route, and the one
// thing it must not do: open a window on a way of playing it knows nothing about. The log line is the
// only thing a listener's machine can hand back, so every field it carries is pinned here.

const omniMock = vi.hoisted(() => ({
    canPlayExternally: vi.fn(() => true),
    canPlaySong: vi.fn(() => true),
    prepareExternalPlaybackQueue: vi.fn(async () => {}),
    playSongExternally: vi.fn(async () => {}),
    pauseExternalPlayback: vi.fn(async () => {}),
    resumeExternalPlayback: vi.fn(async () => {}),
    seekExternalPlayback: vi.fn(async () => {}),
    setExternalPlaybackVolume: vi.fn(async () => {}),
    setExternalTrackRepeat: vi.fn(async (): Promise<ExternalTrackRepeatAnswer | null | undefined> => undefined),
    getExternalPlaybackStatus: vi.fn(async (): Promise<ProviderExternalPlaybackStatus> => ({
        mediaId: '123', isPlaying: true, positionMs: 5000, durationMs: 200000, ended: false,
    })),
    isExternalPlaybackStatusForSong: vi.fn(() => true),
    adoptExternalPlayback: vi.fn(() => {}),
    externalPlaybackTraits: vi.fn((): ExternalPlaybackTraits => ({
        capturesSystemAudio: true, startsWithoutWaiting: true, backsOffStatusPolls: true, holdsMediaKeysWhilePlaying: true,
        seekLimitMs: 8000, loopsTrackNatively: true, followsPlayerChanges: true,
    })),
}));

vi.mock('@/services/onlineMusic/omni', () => ({ omni: omniMock }));

const engine = await import('@/services/onlineMusic/externalPlayback');
const { FRAME_PROBE_WINDOW_MS } = await import('@/services/debug/frameProbe');
const { usePlaybackStore } = await import('@/stores/usePlaybackStore');
const { PlayerState } = await import('@/types');

const song: SongResult = {
    id: '123', name: 'Example', artists: [{ id: '', name: 'Artist' }], album: { id: '', name: 'Album' }, durationMs: 200000,
    sourceRef: { kind: 'online', providerId: 'appleMusic', mediaId: '123', providerData: { resourceType: 'songs' } },
};

const status = (overrides: Partial<ProviderExternalPlaybackStatus> = {}): ProviderExternalPlaybackStatus => ({
    mediaId: '123', isPlaying: true, positionMs: 5000, durationMs: 200000, ended: false, ...overrides,
});

/** One line the probe wrote, as the log holds it. */
type ProbeLine = {
    action: string; windowMs: number; gaps: unknown[]; longTasks: unknown[];
    storeWrites: number; emits: number; lyricTimeStillMs: number; spectrumHeldMs: number;
};

/** The lines the probe wrote, as the log holds them. */
const probeLines = (): ProbeLine[] => infoSpy.mock.calls
    .filter((call: unknown[]) => call[0] === '[FrameProbe]')
    .map((call: unknown[]) => call[1] as ProbeLine);

let infoSpy: ReturnType<typeof vi.spyOn>;

describe('the frame probe', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        engine.installExternalPlayback();
        engine.stopExternalPlayback('test reset');
        usePlaybackStore.setState({
            playbackRoute: 'web', audioSrc: null, playerState: PlayerState.IDLE, duration: 0, currentSong: null,
            playQueue: [song], isFmMode: false,
        });
        omniMock.getExternalPlaybackStatus.mockReset().mockResolvedValue(status());
        omniMock.seekExternalPlayback.mockReset().mockResolvedValue(undefined);
        omniMock.pauseExternalPlayback.mockReset().mockResolvedValue(undefined);
        omniMock.resumeExternalPlayback.mockReset().mockResolvedValue(undefined);
        omniMock.externalPlaybackTraits.mockReset().mockReturnValue({
            capturesSystemAudio: true, startsWithoutWaiting: true, backsOffStatusPolls: true, holdsMediaKeysWhilePlaying: true,
            seekLimitMs: 8000, loopsTrackNatively: true, followsPlayerChanges: true,
        });
    });

    afterEach(() => {
        engine.stopExternalPlayback('test end');
        usePlaybackStore.setState({ playbackRoute: 'web', audioSrc: null, playerState: PlayerState.IDLE, playQueue: [] });
        infoSpy.mockRestore();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const startFrom = async (positionMs: number) => {
        omniMock.getExternalPlaybackStatus.mockResolvedValue(status({ positionMs, isPlaying: true }));
        const start = engine.startExternalPlayback(song, 0);
        engine.announceExternalPlayback();
        await start.seeded;
        await vi.advanceTimersByTimeAsync(500);
    };

    it('writes one line about a drop, with everything the window measured', async () => {
        await startFrom(30000);
        const askedAt = performance.now();
        omniMock.getExternalPlaybackStatus.mockImplementation(async () => status({
            positionMs: Math.round(30000 + (performance.now() - askedAt)), isPlaying: true,
        }));
        infoSpy.mockClear();
        expect(engine.seekExternalPlayback(60)).toBe(true);
        // Nothing is written while the window is open: the line is the whole of what it says.
        await vi.advanceTimersByTimeAsync(FRAME_PROBE_WINDOW_MS - 1);
        expect(probeLines()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        const lines = probeLines();
        expect(lines, 'one line per window').toHaveLength(1);
        const line = lines[0];
        expect(line.action).toBe('seek');
        expect(line.windowMs).toBe(FRAME_PROBE_WINDOW_MS);
        expect(Array.isArray(line.gaps)).toBe(true);
        expect(Array.isArray(line.longTasks)).toBe(true);
        expect(typeof line.storeWrites).toBe('number');
        expect(typeof line.emits).toBe('number');
        expect(typeof line.lyricTimeStillMs).toBe('number');
        expect(typeof line.spectrumHeldMs).toBe('number');
        console.log('[probe] ' + JSON.stringify(line));
    });

    it('does not read a drop of the bar backwards as the line standing still', async () => {
        // A listener drags the bar back over the song, which the clock follows at once: the position of
        // every frame after it is lower than the one before, and none of them is a frame in which the
        // line stood still. Read by "only a forward step counts", the whole drag was a stall.
        await startFrom(242000);
        const askedAt = performance.now();
        omniMock.getExternalPlaybackStatus.mockImplementation(async () => status({
            positionMs: Math.round(106600 + (performance.now() - askedAt) * 0.88), isPlaying: true,
        }));
        infoSpy.mockClear();
        expect(engine.seekExternalPlayback(106.6)).toBe(true);
        await vi.advanceTimersByTimeAsync(FRAME_PROBE_WINDOW_MS);
        const line = probeLines()[0];
        console.log('[probe back] ' + JSON.stringify({ lyricTimeStillMs: line.lyricTimeStillMs }));
        expect(line.lyricTimeStillMs, 'a drag backwards is not a stall').toBeLessThan(100);
    });

    it('reports how long the power the styles draw stood at one value', async () => {
        // The bars frozen where they were: exactly what a capture holding its last frame looks like,
        // and what nothing else in the window does.
        const { audioPower } = await import('@/stores/motionSignals');
        await startFrom(30000);
        // A window left open by the test before this one writes its own line first: it is settled here.
        await vi.advanceTimersByTimeAsync(FRAME_PROBE_WINDOW_MS);
        infoSpy.mockClear();
        expect(engine.seekExternalPlayback(60)).toBe(true);
        // Half a second in which the power the styles draw stays at one value - a capture holding its
        // last frame - and then changes on every frame, which is the picture moving again.
        audioPower.set(200);
        await vi.advanceTimersByTimeAsync(500);
        for (let frame = 0; frame < 20; frame += 1) {
            audioPower.set(200 - frame);
            await vi.advanceTimersByTimeAsync(100);
        }
        await vi.advanceTimersByTimeAsync(FRAME_PROBE_WINDOW_MS);
        const line = probeLines()[0];
        console.log('[probe spectrum] ' + JSON.stringify({ spectrumHeldMs: line.spectrumHeldMs }));
        expect(line.spectrumHeldMs, 'about the half second it stood still').toBeGreaterThanOrEqual(400);
        expect(line.spectrumHeldMs, 'and no longer than that').toBeLessThan(700);
    });

    it('writes one about a press of play after a pause, and one about the pause', async () => {
        await startFrom(30000);
        omniMock.getExternalPlaybackStatus.mockResolvedValue(status({ positionMs: 30000, isPlaying: false }));
        await vi.advanceTimersByTimeAsync(500);
        infoSpy.mockClear();
        expect(engine.pauseExternalPlayback()).toBe(true);
        await vi.advanceTimersByTimeAsync(FRAME_PROBE_WINDOW_MS);
        expect(probeLines().map((line: ProbeLine) => line.action)).toEqual(['pause']);

        infoSpy.mockClear();
        omniMock.getExternalPlaybackStatus.mockResolvedValue(status({ positionMs: 30000, isPlaying: true }));
        expect(engine.resumeExternalPlayback()).toBe(true);
        await vi.advanceTimersByTimeAsync(FRAME_PROBE_WINDOW_MS);
        expect(probeLines().map((line: ProbeLine) => line.action)).toEqual(['play']);
    });

    it('writes nothing on a way of playing that is not the external route', async () => {
        // A web song: the same styles, drawn from a deck this probe knows nothing about.
        usePlaybackStore.setState({ playbackRoute: 'web', playerState: PlayerState.PLAYING });
        infoSpy.mockClear();
        expect(engine.seekExternalPlayback(60)).toBe(false);
        expect(engine.pauseExternalPlayback()).toBe(false);
        expect(engine.resumeExternalPlayback()).toBe(false);
        await vi.advanceTimersByTimeAsync(FRAME_PROBE_WINDOW_MS * 2);
        expect(probeLines(), 'no window on another route').toHaveLength(0);
    });
});
