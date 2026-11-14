import { getExternalPosition, isExternalRoute, subscribeExternalPlayback } from '../onlineMusic/externalPlayback';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { audioPower } from '../../stores/motionSignals';

// src/services/debug/frameProbe.ts
// What the lyric styles are drawing from when a listener says their animation stops: the frames the
// window actually got, the long tasks behind them, how often the playback store and the external route
// were written in the same stretch, and how long the position they animate on stood still. It answers
// the two moments reported - a drop of the bar, and a press of play or pause - and nothing else, and
// only while the external route is the one sounding.

/** How long one window measures: the stall a listener reports is far shorter than this. */
export const FRAME_PROBE_WINDOW_MS = 3000;
/** A frame this far behind the one before it is one the eye sees the picture stop on. */
export const FRAME_PROBE_GAP_MS = 40;

/** The actions a window is opened for: the two the listener reported, and a press of pause beside them. */
export type FrameProbeAction = 'seek' | 'play' | 'pause';

type FrameGap = { atMs: number; gapMs: number };
type LongTask = { atMs: number; ms: number };

type Probe = {
    action: FrameProbeAction;
    startedAtMs: number;
    previousFrameMs: number;
    gaps: FrameGap[];
    longTasks: LongTask[];
    storeWrites: number;
    emits: number;
    lastPositionSec: number;
    stillSinceMs: number;
    lyricTimeStillMs: number;
    /** The power the styles last drew from, and how long it has stood at that very value. */
    lastPower: number;
    heldSinceMs: number;
    spectrumHeldMs: number;
    frameHandle: number;
    timer: ReturnType<typeof setTimeout> | null;
    unsubscribeStore: (() => void) | null;
    unsubscribeEmits: (() => void) | null;
    observer: PerformanceObserver | null;
};

let probe: Probe | null = null;

/** Writes what the window measured and lets go of everything it was listening to. */
const finish = (windows: Probe) => {
    if (windows.frameHandle) cancelAnimationFrame(windows.frameHandle);
    if (windows.timer !== null) clearTimeout(windows.timer);
    windows.unsubscribeStore?.();
    windows.unsubscribeEmits?.();
    windows.observer?.disconnect();
    if (probe === windows) probe = null;
    console.info('[FrameProbe]', {
        action: windows.action,
        windowMs: FRAME_PROBE_WINDOW_MS,
        gaps: windows.gaps,
        longTasks: windows.longTasks,
        storeWrites: windows.storeWrites,
        emits: windows.emits,
        lyricTimeStillMs: windows.lyricTimeStillMs,
        spectrumHeldMs: windows.spectrumHeldMs,
    });
};

const frame = (windows: Probe) => {
    const nowMs = performance.now();
    if (windows.previousFrameMs > 0) {
        const gapMs = nowMs - windows.previousFrameMs;
        if (gapMs > FRAME_PROBE_GAP_MS) {
            windows.gaps.push({ atMs: Math.round(nowMs - windows.startedAtMs), gapMs: Math.round(gapMs) });
        }
    }
    windows.previousFrameMs = nowMs;
    // The position the styles animate on: a frame in which it did not move is the picture standing
    // still, whichever clock the frame loop of the moment reads.
    const positionSec = getExternalPosition();
    // Any change counts, a drop back as much as a step forward: a listener who drags the bar backwards
    // moved the line, and reading that as the line standing still reported a stall that never happened.
    if (positionSec !== windows.lastPositionSec) {
        windows.lastPositionSec = positionSec;
        windows.stillSinceMs = nowMs;
    }
    windows.lyricTimeStillMs = Math.round(nowMs - windows.stillSinceMs);
    // The power the styles draw their bars and their beat from: a frame that leaves it at the very
    // value of the frame before is a picture standing still, which is what a frozen capture looks like.
    const power = audioPower.get();
    if (power !== windows.lastPower) {
        windows.lastPower = power;
        windows.heldSinceMs = nowMs;
    }
    windows.spectrumHeldMs = Math.round(nowMs - windows.heldSinceMs);
    windows.frameHandle = requestAnimationFrame(() => frame(windows));
};

const watchLongTasks = (windows: Probe): PerformanceObserver | null => {
    if (typeof PerformanceObserver === 'undefined') return null;
    if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) return null;
    const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
            windows.longTasks.push({ atMs: Math.round(entry.startTime - windows.startedAtMs), ms: Math.round(entry.duration) });
        }
    });
    observer.observe({ entryTypes: ['longtask'] });
    return observer;
};

/**
 * Measures the next few seconds after one action of the listener's. A window is only opened while the
 * external route is the one sounding: every other way of playing draws the same styles from clocks this
 * probe knows nothing about, and opening one there would report a stall that is not about this route.
 */
export const startFrameProbe = (action: FrameProbeAction): void => {
    if (typeof window === 'undefined' || !isExternalRoute()) return;
    if (probe !== null) finish(probe);
    const nowMs = performance.now();
    const windows: Probe = {
        action,
        startedAtMs: nowMs,
        previousFrameMs: 0,
        gaps: [],
        longTasks: [],
        storeWrites: 0,
        emits: 0,
        lastPositionSec: getExternalPosition(),
        stillSinceMs: nowMs,
        lyricTimeStillMs: 0,
        lastPower: audioPower.get(),
        heldSinceMs: nowMs,
        spectrumHeldMs: 0,
        frameHandle: 0,
        timer: null,
        unsubscribeStore: null,
        unsubscribeEmits: null,
        observer: null,
    };
    windows.observer = watchLongTasks(windows);
    // Every write to the playback store in the window, which is what a style rebuilds on.
    windows.unsubscribeStore = usePlaybackStore.subscribe(() => { windows.storeWrites += 1; });
    windows.unsubscribeEmits = subscribeExternalPlayback(() => { windows.emits += 1; });
    windows.timer = setTimeout(() => finish(windows), FRAME_PROBE_WINDOW_MS);
    probe = windows;
    windows.frameHandle = requestAnimationFrame(() => frame(windows));
};
