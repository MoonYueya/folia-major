import { getPlaybackSongKey } from './appPlaybackGuards';
import { resolvePlaybackSongArtist, resolvePlaybackSongCoverUrl } from './playbackSongMeta';
import type { SongResult, StageLoopMode } from '../types';
// src/utils/playbackNeighbors.ts
// 队列里「上一首 / 下一首」的规则只写在这里。前半是下标规则，都是纯函数（不碰 React、store、时钟），
// 切歌的 handler、now playing 卡片、automix、预取都调它们；
// 随机播放的那一份排列也在这里洗和走：洗的时候要哪个随机数由调用方给，这个文件自己不调 Math.random；
// 后半的 resolvePlaybackNeighbors 把下标变成界面要的邻居信息，「上一首 / 下一首能不能按」只由它回答
// （主窗口的箭头、遥控窗口与任务栏、舞台快照）。
// 「这首歌在队列里的第几个」（queueIndexOf）和「队列现在能不能打乱」（canShuffleQueue）也只写在这里。
//
// 一轮随机的**状态**（排列、签名、本轮历史）不住在这里，它在 usePlaybackStore 里
// （shuffleOrder / shuffleSignature / shuffleHistory）：切歌的 handler 是唯一的写入方，
// automix、预取、HiFi 无缝、浮动播放条读同一份，把它当参数传进来 ——
// utils 不依赖 store（dev/mcp/ts-code-map/codemap.mjs 的 BOUNDARY_RULES）。

/**
 * This song's index in the queue, -1 when it is not there; null counts as -1.
 * Compared by getPlaybackSongKey (platform plus track id), not by object: the same song restored from
 * the cache or re-sourced is another object. A song queued twice gives the earlier copy.
 */
export const queueIndexOf = (queue: SongResult[], song: SongResult | null | undefined): number => (
    song ? queueIndexOfKey(queue, getPlaybackSongKey(song)) : -1
);

/** Same as queueIndexOf, for the places that only track the key (the queue panel scrolls on the key, not the object). */
export const queueIndexOfKey = (queue: SongResult[], songKey: string | null): number => (
    songKey === null ? -1 : queue.findIndex(song => getPlaybackSongKey(song) === songKey)
);

/**
 * The index 「下一首」 would play, -1 when there is none.
 * With the current track off the queue (currentIndex -1) it is the head; on the last track only repeat-all
 * comes back to the head, and a queue of one returns itself. Single-track repeat counts as no repeat here.
 */
export const nextQueueIndex = (queueLength: number, currentIndex: number, loopMode: StageLoopMode): number => {
    if (queueLength <= 0) return -1;
    if (currentIndex < 0) return 0;
    if (currentIndex < queueLength - 1) return currentIndex + 1;
    // Shuffle rounds too, but along its own order (see the shuffleOrder* block below); answering by the
    // repeat-all rule here serves the callers that only ask 「后面还有没有」「能不能预读」.
    return loopMode === 'all' || loopMode === 'shuffle' ? 0 : -1;
};

/**
 * The index 「上一首」 would play, -1 when there is none.
 * Already at the head, or with the current track off the queue, only repeat-all goes to the tail; a queue of
 * one returns itself.
 */
export const prevQueueIndex = (queueLength: number, currentIndex: number, loopMode: StageLoopMode): number => {
    if (currentIndex > 0) return currentIndex - 1;
    return loopMode === 'all' || loopMode === 'shuffle' ? queueLength - 1 : -1;
};

/**
 * Which loop mode the index rules run under. Personal FM's queue neither wraps to the head nor jumps to the
 * tail (it fetches new tracks at the end), so FM always counts as no repeat; both song-change handlers,
 * 「跳过不能播的歌」 and resolvePlaybackNeighbors go through here first.
 */
export const queueLoopMode = (loopMode: StageLoopMode, isFmMode: boolean): StageLoopMode => (
    isFmMode ? 'off' : loopMode
);

/**
 * Whether another track follows the current one: more songs after it, or repeat-all with more than one queued.
 * false means the queue ends here. Two differences from nextQueueIndex: repeat-all over a queue of one does
 * not count (that is replaying itself), and an off-queue current track does not fall back to the head unless
 * repeat-all is on over more than one song.
 */
export const hasTrackAfter = (queueLength: number, currentIndex: number, loopMode: StageLoopMode): boolean => (
    (currentIndex >= 0 && currentIndex < queueLength - 1)
    || ((loopMode === 'all' || loopMode === 'shuffle') && queueLength > 1)
);

/**
 * The queue's order signature: every song's key, joined by position.
 * The shuffle order has to notice 「队列被改过没有」 (an add, a removal, a move, the shuffle command, another
 * playlist), and this is cheaper than the queue itself and more reliable than length and object identity:
 * swapping in a different song with the same key does not change the playback order.
 */
export const queueOrderSignature = (queue: SongResult[]): string => (
    queue.map(song => getPlaybackSongKey(song)).join('\u0001')
);

/**
 * One round of shuffle: an order over the queue's indices, with the current track first (it plays first - no
 * replay, no jump elsewhere). Fisher-Yates, every order equally likely; the random numbers come from the
 * caller (0 <= random() < 1) so the file itself never calls Math.random and a test can pin an order down.
 * With the current track off the queue (firstIndex -1) the whole queue is shuffled.
 */
export const buildShuffleOrder = (queueLength: number, firstIndex: number, random: () => number): number[] => {
    if (queueLength <= 0) return [];
    const rest: number[] = [];
    for (let index = 0; index < queueLength; index += 1) {
        if (index !== firstIndex) rest.push(index);
    }
    for (let i = rest.length - 1; i > 0; i -= 1) {
        const j = Math.min(i, Math.floor(random() * (i + 1)));
        const swapped = rest[i];
        rest[i] = rest[j];
        rest[j] = swapped;
    }
    return firstIndex >= 0 && firstIndex < queueLength ? [firstIndex, ...rest] : rest;
};

/**
 * The index after currentIndex INSIDE the order, wrapping to the order's start.
 * Shuffle keeps playing on, and the real 「一轮放完了要重洗」 belongs to the song-change handler; this only
 * answers where the next step lands. Not the same thing as nextPlayableShuffleIndexWithinRound below, which
 * stops at the round's end - hence the two different names.
 */
export const nextShuffleIndexWrapping = (order: readonly number[], currentIndex: number): number => {
    if (order.length === 0) return -1;
    const position = order.indexOf(currentIndex);
    return position < 0 ? order[0] : order[(position + 1) % order.length];
};

/**
 * The index before currentIndex inside the order, wrapping to the order's end.
 * Wrapping again, like its sibling, and only the fallback for 「上一首」: the real answer is the round's
 * history, because the order's last entry is a song this round has not played yet.
 */
export const prevShuffleIndexWrapping = (order: readonly number[], currentIndex: number): number => {
    if (order.length === 0) return -1;
    const position = order.indexOf(currentIndex);
    return position < 0 ? order[order.length - 1] : order[(position - 1 + order.length) % order.length];
};

/**
 * The next index after currentIndex that is still WITHIN this round, -1 once the round is over.
 * Wrapping back to the round's first track is wrong: the round has to be reshuffled instead, so the caller
 * has to know there is no next rather than be handed the beginning again.
 */
export const nextShuffleIndexWithinRound = (order: readonly number[], currentIndex: number): number => {
    const position = order.indexOf(currentIndex);
    return position < 0 || position >= order.length - 1 ? -1 : order[position + 1];
};

/**
 * The next playable index still within this round, -1 when there is none.
 * Only asks forward inside the round and stops at its end - a finished round is reshuffled, and replaying the
 * round's first track is not a valid answer. A queue of one gives itself, the same as repeat-all (replaying).
 */
export const nextPlayableShuffleIndexWithinRound = <T>(
    queue: T[],
    order: readonly number[],
    currentIndex: number,
    isPlayable: (song: T) => boolean,
): number => {
    if (order.length === 0) return -1;
    if (order.length === 1) return isPlayable(queue[order[0]]) ? order[0] : -1;

    const position = order.indexOf(currentIndex);
    const stepsLeft = position < 0 ? order.length : order.length - 1 - position;
    let index = currentIndex;
    for (let step = 0; step < stepsLeft; step += 1) {
        index = nextShuffleIndexWrapping(order, index);
        if (index < 0) return -1;
        if (isPlayable(queue[index])) return index;
    }
    return -1;
};

/** Find the next playable row without deleting unavailable entries or probing the network. */
export const nextPlayableQueueIndex = <T>(queue: T[], currentIndex: number, loopMode: StageLoopMode, isPlayable: (song: T) => boolean): number => {
    let index = currentIndex;
    for (let step = 0; step < queue.length; step++) {
        index = nextQueueIndex(queue.length, index, loopMode);
        if (index < 0) return -1;
        if (isPlayable(queue[index])) return index;
    }
    return -1;
};

/**
 * The next song after the current one that passes isPlayable, otherwise null.
 * Walks forward through nextQueueIndex, wrapping to the head under repeat-all and asking every other song once
 * (never back to the current one); with the current song off the queue there is nothing to look from.
 */
export const nextPlayableQueueSong = <T>(
    queue: T[],
    currentIndex: number,
    loopMode: StageLoopMode,
    isPlayable: (song: T) => boolean,
): T | null => {
    if (currentIndex < 0) return null;

    let index = currentIndex;
    for (let step = 1; step < queue.length; step += 1) {
        index = nextQueueIndex(queue.length, index, loopMode);
        if (index < 0) return null;
        if (isPlayable(queue[index])) return queue[index];
    }
    return null;
};

/**
 * Personal FM: fetch new tracks before stepping past this index (at the queue's last two, or for a current
 * track off the queue when there are fewer than two).
 */
export const fmNeedsTopUpAt = (queueLength: number, currentIndex: number): boolean => (
    currentIndex >= queueLength - 2
);

/** Personal FM: the next track after this index is not in the queue yet (it has to be fetched) - last track only. */
export const fmNextIsUnfetchedAt = (queueLength: number, currentIndex: number): boolean => (
    currentIndex >= 0 && currentIndex >= queueLength - 1
);

/**
 * Whether there is another song to jump to after a playback failure: the current track is in the queue and
 * another follows it (hasTrackAfter), or it is Personal FM's last track - then 「下一首」 goes fetching.
 */
export const hasTrackToSkipTo = (
    queueLength: number,
    currentIndex: number,
    loopMode: StageLoopMode,
    isFmMode: boolean,
): boolean => (
    currentIndex >= 0 && (
        hasTrackAfter(queueLength, currentIndex, loopMode)
        || (isFmMode && fmNextIsUnfetchedAt(queueLength, currentIndex))
    )
);

// ---- one round of shuffle: order, signature, history ----
//
// The three live in usePlaybackStore (shuffleOrder / shuffleSignature / shuffleHistory) and only the
// song-change handler writes them; automix, the prefetcher, HiFi gapless preload and the floating player's
// neighbours read the same copy. Before this the order lived in a ref inside usePlaybackQueueController, so
// every one of those consumers silently degraded: automix reported a queue end that was not there, the
// prefetcher cold-started on every shuffle change, gapless preload was switched off, and the floating player
// never had a title to show. The rules for using it are here; the state is not.

/** Where a played song sat in the queue. The key names the song, the index is the copy that was played. */
export type ShuffleHistoryEntry = {
    /** getPlaybackSongKey of the song. */
    key: string;
    /** Its queue index at the time. The real copy when the same song is queued twice. */
    index: number;
};

/** What a reader of a shuffle round needs: the order, and what this round has already played. */
export type ShuffleOrderView = {
    /** This round's order over queue indices; the track playing now is first. Empty when shuffle is off. */
    order: readonly number[];
    /** The positions this round has played, newest last. 「上一首」 pops from here. */
    history: readonly ShuffleHistoryEntry[];
};

/** One round of shuffle, as its owner (the store) holds it: the view plus the signature that keeps it honest. */
export type ShuffleRoundState = {
    order: number[];
    /** queueOrderSignature at the time the order was built. */
    signature: string;
    history: ShuffleHistoryEntry[];
};

/** A round with nothing in it: not in shuffle, just left shuffle, or an empty queue. */
export const emptyShuffleRound = (): ShuffleRoundState => ({ order: [], signature: '', history: [] });

/** How much of a round's history is kept: far more than a listener steps back through, and bounded. */
const MAX_SHUFFLE_HISTORY = 200;

const historyEntry = (queue: SongResult[], index: number): ShuffleHistoryEntry => ({
    key: getPlaybackSongKey(queue[index]),
    index,
});

const sameEntry = (entry: ShuffleHistoryEntry | undefined, other: ShuffleHistoryEntry): boolean => (
    entry !== undefined && entry.key === other.key && entry.index === other.index
);

/** Appends, keeping the array identity when nothing changed (the owner writes back only real changes). */
const pushHistory = (history: ShuffleHistoryEntry[], entry: ShuffleHistoryEntry): ShuffleHistoryEntry[] => (
    sameEntry(history[history.length - 1], entry) ? history : [...history, entry].slice(-MAX_SHUFFLE_HISTORY)
);

/**
 * Where that history entry sits in the queue now: its recorded index while that still holds the song - so a
 * song queued twice does not collapse onto the earlier copy - otherwise the first copy of its key, or -1 when
 * the song left the queue.
 */
const historyEntryIndex = (queue: SongResult[], entry: ShuffleHistoryEntry): number => {
    const at = queue[entry.index];
    if (at && getPlaybackSongKey(at) === entry.key) return entry.index;
    return queueIndexOfKey(queue, entry.key);
};

/**
 * The queue index the round is on: the newest history entry for this song wins (the real copy), and only a
 * song this round has never played falls back to looking its key up.
 */
export const shuffleCurrentQueueIndex = (
    queue: SongResult[],
    song: SongResult | null | undefined,
    history: readonly ShuffleHistoryEntry[],
): number => {
    if (!song) return -1;
    const key = getPlaybackSongKey(song);
    for (let cursor = history.length - 1; cursor >= 0; cursor -= 1) {
        if (history[cursor].key !== key) continue;
        const index = historyEntryIndex(queue, history[cursor]);
        if (index >= 0) return index;
    }
    return queueIndexOfKey(queue, key);
};

/**
 * The round to keep using for this queue and this track.
 * A queue that did not change keeps its order untouched (a song change must not reshuffle). A queue that did
 * change - an add, a removal, a drag, the shuffle command, another playlist - keeps this round's remaining part
 * reshuffled around the track playing now while the HISTORY is kept: 「上一首」 still has to find the song just
 * played, not the new order's last entry. History entries are re-indexed by key, so a song that left the queue
 * drops out of it.
 * Returns the same object when nothing changed, so the owner can write back only real changes.
 */
export const syncShuffleRound = (
    round: ShuffleRoundState,
    queue: SongResult[],
    currentSong: SongResult | null | undefined,
    random: () => number,
): ShuffleRoundState => {
    if (queue.length === 0) {
        return round.order.length === 0 && round.history.length === 0 ? round : emptyShuffleRound();
    }
    const signature = queueOrderSignature(queue);
    const currentIndex = shuffleCurrentQueueIndex(queue, currentSong, round.history);
    if (round.signature === signature) {
        // The signature is every key in order, so an equal one already implies an equal length: also comparing
        // the length could never be the deciding condition.
        if (currentIndex < 0) return round;
        const history = pushHistory(round.history, historyEntry(queue, currentIndex));
        return history === round.history ? round : { ...round, history };
    }
    const reindexed = round.history.map((entry) => {
        const index = historyEntryIndex(queue, entry);
        return index >= 0 ? { key: entry.key, index } : null;
    }).filter((entry): entry is ShuffleHistoryEntry => entry !== null);
    return {
        order: buildShuffleOrder(queue.length, currentIndex, random),
        signature,
        history: currentIndex >= 0 ? pushHistory(reindexed, historyEntry(queue, currentIndex)) : reindexed,
    };
};

/** One step of a shuffle round: the round to write back, and the index to play (-1: nothing in this round). */
export type ShuffleStep = {
    round: ShuffleRoundState;
    index: number;
};

/**
 * 下一首 in shuffle: the next song this round has not played. At the round's end it reshuffles first and starts
 * again, because shuffle never stops at the queue's end. The returned round always has the chosen song on top
 * of its history, so 「上一首」 can come back to it.
 */
export const stepShuffleRound = (
    state: ShuffleRoundState,
    queue: SongResult[],
    currentSong: SongResult | null | undefined,
    isPlayable: (song: SongResult) => boolean,
    random: () => number,
): ShuffleStep => {
    const round = syncShuffleRound(state, queue, currentSong, random);
    if (queue.length === 0 || round.order.length === 0) return { round, index: -1 };
    const currentIndex = shuffleCurrentQueueIndex(queue, currentSong, round.history);
    const position = round.order.indexOf(currentIndex);
    // The round is over (or the current track is not in it): reshuffle with this track first and keep the
    // history - the next song belongs to a new round, but 「上一首」 still has to reach back into the old one.
    const next = position < 0 || position >= round.order.length - 1
        ? { ...round, order: buildShuffleOrder(queue.length, currentIndex, random) }
        : round;
    const index = nextPlayableShuffleIndexWithinRound(queue, next.order, currentIndex, isPlayable);
    if (index < 0) return { round: next, index: -1 };
    return { round: { ...next, history: pushHistory(next.history, historyEntry(queue, index)) }, index };
};

/**
 * The index 「上一首」 goes back to in shuffle: the nearest song this round played before the one playing now
 * that is still in the queue. Read from the history only - the order's last entry is a song this round has NOT
 * played, and going there is exactly the bug where 「上一首」 landed on something the listener never heard.
 * -1 when this round has nothing before the current song.
 */
const shuffleBackIndex = (
    queue: SongResult[],
    currentIndex: number,
    history: readonly ShuffleHistoryEntry[],
): number => {
    const currentKey = currentIndex >= 0 ? getPlaybackSongKey(queue[currentIndex]) : null;
    let end = history.length;
    // The newest entry is the track playing now - or, right after picking another track by hand, that song's
    // predecessor and the whole history is fair game. Either way only the entries before it count.
    if (currentKey !== null && end > 0 && history[end - 1].key === currentKey) end -= 1;
    for (let cursor = end - 1; cursor >= 0; cursor -= 1) {
        const index = historyEntryIndex(queue, history[cursor]);
        if (index >= 0) return index;
    }
    return -1;
};

/**
 * The index 「上一首」 would go back to in shuffle, -1 when there is none. Shared with the neighbour labels, so
 * the arrow's title and what the press does cannot disagree.
 * With a history to read only the history answers; with none at all (a caller that handed us nothing but an
 * order) the positional rule stays as the fallback, because that is all there is to go by.
 */
export const prevShuffleQueueIndex = (
    queue: SongResult[],
    order: readonly number[],
    history: readonly ShuffleHistoryEntry[],
    currentIndex: number,
): number => (
    history.length > 0
        ? shuffleBackIndex(queue, currentIndex, history)
        : prevShuffleIndexWrapping(order, currentIndex)
);

/**
 * 上一首 in shuffle: pop the round's history. A queue edit inside the round does not touch that history, and
 * there is no fresh random draw - either would land the listener somewhere they have not been.
 * The returned round carries the popped history, so pressing 「上一首」 twice walks back twice.
 */
export const stepBackShuffleRound = (
    state: ShuffleRoundState,
    queue: SongResult[],
    currentSong: SongResult | null | undefined,
    random: () => number,
): ShuffleStep => {
    const round = syncShuffleRound(state, queue, currentSong, random);
    const currentIndex = shuffleCurrentQueueIndex(queue, currentSong, round.history);
    const index = prevShuffleQueueIndex(queue, round.order, round.history, currentIndex);
    if (index < 0) return { round, index };
    const currentKey = queue[currentIndex] ? getPlaybackSongKey(queue[currentIndex]) : null;
    const history = currentKey !== null && round.history[round.history.length - 1]?.key === currentKey
        ? round.history.slice(0, -1)
        : round.history;
    return { round: { ...round, history }, index };
};

// ---- the track a transition goes into ----

/** Why a transition has no target. The log names which one instead of blaming the queue for all of them. */
export type TransitionTargetReason =
    | 'ok'
    | 'queue-end'
    | 'shuffle-order-unknown'
    | 'shuffle-round-end'
    | 'fm-next-unfetched'
    | 'replay-current';

export type TransitionTarget = {
    song: SongResult | null;
    reason: TransitionTargetReason;
};

/**
 * The song the next transition would blend into, and why when there is none. automix blends into it and the
 * prefetcher puts it in the analysis scope.
 * Another song follows (hasTrackAfter) -> the nextQueueIndex one, wrapping to the head under repeat-all.
 * Personal FM's last track has none: its successor is fetched when the track ends and cannot be named before
 * that, and FM's queue does not wrap. Nothing is fetched here. A successor that is the same song as the
 * current one (queued twice) is not a transition either, it is a replay.
 * Shuffle answers from this round's order - the queue's next song is one that will not play. Without an order
 * it says so (shuffle-order-unknown) rather than reporting a queue end that does not exist.
 */
export const resolveTransitionTarget = (
    queue: SongResult[],
    currentSong: SongResult,
    loopMode: StageLoopMode,
    isFmMode: boolean,
    shuffleRound?: ShuffleOrderView | null,
): TransitionTarget => {
    const currentKey = getPlaybackSongKey(currentSong);
    // The shuffle guard comes first: this runs on every timeupdate, and finding the current track by key across
    // the whole queue only to throw the answer away is work for nothing.
    if (loopMode === 'shuffle' && !isFmMode) {
        const order = shuffleRound?.order ?? [];
        if (order.length === 0) return { song: null, reason: 'shuffle-order-unknown' };
        // The round's history knows which copy of a song queued twice is playing; without it the first copy is
        // the one meant.
        const currentIndex = shuffleCurrentQueueIndex(queue, currentSong, shuffleRound?.history ?? []);
        const position = order.indexOf(currentIndex);
        if (position < 0) return { song: null, reason: 'shuffle-order-unknown' };
        if (position >= order.length - 1) return { song: null, reason: 'shuffle-round-end' };
        const upcoming = queue[order[position + 1]] ?? null;
        return upcoming && getPlaybackSongKey(upcoming) !== currentKey
            ? { song: upcoming, reason: 'ok' }
            : { song: null, reason: 'replay-current' };
    }

    const index = queueIndexOfKey(queue, currentKey);
    if (isFmMode && fmNextIsUnfetchedAt(queue.length, index)) return { song: null, reason: 'fm-next-unfetched' };
    if (!hasTrackAfter(queue.length, index, loopMode)) return { song: null, reason: 'queue-end' };

    const next = queue[nextQueueIndex(queue.length, index, loopMode)] ?? null;
    return next && getPlaybackSongKey(next) !== currentKey
        ? { song: next, reason: 'ok' }
        : { song: null, reason: 'replay-current' };
};

/** resolveTransitionTarget's song alone, for the callers that only want to know what comes next. */
export const nextTransitionSong = (
    queue: SongResult[],
    currentSong: SongResult,
    loopMode: StageLoopMode,
    isFmMode: boolean,
    shuffleRound?: ShuffleOrderView | null,
): SongResult | null => resolveTransitionTarget(queue, currentSong, loopMode, isFmMode, shuffleRound).song;

/**
 * Whether the queue can be shuffled right now: not in Personal FM (the station keeps that queue going), the
 * stage is not driving playback, more than one song queued.
 * shuffleQueue asks it first; so do the shuffle buttons in the player bar and lattice, the command palette's
 * shuffle command and Folium's shuffleQueue. isStageActive is the caller's own 「舞台在播」: the handlers, the
 * player bar and lattice pass the now-playing stage, Folium passes any stage, and the command palette has no
 * such item and passes false.
 */
export const canShuffleQueue = (queueLength: number, isFmMode: boolean, isStageActive: boolean): boolean => (
    !isFmMode && !isStageActive && queueLength > 1
);

export type PlaybackNeighbor = {
    /** Whether that direction can be taken */
    canGo: boolean;
    /** Target song identity, on the same rules as the snapshot's trackKey, so the remote window recognises the pre-read face as the one after the change */
    key: string | null;
    /** Target song title; null when it can be taken but the target is unknown */
    title: string | null;
    /** Target song artist; the remote window renders the next track ahead */
    artist: string | null;
    /** Target song cover; the remote window warms the image and its colour ahead */
    coverUrl: string | null;
};

export type PlaybackNeighbors = {
    prev: PlaybackNeighbor;
    next: PlaybackNeighbor;
};

// Built fresh each time, never shared: the caller holds a plain object, and writing to it would poison every
// later result.
const unknownNeighbor = (): PlaybackNeighbor => ({ canGo: true, key: null, title: null, artist: null, coverUrl: null });
const blockedNeighbor = (): PlaybackNeighbor => ({ canGo: false, key: null, title: null, artist: null, coverUrl: null });

type ResolvePlaybackNeighborsParams = {
    playQueue: SongResult[];
    currentSong: SongResult | null;
    loopMode: StageLoopMode;
    isFmMode: boolean;
    isStageActive: boolean;
    /**
     * Whether to resolve the artist and the cover too. Those two go through provider metadata (a registry lookup
     * plus a fresh metadata object) and only the remote window, which pre-reads the next track, needs them; the
     * floating player reads canGo and the title only and does not pay for it by default.
     */
    withMetadata?: boolean;
    /**
     * This round of shuffle: the order, and which songs it has already played.
     * Shuffle mode without it can only say 「能跳」: the next song is decided by that order, and the queue's
     * order would name a different one. Every in-app caller reads it from usePlaybackStore
     * (readShuffleRound) - the state is not read here, because utils may not depend on stores.
     */
    shuffleRound?: ShuffleOrderView | null;
};

/**
 * Works out whether prev/next can be taken and the target's title, artist and cover, on the same index rules
 * as handlePrevTrack / handleNextTrack in usePlaybackQueueController.
 * Personal FM on the queue's last track will fetch a new track, so canGo is true while the target is unknown;
 * FM's queue does not wrap, so FM's first track has no previous one.
 * canGo true means the handler will try when pressed; the main window's arrows, the remote window and the
 * taskbar (playbackSyncBridge) and the queue operations' snapshots all read it from here.
 * It is wrong in two places: FM's last track with a failed fetch does nothing when pressed, which cannot be
 * known in advance; and mid-transition the handler counts from the track on screen while this counts from the
 * currentSong it was given, which is off by one song when that is the store's.
 */
export const resolvePlaybackNeighbors = ({
    playQueue,
    currentSong,
    loopMode,
    isFmMode,
    isStageActive,
    withMetadata = false,
    shuffleRound,
}: ResolvePlaybackNeighborsParams): PlaybackNeighbors => {
    // Both handlers return immediately while the stage is playing, so the arrows have to be disabled in step,
    // or pressing them does nothing
    if (isStageActive || !currentSong || playQueue.length === 0) {
        return { prev: blockedNeighbor(), next: blockedNeighbor() };
    }

    const neighborAt = (index: number): PlaybackNeighbor => {
        const song = playQueue[index] ?? null;
        return {
            canGo: true,
            key: song ? getPlaybackSongKey(song) : null,
            title: song?.name ?? null,
            artist: withMetadata ? resolvePlaybackSongArtist(song) : null,
            coverUrl: withMetadata ? resolvePlaybackSongCoverUrl(song) : null,
        };
    };

    const indexLoopMode = queueLoopMode(loopMode, isFmMode);

    // Shuffle goes by this round's order, not the queue's order (see the shuffleOrder* block).
    if (indexLoopMode === 'shuffle') {
        const order = shuffleRound?.order ?? [];
        if (order.length === 0) {
            return { prev: unknownNeighbor(), next: unknownNeighbor() };
        }
        const history = shuffleRound?.history ?? [];
        const currentIndex = shuffleCurrentQueueIndex(playQueue, currentSong, history);
        const position = order.indexOf(currentIndex);
        const prevIndex = prevShuffleQueueIndex(playQueue, order, history, currentIndex);
        const nextIndex = nextShuffleIndexWrapping(order, currentIndex);
        // At the round's end the order is reshuffled before the next song is picked, so who it is cannot be
        // known yet: the arrow can be taken, the title cannot be filled in.
        const nextIsUnknown = position < 0 || position >= order.length - 1;
        return {
            prev: prevIndex >= 0 ? neighborAt(prevIndex) : blockedNeighbor(),
            next: nextIsUnknown || nextIndex < 0 ? unknownNeighbor() : neighborAt(nextIndex),
        };
    }

    const currentIndex = queueIndexOf(playQueue, currentSong);
    const prevIndex = prevQueueIndex(playQueue.length, currentIndex, indexLoopMode);
    const nextIndex = nextQueueIndex(playQueue.length, currentIndex, indexLoopMode);

    // Personal FM on the queue's last track appends a new one and then jumps, so the title is unknowable here
    const fmWillFetch = isFmMode && fmNextIsUnfetchedAt(playQueue.length, currentIndex);

    return {
        prev: prevIndex >= 0 ? neighborAt(prevIndex) : blockedNeighbor(),
        next: fmWillFetch
            ? unknownNeighbor()
            : nextIndex >= 0
                ? neighborAt(nextIndex)
                : blockedNeighbor(),
    };
};
