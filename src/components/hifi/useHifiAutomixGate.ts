import { useMemo } from 'react';
import type { PlaybackRoute } from '../../types/hifi';
import type { SongResult, StageLoopMode } from '../../types';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { useHifiSettingsStore } from '../../stores/useHifiSettingsStore';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import { useHifiEngineStore } from '../../services/hifi/hifiEngine';
import { playbackKindOfSong } from '../../services/hifi/hifiEligibility';
import { hifiRouteFor } from '../../services/hifi/hifiPlayback';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import {
    nextQueueIndex,
    nextShuffleIndexWithinRound,
    queueIndexOf,
    queueLoopMode,
    shuffleCurrentQueueIndex,
    type ShuffleOrderView,
} from '../../utils/playbackNeighbors';

// src/components/hifi/useHifiAutomixGate.ts
// 智能过渡（automix / 交叉淡入淡出）要两个 <audio> deck 同时出声，mpv 不在这两个 deck 里：当前或下一首走 HiFi 时关掉它。

type RouteFor = (kind: 'local' | 'navidrome', songKey: string) => PlaybackRoute;

/** 这首歌按现在的设置会不会走 HiFi。在线歌曲和 Stage 推来的歌一律不会。 */
const routesHifi = (song: SongResult | null | undefined, routeFor: RouteFor): boolean => {
    if (!song) return false;
    const kind = playbackKindOfSong(song);
    if (kind !== 'local' && kind !== 'navidrome') return false;
    return routeFor(kind, getPlaybackSongKey(song)) === 'hifi';
};

export type HifiAutomixGateInput = {
    playbackRoute: PlaybackRoute;
    playQueue: SongResult[];
    currentSong: SongResult | null;
    loopMode: StageLoopMode;
    isFmMode: boolean;
    /** 这一轮随机的排列与历史（usePlaybackStore 里那一份）；没进随机时不给。 */
    shuffleRound?: ShuffleOrderView | null;
};

/**
 * HiFi 是否挡住智能过渡：正在 HiFi 上放，或者当前这首、或下一首（和 handleNextTrack 同一套下标规则，私人 FM 按不循环）会走 HiFi。
 * 当前这首也算：它在载入、路线还没切过去的那一下，智能过渡不该趁机去混它。
 * 随机模式的下一首在这一轮的排列里（handleNextTrack 也照排列切），按队列顺序算出来的是另一首 ——
 * 那样会挡掉一次其实不会碰到 HiFi 的过渡，也会放过一次真要接上 HiFi 的。
 */
export const hifiBlocksAutomix = (
    { playbackRoute, playQueue, currentSong, loopMode, isFmMode, shuffleRound }: HifiAutomixGateInput,
    routeFor: RouteFor = hifiRouteFor,
): boolean => {
    if (playbackRoute === 'hifi') return true;
    if (routesHifi(currentSong, routeFor)) return true;
    const nextIndex = loopMode === 'shuffle' && !isFmMode
        ? nextShuffleIndexWithinRound(shuffleRound?.order ?? [], shuffleCurrentQueueIndex(playQueue, currentSong, shuffleRound?.history ?? []))
        : nextQueueIndex(playQueue.length, queueIndexOf(playQueue, currentSong), queueLoopMode(loopMode, isFmMode));
    return nextIndex >= 0 && routesHifi(playQueue[nextIndex], routeFor);
};

// App 把它并进 useAutomixDecks 的 isEnabled。
export function useHifiAutomixGate(): boolean {
    const playbackRoute = usePlaybackStore(state => state.playbackRoute);
    const playQueue = usePlaybackStore(state => state.playQueue);
    const currentSong = usePlaybackStore(state => state.currentSong);
    const isFmMode = usePlaybackStore(state => state.isFmMode);
    const loopMode = useAudioSettingsStore(state => state.loopMode);
    // 这一轮随机的排列：它一变（重洗、队列改了重锚）下一首就是另一首，闸门要跟着重判。
    const shuffleOrder = usePlaybackStore(state => state.shuffleOrder);
    const shuffleHistory = usePlaybackStore(state => state.shuffleHistory);
    // hifiRouteFor 自己读这些 store；订阅它们只是为了在设置、运行时或熔断变了时重新判一次。
    const enabled = useHifiSettingsStore(state => state.enabled);
    const navidrome = useHifiSettingsStore(state => state.navidrome);
    const supported = useHifiEngineStore(state => state.supported);
    const runtimeAvailable = useHifiEngineStore(state => state.runtime?.available === true);
    const circuitOpen = useHifiEngineStore(state => state.circuitOpen);

    const shuffleRound = useMemo(() => ({ order: shuffleOrder ?? [], history: shuffleHistory }), [shuffleOrder, shuffleHistory]);

    return useMemo(() => {
        // 这几项挡住时 hifiRouteFor 一律答 web，不必逐首去问。
        if (playbackRoute !== 'hifi' && (!supported || !enabled || !runtimeAvailable || circuitOpen)) return false;
        return hifiBlocksAutomix({ playbackRoute, playQueue, currentSong, loopMode, isFmMode, shuffleRound });
        // navidrome 不在函数体里，是 hifiRouteFor 读的。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [circuitOpen, currentSong, enabled, isFmMode, loopMode, navidrome, playQueue, playbackRoute, runtimeAvailable, shuffleRound, supported]);
}
