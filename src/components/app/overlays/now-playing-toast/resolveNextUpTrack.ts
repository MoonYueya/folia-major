import { fmNextIsUnfetchedAt, nextQueueIndex, queueIndexOf, shuffleCurrentQueueIndex, type ShuffleOrderView } from '../../../../utils/playbackNeighbors';
import type { SongResult, StageLoopMode } from '../../../../types';
// src/components/app/overlays/now-playing-toast/resolveNextUpTrack.ts

type ResolveNextUpTrackParams = {
    playQueue: SongResult[];
    /**
     * 以哪一首为基准找后继：普通倒计时预览用 currentSong，混合期间用画面上那一首
     * （即将淡出的），因为 currentSong 在 arm 时就已经异步推进过去了。
     */
    song: SongResult | null;
    loopMode: StageLoopMode;
    isFmMode: boolean;
    isStageActive: boolean;
    /** 基准曲目不在队列里时是否退回队首，对齐 handleNextTrack 的下标规则 */
    fallbackToQueueHead?: boolean;
    /** 这一轮随机的排列与历史（usePlaybackStore 里那一份）；拿不到时随机模式的下一首推不出来。 */
    shuffleRound?: ShuffleOrderView | null;
};

/**
 * 一次自然结束的切歌会推进到的那一首，推不出来就是 null。
 * 只喂「接下来播放」这类预览，所以宁可返回 null 也不猜 —— 卡片报错一首歌
 * 比不报要难看得多。
 */
export const resolveNextUpTrack = ({
    playQueue,
    song,
    loopMode,
    isFmMode,
    isStageActive,
    fallbackToQueueHead = false,
    shuffleRound,
}: ResolveNextUpTrackParams): SongResult | null => {
    // 舞台播放不推进主队列，单曲循环原地重播，两种情况都没有「下一首」
    if (!song || playQueue.length === 0 || isStageActive || loopMode === 'one') {
        return null;
    }

    // 随机模式的下一首是这一轮排列里的，不是队列顺序里的（按队列顺序报出来的是另一首）。
    // 走到这一轮末尾时要重洗，那一刻是谁还不知道，仍然返回 null —— 宁可 null 也不猜。
    if (loopMode === 'shuffle' && !isFmMode) {
        const order = shuffleRound?.order ?? [];
        const position = order.indexOf(shuffleCurrentQueueIndex(playQueue, song, shuffleRound?.history ?? []));
        return position >= 0 && position < order.length - 1 ? playQueue[order[position + 1]] ?? null : null;
    }

    const currentIndex = queueIndexOf(playQueue, song);
    // FM 只在队尾那一首上不确定：handleNextTrack 从倒数第二首起就去拉新曲目，但拉完播的是
    // nextQueue[currentIndex + 1] —— 在倒数第二首上那仍然是旧队列的最后一首，已经在手里了，
    // 所以那一首照常预览。真正没有下一首的是最后一首：它的后继是刚拉回来的第一首。
    // 这里也不能落到下面 nextQueueIndex 的列表循环那条，FM 到底是拉新歌而不是回到队首。
    if (isFmMode && fmNextIsUnfetchedAt(playQueue.length, currentIndex)) {
        return null;
    }

    if (currentIndex < 0 && !fallbackToQueueHead) {
        return null;
    }
    const nextIndex = nextQueueIndex(playQueue.length, currentIndex, loopMode);
    return nextIndex >= 0 ? playQueue[nextIndex] ?? null : null;
};
