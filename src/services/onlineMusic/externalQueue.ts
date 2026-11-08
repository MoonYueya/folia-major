import type { SongResult, StageLoopMode } from '../../types';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { nextQueueIndex, queueIndexOf } from '../../utils/playbackNeighbors';

// Select only contiguous, distinct successors belonging to the current external provider. `most`
// is how far ahead to look: a player that keeps a tail of its own picks how many of these it wants.
export function externalQueueSuccessors(song: SongResult, queue: SongResult[], mode: StageLoopMode, isFm: boolean, isPlayable: (song: SongResult) => boolean = () => true, most = 2): SongResult[] {
    // Shuffle hands over nothing as well: the next song is this round's order, which this file does not have,
    // and precarrying the queue's natural successor would put a track Folia did not choose into the other
    // player's own up-next - it would start on that song by itself. Precarrying nothing beats the wrong song.
    if (mode === 'one' || mode === 'shuffle' || isFm || song.sourceRef?.kind !== 'online') return [];
    let index = queueIndexOf(queue, song);
    if (index < 0) return [];
    const seen = new Set([getPlaybackSongKey(song)]);
    const result: SongResult[] = [];
    for (let count = 0; count < queue.length && result.length < most; count++) {
        index = nextQueueIndex(queue.length, index, mode);
        const next = queue[index];
        if (!next || next.sourceRef?.kind !== 'online' || next.sourceRef.providerId !== song.sourceRef.providerId
            || seen.has(getPlaybackSongKey(next))) break;
        if (!isPlayable(next)) continue;
        result.push(next);
        seen.add(getPlaybackSongKey(next));
    }
    return result;
}
