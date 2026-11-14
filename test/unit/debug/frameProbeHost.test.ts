import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/debug/frameProbeHost.test.ts
// The main process half of the freeze probe: how late its own event loop ran, what the window did, and
// what the Spotify guard's calls cost. None of that is visible from the page, which is the point of
// measuring it here.

const require = createRequire(import.meta.url);
const { createFrameProbeHost, watchWindowEvents, LOOP_SAMPLE_MS, SLOW_MS } = require('../../../electron/debug/frameProbeHost.cjs');

/** A clock the test moves by hand, so every reading below is exact. */
const makeClock = (start = 1000) => {
    let at = start;
    return { now: () => at, advance: (ms: number) => { at += ms; } };
};

describe('the main process half of the freeze probe', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('records a sample of its own loop only when it ran late', () => {
        const clock = makeClock();
        const probe = createFrameProbeHost({ now: clock.now });
        probe.start();
        // The clock follows the timers: each sample runs one interval after the last, on time.
        clock.advance(LOOP_SAMPLE_MS);
        vi.advanceTimersByTime(LOOP_SAMPLE_MS);
        expect(probe.events(), 'the first sample has nothing to be late against').toHaveLength(0);

        clock.advance(LOOP_SAMPLE_MS);
        vi.advanceTimersByTime(LOOP_SAMPLE_MS);
        expect(probe.events(), 'a sample on time is not recorded').toHaveLength(0);

        // This one the loop could not answer on time: it was busy for 300 ms past the sample.
        clock.advance(LOOP_SAMPLE_MS + 300);
        vi.advanceTimersByTime(LOOP_SAMPLE_MS);
        const late = probe.events();
        expect(late).toHaveLength(1);
        expect(late[0].kind).toBe('loop-late');
        expect(late[0].detail.lateMs).toBe(300);
        probe.stop();
    });

    it('writes one line about a mark, covering what happened around it', () => {
        const clock = makeClock();
        const lines: unknown[][] = [];
        const probe = createFrameProbeHost({ now: clock.now, log: (tag: string, detail: unknown) => lines.push([tag, detail]) });
        probe.start();

        // Something the window did before the mark, and something slow after it.
        watchWindowEvents(probe, { on: (event: string, handler: () => void) => { if (event === 'blur') handler(); }, off: () => {} });
        clock.advance(500);
        probe.noteCall('spotify-evaluate', 120);
        clock.advance(500);
        probe.mark('seek-up', 'seek');
        clock.advance(1000);
        probe.noteCall('spotify-powershell', 90);

        expect(lines, 'nothing is written before the window has gone by').toHaveLength(0);
        clock.advance(2500);
        vi.advanceTimersByTime(3000);
        expect(lines).toHaveLength(1);
        const [tag, detail] = lines[0] as [string, { label: string; action: string; events: { atMs: number; kind: string }[] }];
        expect(tag).toBe('[FrameProbe:main]');
        expect(detail.label).toBe('seek-up');
        expect(detail.action).toBe('seek');
        // Each event is told as how far it was from the mark: negative before it, positive after.
        const kinds = detail.events.map(event => event.kind);
        expect(kinds).toContain('window-blur');
        expect(kinds).toContain('spotify-evaluate');
        expect(kinds).toContain('spotify-powershell');
        expect(kinds).toContain('mark');
        for (const event of detail.events) expect(typeof event.atMs).toBe('number');
        expect(detail.events.some(event => event.atMs < 0), 'what came before the mark').toBe(true);
        expect(detail.events.some(event => event.atMs > 0), 'and what came after it').toBe(true);
        probe.stop();
    });

    it('drops a call that was quick enough to have gone unnoticed', () => {
        const probe = createFrameProbeHost({ now: makeClock().now });
        probe.noteCall('spotify-evaluate', SLOW_MS - 1);
        expect(probe.events()).toHaveLength(0);
        probe.noteCall('spotify-evaluate', SLOW_MS + 1);
        expect(probe.events()).toHaveLength(1);
    });
});
