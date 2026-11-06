// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/stores/closeExternalPlayerOnQuit.test.ts — D3: the settings row 「Folia 退出时关闭 Spotify」.
// The renderer keeps the value the settings row reads, and writes it to the main process's store,
// which is where the quit reads it, because the renderer may only reach the main process through
// preload (electron/preload.cjs, `saveSettings`).

const STORAGE_KEY = 'close_external_player_on_quit';

const loadStore = async (saveSettings: () => void) => {
    Object.defineProperty(window, 'electron', {
        value: { platform: 'win32', saveSettings },
        configurable: true,
        writable: true,
    });
    vi.resetModules();
    const module = await import('@/stores/useDesktopSettingsStore');
    return module.useDesktopSettingsStore;
};

beforeEach(() => {
    window.localStorage.clear();
});

describe('the quit switch', () => {
    it('is off until the listener asks for it', async () => {
        const store = await loadStore(vi.fn());
        expect(store.getState().closeExternalPlayerOnQuit).toBe(false);
    });

    it('writes the value the main process reads at the quit, and keeps it', async () => {
        const saveSettings = vi.fn();
        const store = await loadStore(saveSettings);

        store.getState().handleToggleCloseExternalPlayerOnQuit(true);
        expect(store.getState().closeExternalPlayerOnQuit).toBe(true);
        expect(saveSettings).toHaveBeenCalledWith(STORAGE_KEY, true);

        store.getState().handleToggleCloseExternalPlayerOnQuit(false);
        expect(saveSettings).toHaveBeenLastCalledWith(STORAGE_KEY, false);
    });
});
