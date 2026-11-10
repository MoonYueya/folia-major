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
    nextQueueIndex, nextShuffleIndexWithinRound, queueIndexOf, queueLoopMode, shuffleCurrentQueueIndex,
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
 */
export const hifiBlocksAutomix = (
    { playbackRoute, playQueue, currentSong, loopMode, isFmMode, shuffleRound }: HifiAutomixGateInput,
    routeFor: RouteFor = hifiRouteFor,
): boolean => {
    if (playbackRoute === 'hifi') return true;
    if (routesHifi(currentSong, routeFor)) return true;
    // 随机模式的下一首是这一轮排列里的那一首（handleNextTrack 也照它切），不是队列顺序里的
    // 下一首 —— 按队列顺序判会关掉一次本该发生的过渡，或者放过一次本该关掉的。
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
    // 这一轮随机的排列：它一变（重洗、队列改了重锚）下一首就可能换成另一首，所以订阅它。
    const shuffleOrder = usePlaybackStore(state => state.shuffleOrder);
    const shuffleHistory = usePlaybackStore(state => state.shuffleHistory);
    const loopMode = useAudioSettingsStore(state => state.loopMode);
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
