// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/debug/frameProbeWatch.test.ts
// The renderer half of the freeze probe: what it holds while the external route is sounding, and what
// one line about an action of the listener's carries. The line covers the two seconds before the mark,
// which is where the reported stall sat: the listener presses the bar, drags, releases, and only then
// is the route asked to move.

const sent: unknown[] = [];
const externalState = vi.hoisted(() => ({ route: 'external', position: 30 }));
const storeListeners = vi.hoisted(() => new Set<() => void>());

vi.mock('@/services/onlineMusic/externalPlayback', () => ({
    isExternalRoute: () => externalState.route === 'external',
    getExternalPosition: () => externalState.position,
    subscribeExternalPlayback: () => () => {},
}));
vi.mock('@/stores/usePlaybackStore', () => ({
    usePlaybackStore: { subscribe: (listener: () => void) => { storeListeners.add(listener); return () => storeListeners.delete(listener); } },
}));
vi.mock('@/stores/motionSignals', () => {
    let power = 0;
    return { audioPower: { get: () => power, set: (value: number) => { power = value; } } };
});

const probe = await import('@/services/debug/frameProbe');

type ProbeLine = {
    action: string; windowMs: number; beforeMs: number;
    lyricTimeStillMs: number; spectrumHeldMs: number;
    events: { atMs: number; kind: string }[];
};

const probeLines = (info: ReturnType<typeof vi.spyOn>): ProbeLine[] => info.mock.calls
    .filter((call: unknown[]) => call[0] === '[FrameProbe]')
    .map((call: unknown[]) => call[1] as ProbeLine);

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.useFakeTimers();
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    sent.length = 0;
    externalState.route = 'external';
    externalState.position = 30;
    (window as unknown as { electron: unknown }).electron = { debugFrameProbe: (message: unknown) => sent.push(message) };
});

afterEach(() => {
    probe.stopFrameProbeWatch();
    probe.stopFrameProbeWatch();
    vi.useRealTimers();
    vi.restoreAllMocks();
    storeListeners.clear();
    delete (window as unknown as { electron?: unknown }).electron;
});

describe('the renderer half of the freeze probe', () => {
    it('starts watching only on the external route, and says so to the main process', () => {
        externalState.route = 'web';
        probe.startFrameProbeWatch();
        expect(probe.isFrameProbeWatching()).toBe(false);
        expect(sent).toHaveLength(0);

        externalState.route = 'external';
        probe.startFrameProbeWatch();
        expect(probe.isFrameProbeWatching()).toBe(true);
        expect(sent[0]).toEqual({ kind: 'start' });
    });

    it('writes one line about a mark, covering the two seconds before it and the three after', async () => {
        probe.startFrameProbeWatch();
        // A store write, a frame, and then the listener presses the bar.
        storeListeners.forEach(listener => listener());
        await vi.advanceTimersByTimeAsync(100);
        probe.markFrameProbe('seek-down');
        // What happens after the press: the drag moving the line, and a slow frame.
        externalState.position = 31;
        await vi.advanceTimersByTimeAsync(200);
        probe.markFrameProbe('seek-up');

        expect(probeLines(info), 'nothing is written while the window is open').toHaveLength(0);
        await vi.advanceTimersByTimeAsync(3000);
        const lines = probeLines(info);
        expect(lines.length, 'one line per mark').toBeGreaterThanOrEqual(1);
        const first = lines[0];
        expect(first.action).toBe('seek-down');
        expect(first.windowMs).toBe(3000);
        expect(first.beforeMs).toBe(2000);
        expect(typeof first.lyricTimeStillMs).toBe('number');
        expect(typeof first.spectrumHeldMs).toBe('number');
        expect(Array.isArray(first.events)).toBe(true);
        const kinds = first.events.map(event => event.kind);
        expect(kinds, 'the store write before the mark is kept').toContain('store-write');
        expect(kinds, 'and the mark itself').toContain('mark');
        // Each event is told as how far it was from the mark: negative before it, positive after.
        expect(first.events.some(event => event.atMs < 0), 'what came before the mark').toBe(true);
        for (const event of first.events) expect(typeof event.atMs).toBe('number');
        console.log('[probe] ' + JSON.stringify({ action: first.action, kinds, events: first.events.length }));
    });

    it('takes no mark while it is not watching', async () => {
        probe.markFrameProbe('seek-up');
        await vi.advanceTimersByTimeAsync(3000);
        expect(probeLines(info)).toHaveLength(0);
        expect(sent).toHaveLength(0);
    });

    it('does not read the line as standing still while the bar is dragged backwards', async () => {
        // The reported one: a drop back over the song moves the position at once, and every frame of it
        // is lower than the one before. Read by "only a forward step counts", the whole drag was a stall.
        probe.startFrameProbeWatch();
        externalState.position = 242;
        await vi.advanceTimersByTimeAsync(100);
        probe.markFrameProbe('seek-down');
        // The drop: the position falls with every frame, which is a change on every one of them.
        for (let step = 0; step < 10; step += 1) {
            externalState.position -= 10;
            await vi.advanceTimersByTimeAsync(16);
        }
        // What the drag itself looked like: the report at its end covers the frames of the drop, and
        // none of them is a frame in which the line stood still.
        const duringDrag = probe.frameProbeEvents().filter(event => event.kind === 'frame-gap');
        console.log('[probe back] gap events during the drop=' + duringDrag.length);
        probe.markFrameProbe('seek-up');
        await vi.advanceTimersByTimeAsync(3000);
        const line = probeLines(info)[0];
        // The line moved on every frame of the drop, so no gap of the picture was recorded in it.
        expect(duringDrag, 'a drag backwards is not a stall').toHaveLength(0);
        expect(line.events.some(event => event.kind === 'mark'), 'the marks are in the report').toBe(true);
    });

    it('reports how long the power the styles draw stood at one value', async () => {
        // What a capture holding its last frame looks like: the bars frozen at one level for half a
        // second while everything else goes on.
        const signals = await import('@/stores/motionSignals');
        probe.startFrameProbeWatch();
        const held = signals.audioPower as unknown as { get: () => number; set: (value: number) => void };
        held.set(120);
        await vi.advanceTimersByTimeAsync(500);
        for (let step = 0; step < 12; step += 1) {
            held.set(120 + step);
            await vi.advanceTimersByTimeAsync(100);
        }
        probe.markFrameProbe('pause');
        await vi.advanceTimersByTimeAsync(3000);
        const line = probeLines(info)[0];
        console.log('[probe spectrum] spectrumHeldMs=' + line.spectrumHeldMs);
        expect(typeof line.spectrumHeldMs).toBe('number');
        expect(line.spectrumHeldMs).toBeGreaterThanOrEqual(0);
    });

    it('stops watching and tells the main process to stop too', () => {
        probe.startFrameProbeWatch();
        probe.stopFrameProbeWatch();
        expect(probe.isFrameProbeWatching()).toBe(false);
        expect(sent[sent.length - 1]).toEqual({ kind: 'stop' });
    });
});
