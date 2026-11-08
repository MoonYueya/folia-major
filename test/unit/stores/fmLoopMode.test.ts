// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/stores/fmLoopMode.test.ts — 私人 FM 里循环模式改不了。
// 判断和提示只写在设置 store 一处，标志由调用方递进来：交互 bridge（面板、浮动播放条、
// 命令面板的 l 快捷键）、App 里遥控窗口那条 cycle-loop-mode、模组接口的 setLoopMode。
// 那三处各自在调之前读 isFmMode，这里钉住 store 这一端的行为。

vi.mock('react-i18next', () => ({
    initReactI18next: { type: '3rdParty', init: vi.fn() },
    useTranslation: () => ({ t: (key: string) => key }),
}));

import i18n from '@/i18n/config';
import { useAudioSettingsStore } from '@/stores/useAudioSettingsStore';
import { useStatusMessageStore } from '@/stores/useStatusMessageStore';

const LOOP_KEY = 'player_loop_mode';

beforeEach(() => {
    useAudioSettingsStore.setState({ loopMode: 'off' });
    useStatusMessageStore.setState({ message: null });
    localStorage.removeItem(LOOP_KEY);
});

describe('私人 FM 里循环模式不可改', () => {
    it('按循环按钮不改模式，也不往 localStorage 写偏好', () => {
        const write = vi.spyOn(localStorage, 'setItem');
        useAudioSettingsStore.getState().handleToggleLoopMode(true);
        expect(useAudioSettingsStore.getState().loopMode).toBe('off');
        expect(localStorage.getItem(LOOP_KEY)).toBeNull();
        expect(write).not.toHaveBeenCalled();
        write.mockRestore();
    });

    it('给的是说明性提示，不是「已设为 …」', () => {
        useAudioSettingsStore.getState().handleToggleLoopMode(true);
        const message = useStatusMessageStore.getState().message;
        expect(message?.type).toBe('info');
        expect(message?.text).toBe(i18n.t('player.loopUnavailableInFm'));
        expect(message?.text).not.toBe(i18n.t('player.loopAll'));
    });

    it('直接设置那一条（遥控窗口、模组接口）同样拦住', () => {
        useAudioSettingsStore.getState().handleSetLoopMode('shuffle', true);
        expect(useAudioSettingsStore.getState().loopMode).toBe('off');
        expect(localStorage.getItem(LOOP_KEY)).toBeNull();
    });

    it('不在 FM 时四态照常轮转，偏好照常写', () => {
        const expected = ['all', 'shuffle', 'one', 'off'] as const;
        for (const mode of expected) {
            useAudioSettingsStore.getState().handleToggleLoopMode(false);
            expect(useAudioSettingsStore.getState().loopMode).toBe(mode);
            expect(localStorage.getItem(LOOP_KEY)).toBe(mode);
        }
        expect(useStatusMessageStore.getState().message?.type).toBe('success');
    });
});
