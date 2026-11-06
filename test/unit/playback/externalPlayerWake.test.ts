import { describe, expect, it, vi } from 'vitest';

// test/unit/playback/externalPlayerWake.test.ts — the setting that wakes the player of another
// program when Folia opens: asked for or not, and a player that refuses to start.

const { runExternalPlayerWarmUp } = await import('@/components/app/playback/externalPlayerWake');

describe('the launch wake-up of external players', () => {
    it('wakes the players when the listener asked for it', async () => {
        const warmUp = vi.fn(async () => {});
        await runExternalPlayerWarmUp(true, warmUp);
        expect(warmUp).toHaveBeenCalledTimes(1);
    });

    it('wakes nothing while the setting is off', async () => {
        const warmUp = vi.fn(async () => {});
        await runExternalPlayerWarmUp(false, warmUp);
        expect(warmUp).not.toHaveBeenCalled();
    });

    it('does not stop the app when a player cannot be started', async () => {
        const warmUp = vi.fn(async () => { throw new Error('no player'); });
        await expect(runExternalPlayerWarmUp(true, warmUp)).resolves.toBeUndefined();
        expect(warmUp).toHaveBeenCalledTimes(1);
    });
});
