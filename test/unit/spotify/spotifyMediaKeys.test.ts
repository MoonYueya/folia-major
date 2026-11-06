import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/spotify/spotifyMediaKeys.test.ts — the system media keys Folia holds while an external
// player sounds the song: the three keys are registered and mapped to transport actions, given back
// on request, and a key the system refused is tried again the next time.

const require = createRequire(import.meta.url);
const { createMediaKeyTakeover, MEDIA_KEYS } = require('../../../electron/spotify/mediaKeys.cjs');

const makeShortcut = (refused: string[] = []) => {
    const handlers = new Map<string, () => void>();
    return {
        handlers,
        register: vi.fn((accelerator: string, handler: () => void) => {
            if (refused.includes(accelerator)) return false;
            handlers.set(accelerator, handler);
            return true;
        }),
        unregister: vi.fn((accelerator: string) => { handlers.delete(accelerator); }),
    };
};

describe('the media key takeover', () => {
    it('holds the three keys and tells which transport action each one is', () => {
        const globalShortcut = makeShortcut();
        const onKey = vi.fn();
        const takeover = createMediaKeyTakeover({ globalShortcut, onKey, log: () => {}, warn: () => {} });

        expect(takeover.set(true).held.sort()).toEqual(Object.keys(MEDIA_KEYS).sort());
        globalShortcut.handlers.get('MediaNextTrack')!();
        globalShortcut.handlers.get('MediaPreviousTrack')!();
        globalShortcut.handlers.get('MediaPlayPause')!();
        expect(onKey.mock.calls.map(call => call[0])).toEqual(['next', 'previous', 'play-pause']);
    });

    it('registers nothing twice and gives every key back when asked', () => {
        const globalShortcut = makeShortcut();
        const takeover = createMediaKeyTakeover({ globalShortcut, onKey: () => {}, log: () => {}, warn: () => {} });
        takeover.set(true);
        takeover.set(true);
        expect(globalShortcut.register).toHaveBeenCalledTimes(3);

        expect(takeover.set(false)).toEqual({ enabled: false, held: [] });
        expect(globalShortcut.unregister).toHaveBeenCalledTimes(3);
        expect(globalShortcut.handlers.size).toBe(0);
    });

    it('reports a key the system refused and tries it again on the next call', () => {
        const refused = ['MediaNextTrack'];
        const globalShortcut = makeShortcut(refused);
        const warn = vi.fn();
        const takeover = createMediaKeyTakeover({ globalShortcut, onKey: () => {}, log: () => {}, warn });

        expect(takeover.set(true).held).not.toContain('MediaNextTrack');
        expect(warn).toHaveBeenCalled();
        refused.length = 0;
        expect(takeover.set(true).held).toContain('MediaNextTrack');
    });

    it('does not throw when the system throws on register', () => {
        const globalShortcut = makeShortcut();
        globalShortcut.register.mockImplementation(() => { throw new Error('no'); });
        const takeover = createMediaKeyTakeover({ globalShortcut, onKey: () => {}, log: () => {}, warn: () => {} });
        expect(takeover.set(true)).toEqual({ enabled: false, held: [] });
    });
});
