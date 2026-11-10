import { useMemo } from 'react';
import type { SongResult, StageLoopMode } from '../../../types';
import type { PlaybackRoute } from '../../../types/hifi';
import { omni } from '../../../services/onlineMusic/omni';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import {
    nextQueueIndex,
    nextShuffleIndexWithinRound,
    queueIndexOf,
    queueLoopMode,
    shuffleCurrentQueueIndex,
    type ShuffleOrderView,
} from '../../../utils/playbackNeighbors';

// src/components/app/playback/externalPlaybackGate.ts
// Automix blends two of the app's own <audio> decks. A track that sounds in a provider's player
// outside the app has no deck to blend into, so a blend must not be armed into it. This is the
// same "is the next track one the decks cannot sound" question the HiFi gate asks, asked of the
// `externalPlayback` capability instead of the HiFi settings.

type IsExternalSong = (song: SongResult) => boolean;

export type ExternalAutomixGateInput = {
    playbackRoute: PlaybackRoute;
    playQueue: SongResult[];
    currentSong: SongResult | null;
    loopMode: StageLoopMode;
    isFmMode: boolean;
    /** This round's shuffle order and history (the copy usePlaybackStore holds); absent when not shuffling. */
    shuffleRound?: ShuffleOrderView | null;
};

/**
 * Whether the external player blocks a blend: it is sounding now, or the current song or the next
 * one (the same index rules `handleNextTrack` follows, no wrap in Personal FM) is its song.
 * While shuffling, the next one is the song this round's order puts next, not the queue's next: taking
 * the queue order would arm a blend into a song that never plays and skip the one that does.
 */
export const externalBlocksAutomix = (
    { playbackRoute, playQueue, currentSong, loopMode, isFmMode, shuffleRound }: ExternalAutomixGateInput,
    isExternal: IsExternalSong = omni.canPlayExternally,
): boolean => {
    if (playbackRoute === 'external') return true;
    if (currentSong && isExternal(currentSong)) return true;
    const nextIndex = loopMode === 'shuffle' && !isFmMode
        ? nextShuffleIndexWithinRound(shuffleRound?.order ?? [], shuffleCurrentQueueIndex(playQueue, currentSong, shuffleRound?.history ?? []))
        : nextQueueIndex(playQueue.length, queueIndexOf(playQueue, currentSong), queueLoopMode(loopMode, isFmMode));
    return nextIndex >= 0 && isExternal(playQueue[nextIndex]);
};

export function useExternalAutomixGate(): boolean {
    const playbackRoute = usePlaybackStore(state => state.playbackRoute);
    const playQueue = usePlaybackStore(state => state.playQueue);
    const currentSong = usePlaybackStore(state => state.currentSong);
    const isFmMode = usePlaybackStore(state => state.isFmMode);
    const loopMode = useAudioSettingsStore(state => state.loopMode);
    // The shuffle round decides which song is next, so a reshuffle or a re-anchored round re-judges the gate.
    const shuffleOrder = usePlaybackStore(state => state.shuffleOrder);
    const shuffleHistory = usePlaybackStore(state => state.shuffleHistory);
    const shuffleRound = useMemo(() => ({ order: shuffleOrder ?? [], history: shuffleHistory }), [shuffleOrder, shuffleHistory]);
    return useMemo(
        () => externalBlocksAutomix({ playbackRoute, playQueue, currentSong, loopMode, isFmMode, shuffleRound }),
        [currentSong, isFmMode, loopMode, playQueue, playbackRoute, shuffleRound],
    );
}
