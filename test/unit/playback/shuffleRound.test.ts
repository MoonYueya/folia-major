import { beforeEach, describe, expect, it } from 'vitest';
import {
    buildShuffleOrder,
    emptyShuffleRound,
    prevShuffleIndexFromRound,
    queueOrderSignature,
    resolveTransitionTarget,
    shuffleCurrentQueueIndex,
    stepBackShuffleRound,
    stepShuffleRound,
    syncShuffleRound,
    type ShuffleRoundState,
} from '../../../src/utils/playbackNeighbors';
import { readShuffleRound, setShuffleRound, usePlaybackStore } from '../../../src/stores/usePlaybackStore';
import { getPlaybackSongKey } from '../../../src/utils/appPlaybackGuards';
import type { SongResult } from '../../../src/types';

// test/unit/playback/shuffleRound.test.ts
// 一轮随机的胶水：什么时候洗、什么时候重洗、队列改过之后怎么重锚、上一首从哪儿弹，
// 以及「拿不到排列」时过渡目标报的是什么原因（automix 的日志不许把随机当成队列到头）。
// 这些规则住在 playbackNeighbors 的纯函数里，状态住在 usePlaybackStore；这里两半一起验。

const song = (id: string): SongResult => ({
    id,
    name: 'song ' + id,
    artists: [],
    album: {} as SongResult['album'],
    durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: id },
} as SongResult);

const queueOf = (...ids: string[]): SongResult[] => ids.map(song);
const keyOf = (item: SongResult): string => getPlaybackSongKey(item);

const FIXED_RANDOM = 0.5;
const fixed = (...values: number[]) => {
    let index = 0;
    return () => values[index++ % values.length];
};
const roundOf = (queue: SongResult[], order: number[], played: number[]): ShuffleRoundState => ({
    order,
    signature: queueOrderSignature(queue),
    history: played.map(index => ({ key: keyOf(queue[index]), index })),
});

beforeEach(() => setShuffleRound(null));

describe('进入随机模式时的第一轮', () => {
    it('此刻这首排在第一位，队列没变时再取就是同一份', () => {
        const queue = queueOf('a', 'b', 'c', 'd');
        const round = syncShuffleRound(emptyShuffleRound(), queue, queue[1], fixed(FIXED_RANDOM));
        expect(round.order[0]).toBe(1);
        expect([...round.order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
        expect(round.signature).toBe(queueOrderSignature(queue));
        expect(syncShuffleRound(round, queue, queue[1], fixed(FIXED_RANDOM))).toBe(round);
    });

    // 位置式的上一首是排列末位，而末位是这一轮还没放过的一首。刚进随机时按上一首绝不能跳到那儿。
    it('本轮只有此刻这一首时上一首没有去处，不会跳到这一轮没放过的末位', () => {
        const queue = queueOf('a', 'b', 'c', 'd');
        const round = syncShuffleRound(emptyShuffleRound(), queue, queue[1], fixed(FIXED_RANDOM));
        expect(stepBackShuffleRound(round, queue, queue[1], fixed(FIXED_RANDOM)).index).toBe(-1);
        // 老规则（只按排列位置）在这里给的是排列末位 —— 正是那次审查抓到的跳转
        expect(prevShuffleIndexFromRound(queue, round.order, [], 1)).toBe(round.order[round.order.length - 1]);
    });
});

describe('下一首与重洗', () => {
    it('顺着这一轮往下走，不重放已经放过的', () => {
        const queue = queueOf('a', 'b', 'c', 'd');
        const round = roundOf(queue, [0, 3, 1, 2], [0]);
        expect(stepShuffleRound(round, queue, queue[0], () => true, fixed(FIXED_RANDOM)).index).toBe(3);
    });

    it('走到排列最后一首就重洗，重洗后当前这首仍在最前，下一首来自新排列', () => {
        const queue = queueOf('a', 'b', 'c', 'd');
        const round = roundOf(queue, [2, 0, 1, 3], [2, 0, 1, 3]);
        const step = stepShuffleRound(round, queue, queue[3], () => true, fixed(0.1, 0.8, 0.4));
        expect(step.round.order[0]).toBe(3);
        expect(new Set(step.round.order)).toEqual(new Set([0, 1, 2, 3]));
        expect(step.index).toBe(step.round.order[1]);
        expect(step.round.signature).toBe(queueOrderSignature(queue));
        // 一轮放完重洗不会把历史清掉：上一首还得回到这一轮真正放过的那些，
        // 而这一轮新选中的那首压在最后。整条历史一起比，多推一条就会红。
        expect(step.round.history.map(entry => entry.index)).toEqual([2, 0, 1, 3, step.round.order[1]]);
    });

    it('这一轮里一首能播的都没有时给出 -1，不绕回本轮开头', () => {
        const queue = queueOf('a', 'b', 'c');
        const round = roundOf(queue, [0, 1, 2], [0]);
        expect(stepShuffleRound(round, queue, queue[0], () => false, fixed(FIXED_RANDOM)).index).toBe(-1);
    });

    it('没得播时把这一轮原样递回来，调用方据此不写 store', () => {
        const queue = queueOf('a', 'b', 'c');
        const round = roundOf(queue, [0, 1, 2], [0]);
        // 队列没变、排列里还有位置、只是下一首不能播：这一轮没有任何变化
        expect(stepShuffleRound(round, queue, queue[0], () => false, fixed(FIXED_RANDOM)).round).toBe(round);
        // 上一首在这份历史里没有更早的歌，同样不产生新的一轮
        expect(stepBackShuffleRound(round, queue, queue[0], fixed(FIXED_RANDOM)).round).toBe(round);
    });
});

describe('上一首', () => {
    // 队列被编辑过（这里在前面插了一首，下标全变）之后，上一首仍要回到刚放过那首。
    it('队列编辑后下标错位，上一首还是刚放过那首', () => {
        const queue = queueOf('a', 'b', 'c', 'd');
        const played = stepShuffleRound(roundOf(queue, [0, 1, 2, 3], [0]), queue, queue[0], () => true, fixed(FIXED_RANDOM));
        const playing = queue[played.index];
        const edited = [song('x'), ...queue];
        const step = stepBackShuffleRound(played.round, edited, playing, fixed(FIXED_RANDOM));
        expect(edited[step.index].name).toBe('song a');
    });

    // 手动点了队列里另一首之后，上一首是点之前那首（历史顶部是它，不是被点的那首）。
    it('手动点队列里另一首再按上一首，回到点之前那首', () => {
        const queue = queueOf('a', 'b', 'c', 'd');
        const round = roundOf(queue, [0, 1, 2, 3], [0, 1]);
        const step = stepBackShuffleRound(round, queue, queue[3], fixed(FIXED_RANDOM));
        expect(queue[step.index].name).toBe('song b');
    });

    it('从历史里弹出去之后，再按一次继续往前', () => {
        const queue = queueOf('a', 'b', 'c');
        const first = stepBackShuffleRound(roundOf(queue, [0, 1, 2], [0, 1, 2]), queue, queue[2], fixed(FIXED_RANDOM));
        expect(queue[first.index].name).toBe('song b');
        const second = stepBackShuffleRound(first.round, queue, queue[first.index], fixed(FIXED_RANDOM));
        expect(queue[second.index].name).toBe('song a');
    });
});

describe('队列被改动', () => {
    it('本轮剩余重洗，签名跟着换，历史留着', () => {
        const queue = queueOf('a', 'b', 'c');
        const round = roundOf(queue, [0, 1, 2], [0, 1]);
        const edited = queueOf('a', 'b', 'c', 'd');
        const synced = syncShuffleRound(round, edited, edited[1], fixed(FIXED_RANDOM));
        expect(synced).not.toBe(round);
        expect(synced.signature).toBe(queueOrderSignature(edited));
        expect(synced.order[0]).toBe(1);
        expect(new Set(synced.order)).toEqual(new Set([0, 1, 2, 3]));
        expect(synced.history.map(entry => entry.index)).toEqual([0, 1]);
    });

    it('被删掉的那首从历史里掉出去，上一首顺到还在的那首', () => {
        const queue = queueOf('a', 'b', 'c');
        const round = roundOf(queue, [0, 1, 2], [0, 1, 2]);
        const edited = queueOf('a', 'c');
        const synced = syncShuffleRound(round, edited, edited[1], fixed(FIXED_RANDOM));
        expect(synced.history.map(entry => entry.index)).toEqual([0, 1]);
        const step = stepBackShuffleRound(round, edited, edited[1], fixed(FIXED_RANDOM));
        expect(edited[step.index].name).toBe('song a');
    });
});

describe('同一首在队列里排了两次', () => {
    // 按 key 反查会拿到前一个副本，播到第二个副本之后排列位置就错位了。
    it('播到第二个副本时按排列接着走，不会退回第一个副本', () => {
        const queue = [song('a'), song('b'), song('a')];
        const round = roundOf(queue, [0, 2, 1], [0, 2]);
        expect(shuffleCurrentQueueIndex(queue, queue[2], round.history)).toBe(2);
        expect(stepShuffleRound(round, queue, queue[2], () => true, fixed(FIXED_RANDOM)).index).toBe(1);
    });
});

describe('过渡目标的原因', () => {
    it('随机模式下拿不到排列时说的是没有排列，不是队列到头', () => {
        const queue = queueOf('a', 'b', 'c');
        expect(resolveTransitionTarget(queue, queue[0], 'shuffle', false, null))
            .toEqual({ song: null, reason: 'shuffle-order-unknown' });
        expect(resolveTransitionTarget(queue, queue[0], 'shuffle', false, { order: [], history: [] }).reason)
            .toBe('shuffle-order-unknown');
        // 有排列、只是排列里没有这一首：是另一回事，日志不该让人去查「为什么没有排列」
        expect(resolveTransitionTarget(queue, queue[1], 'shuffle', false, { order: [0, 2], history: [] }).reason)
            .toBe('shuffle-current-not-in-order');
    });

    it('随机模式下按这一轮的排列给下一首，走到末尾则说是这一轮放完了', () => {
        const queue = queueOf('a', 'b', 'c');
        const round = roundOf(queue, [0, 2, 1], [0]);
        expect(resolveTransitionTarget(queue, queue[0], 'shuffle', false, round)).toEqual({ song: queue[2], reason: 'ok' });
        expect(resolveTransitionTarget(queue, queue[1], 'shuffle', false, round).reason).toBe('shuffle-round-end');
    });

    it('不循环走到队尾才是队列到头，列表循环绕回队首', () => {
        const queue = queueOf('a', 'b');
        expect(resolveTransitionTarget(queue, queue[1], 'off', false)).toEqual({ song: null, reason: 'queue-end' });
        expect(resolveTransitionTarget(queue, queue[1], 'all', false).song).toBe(queue[0]);
        // 私人 FM 里随机按不循环算：队尾那首的后继是现拉回来的，此刻叫不出名字
        expect(resolveTransitionTarget(queue, queue[1], 'shuffle', true).reason).toBe('fm-next-unfetched');
    });
});

describe('store 里这一轮', () => {
    it('排列、签名、历史一次写入，清空也一次清空', () => {
        const round: ShuffleRoundState = {
            order: [1, 0],
            signature: 'sig',
            history: [{ key: 'k', index: 1 }],
        };
        setShuffleRound(round);
        expect(readShuffleRound()).toEqual(round);
        expect(usePlaybackStore.getState().shuffleOrder).toEqual([1, 0]);
        expect(usePlaybackStore.getState().shuffleSignature).toBe('sig');
        setShuffleRound(null);
        expect(readShuffleRound()).toEqual(emptyShuffleRound());
        expect(usePlaybackStore.getState().shuffleOrder).toBeNull();
    });

    it('buildShuffleOrder 给的是当前曲在前的一个排列（重洗时也照这个起点）', () => {
        const order = buildShuffleOrder(4, 2, fixed(0.3, 0.7, 0.5));
        expect(order[0]).toBe(2);
        expect(new Set(order)).toEqual(new Set([0, 1, 2, 3]));
    });
});
