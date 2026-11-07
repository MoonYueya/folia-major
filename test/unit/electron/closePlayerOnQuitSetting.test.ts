import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/closePlayerOnQuitSetting.test.ts — the quit switch 「Folia 退出时关闭外部播放器」 as
// the main process reads it. The key is CLOSE_EXTERNAL_PLAYER_ON_QUIT, but this fork published the
// same switch under the lower-case close_external_player_on_quit, so a value saved back then has to
// reach the quit rather than read as off: it is carried over to the upper-case key as it is read.

const require = createRequire(import.meta.url);
const {
    CLOSE_PLAYER_ON_QUIT_SETTING_KEY,
    LEGACY_CLOSE_PLAYER_ON_QUIT_SETTING_KEY,
    createClosePlayerOnQuitSetting,
} = require('../../../electron/closePlayerOnQuitSetting.cjs');

function makeStore(entries: Record<string, unknown> = {}, { cannotWrite = false } = {}) {
    const values = new Map(Object.entries(entries));
    const store = {
        has: (key: string) => values.has(key),
        get: (key: string) => values.get(key),
        set: vi.fn((key: string, value: unknown) => {
            if (cannotWrite) throw new Error('the store refused the write');
            values.set(key, value);
        }),
    };
    return { store, values };
}

describe('the keys', () => {
    it('keeps the name every switch in the shared store uses, and reads the published lower-case one', () => {
        expect(CLOSE_PLAYER_ON_QUIT_SETTING_KEY).toBe('CLOSE_EXTERNAL_PLAYER_ON_QUIT');
        expect(LEGACY_CLOSE_PLAYER_ON_QUIT_SETTING_KEY).toBe('close_external_player_on_quit');
    });
});

describe('reading the switch at the quit', () => {
    it('is off when nothing was ever stored', () => {
        const { store } = makeStore();
        const log = vi.fn();
        expect(createClosePlayerOnQuitSetting(store, log)()).toBe(false);
        expect(store.set).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    });

    it('answers the upper-case key, and only true for a stored true', () => {
        expect(createClosePlayerOnQuitSetting(makeStore({ CLOSE_EXTERNAL_PLAYER_ON_QUIT: true }).store)()).toBe(true);
        expect(createClosePlayerOnQuitSetting(makeStore({ CLOSE_EXTERNAL_PLAYER_ON_QUIT: 'true' }).store)()).toBe(false);
        expect(createClosePlayerOnQuitSetting(makeStore({ CLOSE_EXTERNAL_PLAYER_ON_QUIT: false }).store)()).toBe(false);
    });

    it('carries a value this fork stored under the old key over to the new one', () => {
        const { store, values } = makeStore({ close_external_player_on_quit: true });
        const log = vi.fn();
        expect(createClosePlayerOnQuitSetting(store, log)()).toBe(true);
        expect(store.set).toHaveBeenCalledWith('CLOSE_EXTERNAL_PLAYER_ON_QUIT', true);
        expect(values.get('CLOSE_EXTERNAL_PLAYER_ON_QUIT')).toBe(true);
        expect(log).toHaveBeenCalledTimes(1);
        expect(String(log.mock.calls[0][0])).toContain('CLOSE_EXTERNAL_PLAYER_ON_QUIT');
        // The old key stays: the migration only reads it, never renames or deletes it.
        expect(values.get('close_external_player_on_quit')).toBe(true);
    });

    it('carries an off value too, so the new key answers from then on', () => {
        const { store, values } = makeStore({ close_external_player_on_quit: false });
        expect(createClosePlayerOnQuitSetting(store, vi.fn())()).toBe(false);
        expect(values.has('CLOSE_EXTERNAL_PLAYER_ON_QUIT')).toBe(true);
    });

    it('prefers the new key once both are stored', () => {
        const { store } = makeStore({ close_external_player_on_quit: false, CLOSE_EXTERNAL_PLAYER_ON_QUIT: true });
        expect(createClosePlayerOnQuitSetting(store, vi.fn())()).toBe(true);
        expect(store.set).not.toHaveBeenCalled();
    });

    it('still answers from the old key when the store cannot be written', () => {
        const { store } = makeStore({ close_external_player_on_quit: true }, { cannotWrite: true });
        const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(createClosePlayerOnQuitSetting(store, vi.fn())()).toBe(true);
        expect(warned).toHaveBeenCalledTimes(1);
        warned.mockRestore();
    });
});
