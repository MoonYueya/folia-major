import type { SongResult, StageLoopMode } from '../../types';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { nextQueueIndex, nextShuffleIndexWrapping, queueIndexOf, shuffleCurrentQueueIndex, type ShuffleOrderView } from '../../utils/playbackNeighbors';

// Select only contiguous, distinct successors belonging to the current external provider. `most`
// is how far ahead to look: a player that keeps a tail of its own picks how many of these it wants.
export function externalQueueSuccessors(song: SongResult, queue: SongResult[], mode: StageLoopMode, isFm: boolean, isPlayable: (song: SongResult) => boolean = () => true, most = 2, shuffleRound?: ShuffleOrderView | null): SongResult[] {
    if (mode === 'one' || isFm || song.sourceRef?.kind !== 'online') return [];
    // Shuffle precarries along this round's order, not the queue's: handing over the queue's natural successor
    // would put a track Folia never chose into the other player's own up-next, and it would start on that song by
    // itself. The order comes in as a parameter - utils may not depend on stores, and this file may not either.
    // No order at all (the remote window, the taskbar, snapshots) means nothing is precarried: an empty hand-over
    // costs one cold start per track, a wrong song costs the queue.
    const order = mode === 'shuffle' ? shuffleRound?.order ?? [] : [];
    if (mode === 'shuffle' && order.length === 0) return [];
    let index = mode === 'shuffle'
        ? shuffleCurrentQueueIndex(queue, song, shuffleRound?.history ?? [])
        : queueIndexOf(queue, song);
    if (index < 0) return [];
    const seen = new Set([getPlaybackSongKey(song)]);
    const result: SongResult[] = [];
    for (let count = 0; count < queue.length && result.length < most; count++) {
        index = mode === 'shuffle' ? nextShuffleIndexWrapping(order, index) : nextQueueIndex(queue.length, index, mode);
        const next = queue[index];
        if (!next || next.sourceRef?.kind !== 'online' || next.sourceRef.providerId !== song.sourceRef.providerId
            || seen.has(getPlaybackSongKey(next))) break;
        if (!isPlayable(next)) continue;
        result.push(next);
        seen.add(getPlaybackSongKey(next));
    }
    return result;
}
