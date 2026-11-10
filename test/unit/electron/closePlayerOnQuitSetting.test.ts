import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/closePlayerOnQuitSetting.test.ts — the quit switch 「Folia 退出时关闭外部播放器」 as
// the main process reads it. The key is CLOSE_EXTERNAL_PLAYER_ON_QUIT, but this fork published the
// same switch under the lower-case close_external_player_on_quit, so a value saved back then has to
// reach the quit rather than be lost: it is carried over to the upper-case key before the quit reads
// it. What an unset switch answers is the quit's own rule (it reads as on, electron/main.cjs), so
// nothing here answers for that case — the carrying is all this module does.

const require = createRequire(import.meta.url);
const {
    CLOSE_PLAYER_ON_QUIT_SETTING_KEY,
    LEGACY_CLOSE_PLAYER_ON_QUIT_SETTING_KEY,
    carryClosePlayerOnQuitSetting,
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

describe('carrying the published key over at the quit', () => {
    it('carries nothing when nothing was ever stored, leaving the quit its own default', () => {
        const { store } = makeStore();
        const log = vi.fn();
        expect(carryClosePlayerOnQuitSetting(store, log)).toBe(false);
        expect(store.set).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    });

    it('carries a value this fork stored under the old key over to the new one', () => {
        const { store, values } = makeStore({ close_external_player_on_quit: true });
        const log = vi.fn();
        expect(carryClosePlayerOnQuitSetting(store, log)).toBe(true);
        expect(store.set).toHaveBeenCalledWith('CLOSE_EXTERNAL_PLAYER_ON_QUIT', true);
        expect(values.get('CLOSE_EXTERNAL_PLAYER_ON_QUIT')).toBe(true);
        expect(log).toHaveBeenCalledTimes(1);
        expect(String(log.mock.calls[0][0])).toContain('CLOSE_EXTERNAL_PLAYER_ON_QUIT');
        // The old key stays: the migration only reads it, never renames or deletes it.
        expect(values.get('close_external_player_on_quit')).toBe(true);
    });

    it('carries an off value too, so the new key answers from then on', () => {
        const { store, values } = makeStore({ close_external_player_on_quit: false });
        expect(carryClosePlayerOnQuitSetting(store, vi.fn())).toBe(true);
        expect(values.has('CLOSE_EXTERNAL_PLAYER_ON_QUIT')).toBe(true);
        expect(values.get('CLOSE_EXTERNAL_PLAYER_ON_QUIT')).toBe(false);
    });

    it('carries nothing once the new key holds a value of its own', () => {
        const { store } = makeStore({ close_external_player_on_quit: false, CLOSE_EXTERNAL_PLAYER_ON_QUIT: true });
        expect(carryClosePlayerOnQuitSetting(store, vi.fn())).toBe(false);
        expect(store.set).not.toHaveBeenCalled();
    });

    it('leaves the old key in place when the store cannot be written', () => {
        const { store, values } = makeStore({ close_external_player_on_quit: true }, { cannotWrite: true });
        const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(carryClosePlayerOnQuitSetting(store, vi.fn())).toBe(false);
        expect(warned).toHaveBeenCalledTimes(1);
        expect(values.get('close_external_player_on_quit')).toBe(true);
        warned.mockRestore();
    });
});
