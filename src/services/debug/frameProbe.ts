import { getExternalPosition, isExternalRoute, subscribeExternalPlayback } from '../onlineMusic/externalPlayback';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { audioPower } from '../../stores/motionSignals';


// src/services/debug/frameProbe.ts
// What the window was doing when a listener says the picture froze. The first version measured only
// from the moment the route was asked to move, which missed the freeze: the listener presses the bar,
// drags, releases, and only then is the move asked for, so the stall sat in front of the window. This
// one watches the whole time the external route is sounding, keeps a ring of what it saw, and writes
// the stretch around each mark of the listener's - two seconds before it, three after.

/** How long one mark's report covers, and how far back it reaches. */
export const FRAME_PROBE_WINDOW_MS = 3000;
export const FRAME_PROBE_BEFORE_MS = 2000;
/** A frame this far behind the one before it is one the eye sees the picture stop on. */
export const FRAME_PROBE_GAP_MS = 40;
/** How many events are held: a couple of minutes of a busy session, and no growth. */
const RING_SIZE = 400;

/** The marks the listener's own actions leave: the two moments reported, and what surrounds them. */
export type FrameProbeAction =
    | 'seek-down' | 'seek-up' | 'seek'
    | 'play' | 'pause'
    | 'toggle-play';

type ProbeEvent = { atMs: number; kind: string; [detail: string]: unknown };

let watching = false;
let frameHandle = 0;
let previousFrameMs = 0;
let observer: PerformanceObserver | null = null;
let unsubscribeStore: (() => void) | null = null;
let unsubscribeEmits: (() => void) | null = null;
let events: ProbeEvent[] = [];
let lastPositionSec = 0;
let stillSinceMs = 0;
let lastPower = 0;
let heldSinceMs = 0;
/** The marks whose window has not closed yet, so each writes its own line. */
const openMarks = new Set<ReturnType<typeof setTimeout>>();

const record = (kind: string, detail: Record<string, unknown> = {}) => {
    events.push({ atMs: performance.now(), kind, ...detail });
    if (events.length > RING_SIZE) events.splice(0, events.length - RING_SIZE);
};

const frame = () => {
    const nowMs = performance.now();
    if (previousFrameMs > 0) {
        const gapMs = nowMs - previousFrameMs;
        if (gapMs > FRAME_PROBE_GAP_MS) record('frame-gap', { gapMs: Math.round(gapMs) });
    }
    previousFrameMs = nowMs;
    // A position that does not change between two frames is the picture standing still, whichever
    // clock the frame loop reads. Any change counts, a drop back as much as a step forward.
    const positionSec = getExternalPosition();
    if (positionSec !== lastPositionSec) {
        lastPositionSec = positionSec;
        stillSinceMs = nowMs;
    }
    const power = audioPower.get();
    if (power !== lastPower) {
        lastPower = power;
        heldSinceMs = nowMs;
    }
    frameHandle = requestAnimationFrame(frame);
};

/** Starts watching the window: only while the external route is the one sounding. */
export const startFrameProbeWatch = (): void => {
    if (watching || typeof window === 'undefined' || !isExternalRoute()) return;
    watching = true;
    events = [];
    previousFrameMs = 0;
    lastPositionSec = getExternalPosition();
    stillSinceMs = performance.now();
    lastPower = audioPower.get();
    heldSinceMs = stillSinceMs;
    frameHandle = requestAnimationFrame(frame);
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) record('long-task', { ms: Math.round(entry.duration), at: Math.round(entry.startTime) });
        });
        observer.observe({ entryTypes: ['longtask'] });
    }
    // A window the compositor stops drawing reads exactly as a frozen picture, and is not a slow frame.
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    unsubscribeStore = usePlaybackStore.subscribe(() => record('store-write'));
    unsubscribeEmits = subscribeExternalPlayback(event => record('external-emit', { event: event.type }));
    // The main process measures the other half: its own loop, the window's focus there, the guard.
    send({ kind: 'start' });
};

const onVisibility = () => record('visibility', { state: document.visibilityState });
const onFocus = () => record('window-focus');
const onBlur = () => record('window-blur');

/** Stops watching: the route stopped sounding, or the probe was asked to stop. */
export const stopFrameProbeWatch = (): void => {
    if (!watching) return;
    watching = false;
    if (frameHandle) cancelAnimationFrame(frameHandle);
    frameHandle = 0;
    observer?.disconnect();
    observer = null;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    unsubscribeStore?.();
    unsubscribeStore = null;
    unsubscribeEmits?.();
    unsubscribeEmits = null;
    for (const timer of openMarks) clearTimeout(timer);
    openMarks.clear();
    events = [];
    send({ kind: 'stop' });
};

const send = (message: Record<string, unknown>) => {
    try {
        (window as unknown as { electron?: { debugFrameProbe?: (message: unknown) => void } }).electron
            ?.debugFrameProbe?.(message);
    } catch { /* the main process is gone, or this build has no bridge */ }
};

/**
 * Marks one action of the listener's. The report covers the two seconds before it - where a drag began,
 * and what the window did while it was dragged - and the three after it, and is written once that
 * stretch has gone by. A mark outside the external route does nothing: every other way of playing draws
 * the same picture from clocks and frames this probe is not measuring.
 */
export const markFrameProbe = (action: FrameProbeAction): void => {
    if (!watching) return;
    const markedAtMs = performance.now();
    record('mark', { action });
    send({ kind: 'mark', label: action, action });
    const settle = setTimeout(() => {
        openMarks.delete(settle);
        // The position and the power are read once more here: a change that landed between two frames
        // is still the line having moved, and the marks are written on a timer of their own.
        const positionNow = getExternalPosition();
        if (positionNow !== lastPositionSec) {
            lastPositionSec = positionNow;
            stillSinceMs = performance.now();
        }
        const powerNow = audioPower.get();
        if (powerNow !== lastPower) {
            lastPower = powerNow;
            heldSinceMs = performance.now();
        }
        // Each event carries how far it was from the mark, in ms: negative before it, positive after.
        const within = events
            .filter(event => event.atMs >= markedAtMs - FRAME_PROBE_BEFORE_MS && event.atMs <= markedAtMs + FRAME_PROBE_WINDOW_MS)
            .map(event => {
                const { atMs, ...rest } = event;
                return { atMs: Math.round(atMs - markedAtMs), ...rest };
            });
        console.info('[FrameProbe]', {
            action,
            windowMs: FRAME_PROBE_WINDOW_MS,
            beforeMs: FRAME_PROBE_BEFORE_MS,
            lyricTimeStillMs: Math.round(performance.now() - stillSinceMs),
            spectrumHeldMs: Math.round(performance.now() - heldSinceMs),
            events: within,
        });
    }, FRAME_PROBE_WINDOW_MS);
    openMarks.add(settle);
};

/** For a test: whether a mark would be taken now, and what is held. */
export const isFrameProbeWatching = () => watching;
export const frameProbeEvents = () => events.map(event => ({ ...event }));
