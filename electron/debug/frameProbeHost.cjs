// electron/debug/frameProbeHost.cjs
// The main process half of the freeze probe. A picture that freezes under the external route may be
// frozen outside the renderer: this process busy in a loop, a window losing focus or being hidden, or
// the PowerShell the external player's guard spawns taking seconds. None of that is visible to a probe in
// the page, so it is measured here and written to the runtime log beside the renderer's own line.

/** How often the event loop is asked how late it is. */
const LOOP_SAMPLE_MS = 50;
/** A late sample of the loop, or a slow call below, is one the picture could have stopped on. */
const SLOW_MS = 40;
/** How far before the mark, and how long after it, the log line covers. */
const WINDOW_BEFORE_MS = 2000;
const WINDOW_AFTER_MS = 3000;
/** How many events are held: a couple of minutes of a busy window, and no growth. */
const RING_SIZE = 400;

/**
 * One mark of the renderer's, with what this process measured around it. The renderer says when; this
 * process adds the loop's own lateness, the window's focus, and the guard's PowerShell calls.
 */
const createFrameProbeHost = ({ now = Date.now, log = () => {} } = {}) => {
    /** Events, oldest first, each with the wall-clock millisecond it happened at. */
    let events = [];
    let timer = null;
    let lastSampleAt = 0;
    const pending = new Map();

    const record = (kind, detail) => {
        events.push({ at: now(), kind, detail });
        if (events.length > RING_SIZE) events.splice(0, events.length - RING_SIZE);
    };

    const sample = () => {
        const at = now();
        // A sample that arrives late is the loop having been busy for that long: setInterval fires as
        // soon as it can, so the shortfall between the moment it was due and the moment it ran is the
        // time this process spent unable to answer anything at all.
        if (lastSampleAt > 0) {
            const lateMs = at - lastSampleAt - LOOP_SAMPLE_MS;
            if (lateMs > SLOW_MS) record('loop-late', { lateMs: Math.round(lateMs) });
        }
        lastSampleAt = at;
    };

    return {
        start() {
            if (timer !== null) return;
            lastSampleAt = 0;
            timer = setInterval(sample, LOOP_SAMPLE_MS);
            // A sample must not be the reason this process stays alive.
            timer.unref?.();
        },
        stop() {
            if (timer === null) return;
            clearInterval(timer);
            timer = null;
        },
        /** A mark of the renderer's: the log line is written once the window after it has gone by. */
        mark(label, action) {
            const markedAt = now();
            record('mark', { label, action });
            const settle = setTimeout(() => {
                pending.delete(markedAt);
                const from = markedAt - WINDOW_BEFORE_MS;
                const to = markedAt + WINDOW_AFTER_MS;
                const within = events
                    .filter(event => event.at >= from && event.at <= to)
                    .map(event => ({ atMs: event.at - markedAt, kind: event.kind, ...event.detail }));
                log('[FrameProbe:main]', {
                    label,
                    action,
                    windowMs: WINDOW_AFTER_MS,
                    events: within,
                });
            }, WINDOW_AFTER_MS);
            settle.unref?.();
            pending.set(markedAt, settle);
        },
        /** What a slow call below is recorded under: the guard's own work, measured where it runs. */
        note(kind, detail) {
            record(kind, detail);
        },
        /** A call that took this long is recorded if it is slow enough to have stopped the picture. */
        noteCall(kind, ms) {
            if (ms > SLOW_MS) record(kind, { ms: Math.round(ms) });
        },
        /** For a test: what is held now. */
        events: () => events.map(event => ({ ...event })),
        pending: () => pending.size,
    };
};

/**
 * The window's own events: a window that is hidden, or that the listener moved away from, is a window
 * whose frames the compositor may stop drawing - which reads as the picture freezing, not as it being
 * slow. Only the main window's are recorded: the others' frames are nothing the listener watches.
 */
const watchWindowEvents = (probe, window) => {
    if (!window || typeof window.on !== 'function') return () => {};
    const note = kind => () => probe.note(kind, {});
    const handlers = {
        blur: note('window-blur'),
        focus: note('window-focus'),
        hide: note('window-hide'),
        show: note('window-show'),
        minimize: note('window-minimize'),
        restore: note('window-restore'),
    };
    for (const [event, handler] of Object.entries(handlers)) window.on(event, handler);
    return () => {
        for (const [event, handler] of Object.entries(handlers)) window.off?.(event, handler);
    };
};

/**
 * Times a function the guard calls into PowerShell or into the page, and records the call when it took
 * long enough to have stopped everything else here. Written as a wrapper rather than a timer inside the
 * guard: the guard is about steering the player, and this is about how long the machine took to answer it.
 */
const timeSlowCall = (probe, kind, call) => async (...args) => {
    const startedAt = Date.now();
    try {
        return await call(...args);
    } finally {
        probe?.noteCall(kind, Date.now() - startedAt);
    }
};

module.exports = {
    createFrameProbeHost, watchWindowEvents, timeSlowCall, LOOP_SAMPLE_MS, SLOW_MS, WINDOW_AFTER_MS,
};
