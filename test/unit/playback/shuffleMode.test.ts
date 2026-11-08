import { describe, expect, it, vi } from 'vitest';
import {
    buildShuffleOrder,
    hasTrackAfter,
    nextPlayableShuffleQueueIndex,
    nextQueueIndex,
    nextShuffleQueueIndex,
    prevQueueIndex,
    prevShuffleQueueIndex,
    queueLoopMode,
    queueOrderSignature,
    resolvePlaybackNeighbors,
} from '../../../src/utils/playbackNeighbors';
import { loopModeIcon, loopModeLabelName } from '../../../src/components/shared/loopModeDisplay';
import { Repeat, Repeat1, RepeatOff, Shuffle } from 'lucide-react';
import { useAudioSettingsStore } from '../../../src/stores/useAudioSettingsStore';
import type { SongResult, StageLoopMode } from '../../../src/types';

// test/unit/playback/shuffleMode.test.ts
// 第四态「随机播放」：排列怎么洗、下一首/上一首怎么走、一轮放完怎么重洗、
// 列表循环与不循环的老规则有没有被这一态带歪，以及循环按钮的四态顺序、图标与标签。

const song = (id: number): SongResult => ({
    id,
    name: `song ${id}`,
    artists: [],
    album: {} as SongResult['album'],
    durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: String(id) },
} as SongResult);

/** 固定的「随机」序列：让洗牌可复现，断言的是排列的性质而不是某一次运气的产物。 */
const sequence = (...values: number[]) => {
    let index = 0;
    return () => values[index++ % values.length];
};

describe('buildShuffleOrder', () => {
    it('当前的这首排在最前，其余是下标的一个排列', () => {
        const order = buildShuffleOrder(5, 2, sequence(0.1, 0.9, 0.5, 0.3));
        expect(order[0]).toBe(2);
        expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    });

    it('当前曲不在队列里时整份打乱', () => {
        const order = buildShuffleOrder(4, -1, sequence(0.2, 0.7, 0.4));
        expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    });

    it('空队列没有排列', () => {
        expect(buildShuffleOrder(0, 0, sequence(0.5))).toEqual([]);
    });
});

describe('排列里的上一首 / 下一首', () => {
    const order = [3, 0, 4, 1, 2];

    it('下一首是排列里的下一个', () => {
        expect(nextShuffleQueueIndex(order, 3)).toBe(0);
        expect(nextShuffleQueueIndex(order, 0)).toBe(4);
    });

    it('走到排列末尾绕回排列开头（随机模式一直往下放）', () => {
        expect(nextShuffleQueueIndex(order, 2)).toBe(3);
    });

    it('上一首回到刚放过的下一首，不是临时再抽一个', () => {
        expect(prevShuffleQueueIndex(order, 0)).toBe(3);
        expect(prevShuffleQueueIndex(order, 2)).toBe(1);
    });

    it('当前曲不在排列里时从排列开头/末尾接上', () => {
        expect(nextShuffleQueueIndex(order, 9)).toBe(3);
        expect(prevShuffleQueueIndex(order, 9)).toBe(2);
        expect(nextShuffleQueueIndex([], 9)).toBe(-1);
    });
});

describe('随机模式下跳过不能播的', () => {
    const queue = [song(0), song(1), song(2), song(3)];

    it('按排列往后找第一首能播的', () => {
        const order = [2, 0, 3, 1];
        const unplayable = new Set(['song 0']);
        expect(nextPlayableShuffleQueueIndex(queue, order, 2, item => !unplayable.has(item.name))).toBe(3);
    });

    it('这一轮全都不能播时没有下一首', () => {
        const order = [2, 0, 3, 1];
        expect(nextPlayableShuffleQueueIndex(queue, order, 2, () => false)).toBe(-1);
    });

    it('只有一首的队列就是重播它自己（和列表循环一致）', () => {
        expect(nextPlayableShuffleQueueIndex([song(0)], [0], 0, () => true)).toBe(0);
    });
});

describe('随机模式不改变别的三态', () => {
    it('不循环、列表循环、单曲循环的下标规则保持原样', () => {
        const modes: StageLoopMode[] = ['off', 'all', 'one'];
        expect(modes.map(mode => nextQueueIndex(4, 3, mode))).toEqual([-1, 0, -1]);
        expect(modes.map(mode => prevQueueIndex(4, 0, mode))).toEqual([-1, 3, -1]);
        expect(modes.map(mode => hasTrackAfter(1, 0, mode))).toEqual([false, false, false]);
    });

    it('随机和列表循环一样会绕圈', () => {
        expect(nextQueueIndex(4, 3, 'shuffle')).toBe(0);
        expect(prevQueueIndex(4, 0, 'shuffle')).toBe(3);
        expect(hasTrackAfter(4, 3, 'shuffle')).toBe(true);
    });

    it('私人 FM 里随机按不循环算', () => {
        expect(queueLoopMode('shuffle', true)).toBe('off');
        expect(queueLoopMode('shuffle', false)).toBe('shuffle');
    });

    it('随机模式的邻居只答能不能跳，不编造标题', () => {
        const queue = [song(0), song(1), song(2)];
        const withoutOrder = resolvePlaybackNeighbors({
            playQueue: queue,
            currentSong: queue[1],
            loopMode: 'shuffle',
            isFmMode: false,
            isStageActive: false,
        });
        expect(withoutOrder.next.canGo).toBe(true);
        expect(withoutOrder.next.title).toBeNull();
        const withOrder = resolvePlaybackNeighbors({
            playQueue: queue,
            currentSong: queue[1],
            loopMode: 'shuffle',
            isFmMode: false,
            isStageActive: false,
            shuffleOrder: [1, 2, 0],
        });
        expect(withOrder.next.title).toBe('song 2');
        expect(withOrder.prev.title).toBe('song 0');
    });
});

describe('队列被改动时作废排列', () => {
    it('同一份队列给出同一个签名，增删或换序就变', () => {
        const a = [song(0), song(1), song(2)];
        expect(queueOrderSignature(a)).toBe(queueOrderSignature([song(0), song(1), song(2)]));
        expect(queueOrderSignature(a)).not.toBe(queueOrderSignature([song(0), song(2), song(1)]));
        expect(queueOrderSignature(a)).not.toBe(queueOrderSignature([song(0), song(1)]));
    });
});

describe('循环按钮的四态', () => {
    const initial = useAudioSettingsStore.getState();

    it('连点四下依次是 不循环 → 列表循环 → 随机 → 单曲循环 → 不循环', () => {
        useAudioSettingsStore.setState({ loopMode: 'off' }, false);
        const seen: StageLoopMode[] = [];
        for (let press = 0; press < 4; press += 1) {
            useAudioSettingsStore.getState().handleToggleLoopMode();
            seen.push(useAudioSettingsStore.getState().loopMode);
        }
        expect(seen).toEqual(['all', 'shuffle', 'one', 'off']);
        useAudioSettingsStore.setState(initial, true);
    });

    it('随机模式和别的模式一样存进 player_loop_mode', () => {
        // node 环境的单测没有 window / localStorage（jsdomLocalStorage 会把占位删掉），
        // 这一条只关心切到随机时写了哪个值，于是自己给这两个全局变量一份最小的实现。
        const entries = new Map<string, string>();
        vi.stubGlobal('window', {});
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => { entries.set(key, value); },
            removeItem: (key: string) => { entries.delete(key); },
        });
        useAudioSettingsStore.setState({ loopMode: 'off' }, false);
        useAudioSettingsStore.getState().handleSetLoopMode('shuffle');
        expect(useAudioSettingsStore.getState().loopMode).toBe('shuffle');
        expect(entries.get('player_loop_mode')).toBe('shuffle');
        vi.unstubAllGlobals();
        useAudioSettingsStore.setState(initial, true);
    });
});

describe('循环模式的图标与标签', () => {
    it('四态的图标依次是 RepeatOff / Repeat / Shuffle / Repeat1', () => {
        expect(loopModeIcon('off')).toBe(RepeatOff);
        expect(loopModeIcon('all')).toBe(Repeat);
        expect(loopModeIcon('shuffle')).toBe(Shuffle);
        expect(loopModeIcon('one')).toBe(Repeat1);
    });

    it('四态的标签名给的是 player.<name> 用的后缀', () => {
        expect(loopModeLabelName('off')).toBe('loopOff');
        expect(loopModeLabelName('all')).toBe('loopAll');
        expect(loopModeLabelName('shuffle')).toBe('loopShuffle');
        expect(loopModeLabelName('one')).toBe('loopOne');
    });
});
