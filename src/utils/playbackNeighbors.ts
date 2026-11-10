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
// 一轮随机的状态（排列、签名、本轮历史）不住在这里，它在 usePlaybackStore 里
// （shuffleOrder / shuffleSignature / shuffleHistory）：切歌的 handler 是唯一的写入方，
// automix、预取、HiFi 无缝、浮动播放条读同一份，把它当参数传进来 ——
// utils 不依赖 store（dev/mcp/ts-code-map/codemap.mjs 的 BOUNDARY_RULES）。

/**
 * 这首歌在队列里的下标，不在则 -1；没有歌（null）也是 -1。
 * 按 getPlaybackSongKey 比（平台加曲目 id），不按对象比：同一首歌从缓存恢复或换过来源之后是另一个对象。
 * 同一首歌在队列里排了两次时给的是前面那一个。
 */
export const queueIndexOf = (queue: SongResult[], song: SongResult | null | undefined): number => (
    song ? queueIndexOfKey(queue, getPlaybackSongKey(song)) : -1
);

/** 同 queueIndexOf，给手里只有 key 的地方用（队列面板的自动滚动只跟着 key 变，不跟着对象变）。 */
export const queueIndexOfKey = (queue: SongResult[], songKey: string | null): number => (
    songKey === null ? -1 : queue.findIndex(song => getPlaybackSongKey(song) === songKey)
);

/**
 * 「下一首」会播的下标，没有则 -1。
 * 当前曲目不在队列里（currentIndex 为 -1）时是队首；停在最后一首时只有列表循环才回到队首，
 * 队列只有一首时回到的就是它自己。单曲循环在这里和不循环一样。
 */
export const nextQueueIndex = (queueLength: number, currentIndex: number, loopMode: StageLoopMode): number => {
    if (queueLength <= 0) return -1;
    if (currentIndex < 0) return 0;
    if (currentIndex < queueLength - 1) return currentIndex + 1;
    // 随机模式也绕圈，但它走的是自己那份排列（见 shuffleOrder* 那几个）；这里按列表循环答，
    // 是给「后面还有没有」「能不能预读」这类只关心有没有下一首的地方用的。
    return loopMode === 'all' || loopMode === 'shuffle' ? 0 : -1;
};

/**
 * 「上一首」会播的下标，没有则 -1。
 * 已在队首、或当前曲目不在队列里时，只有列表循环才跳到队尾，队列只有一首时就是它自己。
 */
export const prevQueueIndex = (queueLength: number, currentIndex: number, loopMode: StageLoopMode): number => {
    if (currentIndex > 0) return currentIndex - 1;
    return loopMode === 'all' || loopMode === 'shuffle' ? queueLength - 1 : -1;
};

/**
 * 切歌时下标规则按哪种循环模式算。私人 FM 的队列不绕回队首也不跳到队尾（到头是去拉新曲目），
 * 所以 FM 里一律按不循环算；切歌的两个 handler、「跳过不能播的歌」和 resolvePlaybackNeighbors 都先过这里。
 */
export const queueLoopMode = (loopMode: StageLoopMode, isFmMode: boolean): StageLoopMode => (
    isFmMode ? 'off' : loopMode
);

/**
 * 当前曲目之后还有没有另一首：后面还有歌，或者列表循环且队列不止一首。false 即队列在这里到头。
 * 和 nextQueueIndex 有两处不同：只有一首的列表循环不算（那是重播自己）；
 * 当前曲目不在队列里时不退回队首，只有列表循环且队列不止一首才算。
 */
export const hasTrackAfter = (queueLength: number, currentIndex: number, loopMode: StageLoopMode): boolean => (
    (currentIndex >= 0 && currentIndex < queueLength - 1)
    || ((loopMode === 'all' || loopMode === 'shuffle') && queueLength > 1)
);

/**
 * 队列的顺序签名：每首的 key 按位置连起来。
 * 随机播放的那份排列要认「队列被改过没有」（增删、移动、命令式打乱、换歌单），
 * 比整份队列便宜，也比长度和对象身份可靠：换一首同 key 的歌不改播放顺序。
 */
export const queueOrderSignature = (queue: SongResult[]): string => (
    queue.map(song => getPlaybackSongKey(song)).join('\u0001')
);

/**
 * 随机播放的一轮：队列下标的一个排列，当前这首排在最前（第一首就放它，不重播也不跳到别处）。
 * 洗牌用 Fisher–Yates，每个排列等可能；随机数由调用方给（0 ≤ random() < 1），
 * 这个文件不调 Math.random，测试才能给定序列把排列钉死。
 * 当前曲不在队列里（firstIndex 为 -1）时整份打乱。
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
 * 排列里 currentIndex 的下一个下标，走到排列末尾绕回排列开头，没有排列则 -1。
 * 随机模式一直往下放，真正的「一轮放完了要重洗」由切歌的 handler 决定，这里只答下一步走到哪。
 * 和下面 nextShuffleIndexWithinRound 不是一回事：那个到排列末尾就停，所以两个名字分开。
 */
export const nextShuffleIndexWrapping = (order: readonly number[], currentIndex: number): number => {
    if (order.length === 0) return -1;
    const position = order.indexOf(currentIndex);
    return position < 0 ? order[0] : order[(position + 1) % order.length];
};

/**
 * 排列里 currentIndex 的上一个下标，走到排列开头绕回排列末尾，没有排列则 -1。
 * 和它的兄弟一样是个绕圈的规则，而且只是「上一首」的兜底：真正的答案在这一轮的历史里，
 * 因为排列末位是这一轮还没放过的歌。
 */
export const prevShuffleIndexWrapping = (order: readonly number[], currentIndex: number): number => {
    if (order.length === 0) return -1;
    const position = order.indexOf(currentIndex);
    return position < 0 ? order[order.length - 1] : order[(position - 1 + order.length) % order.length];
};

/**
 * 这一轮里 currentIndex 紧接着的下一个下标，走到排列末尾就是 -1（一轮结束了）。
 * 绕回这一轮开头那首是不对的：那时该重洗，所以调用方要能知道「没有下一首」，
 * 而不是被递给一个开头。
 */
export const nextShuffleIndexWithinRound = (order: readonly number[], currentIndex: number): number => {
    const position = order.indexOf(currentIndex);
    return position < 0 || position >= order.length - 1 ? -1 : order[position + 1];
};

/**
 * 随机模式下这一轮里下一首能播的下标，没有则 -1。
 * 只在这一轮里往后问：走到排列末尾就停下 —— 一轮放完要重洗，绕回去放这一轮开头那首是不对的。
 * 只有一首的队列给的是它自己，和列表循环一样（那是重播自己）。
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
 * 当前曲目之后第一首通过 isPlayable 的歌，没有则 null。
 * 按 nextQueueIndex 一首一首往后找，列表循环时绕回队首接着找，其余的歌都问过一遍为止
 * （不会回到当前曲目）；当前曲目不在队列里时不找。
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
 * 私人 FM：从这个下标按「下一首」之前要先去拉新曲目 —— 走到队列最后两首时
 * （队列不足两首时，不在队列里的曲目也算）。
 */
export const fmNeedsTopUpAt = (queueLength: number, currentIndex: number): boolean => (
    currentIndex >= queueLength - 2
);

/** 私人 FM：这个下标的下一首此刻还不在队列里（要等拉回来）—— 只有队列最后一首。 */
export const fmNextIsUnfetchedAt = (queueLength: number, currentIndex: number): boolean => (
    currentIndex >= 0 && currentIndex >= queueLength - 1
);

/**
 * 播放失败之后有没有另一首可以跳过去：当前曲目在队列里，并且后面还有另一首（hasTrackAfter），
 * 或者它是私人 FM 的最后一首 —— 那时「下一首」会去拉新曲目。
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

// ---- 一轮随机：排列、签名、本轮历史 ----
//
// 这三样住在 usePlaybackStore（shuffleOrder / shuffleSignature / shuffleHistory），只有切歌的 handler 写它们；
// automix、预取、HiFi 无缝、浮动播放条的邻居读的也是同一份。在这之前排列是
// usePlaybackQueueController 里的一个 ref，那几个消费者谁也读不到，于是各自静默退化：
// automix 报了一个并不存在的队列到头，预取每次随机变化都冷启动，HiFi 无缝干脆关掉，
// 浮动播放条连标题都没有。这里写的是怎么用这一份，状态不在这里。

/** 放过的一首在队列里坐哪儿。key 认歌，index 认放过的那一个副本。 */
export type ShuffleHistoryEntry = {
    /** 这首歌的 getPlaybackSongKey。 */
    key: string;
    /** 放它的时候它在队列里的下标。同一首排了两次时给的是真正放的那个副本。 */
    index: number;
};

/** 读这一轮需要的东西：排列，以及这一轮已经放过哪些。 */
export type ShuffleOrderView = {
    /** 这一轮对队列下标的一个排列，此刻这首在最前。不在随机时为空。 */
    order: readonly number[];
    /** 这一轮放过的位置，越晚越靠后。「上一首」从这里弹。 */
    history: readonly ShuffleHistoryEntry[];
};

/** 一轮随机在它的主人（store）那边长什么样：读的那一面，再加上用来盯住它的签名。 */
export type ShuffleRoundState = {
    order: number[];
    /** 洗这份排列时的 queueOrderSignature。 */
    signature: string;
    history: ShuffleHistoryEntry[];
};

/** 一轮空随机：不在随机、刚离开随机，或者队列是空的。 */
export const emptyShuffleRound = (): ShuffleRoundState => ({ order: [], signature: '', history: [] });

/** 一轮历史留多长：比听众往回走的距离大得多，而且有上限。 */
const MAX_SHUFFLE_HISTORY = 200;

const historyEntry = (queue: SongResult[], index: number): ShuffleHistoryEntry => ({
    key: getPlaybackSongKey(queue[index]),
    index,
});

const sameEntry = (entry: ShuffleHistoryEntry | undefined, other: ShuffleHistoryEntry): boolean => (
    entry !== undefined && entry.key === other.key && entry.index === other.index
);

/** 往后追加；什么都没变时保持数组身份（主人只在真变化时才写回）。 */
const pushHistory = (history: ShuffleHistoryEntry[], entry: ShuffleHistoryEntry): ShuffleHistoryEntry[] => (
    sameEntry(history[history.length - 1], entry) ? history : [...history, entry].slice(-MAX_SHUFFLE_HISTORY)
);

/**
 * 那条历史记录现在坐在队列的哪儿：记下的下标还指着同一首歌就用它 —— 同一首排了两次时不会塌到前一个副本上；
 * 否则按 key 找第一个副本，歌已经不在队列里时给 -1。
 */
const historyEntryIndex = (queue: SongResult[], entry: ShuffleHistoryEntry): number => {
    const at = queue.at(entry.index);
    if (at !== undefined && getPlaybackSongKey(at) === entry.key) return entry.index;
    return queueIndexOfKey(queue, entry.key);
};

/**
 * 这一轮走到队列的哪个下标：这首歌最新的一条历史记录说了算（那才是真正放的那个副本），
 * 只有这一轮没放过的歌才退回按 key 找。
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
 * 这个队列、这首歌该继续用哪一轮。
 * 队列没变时原样留着排列（换一首歌不许重洗）。队列变了 —— 增删、拖动、命令式打乱、换歌单 ——
 * 就把本轮剩下的部分围绕此刻这首重洗，而历史留着：「上一首」要回得到的还是刚放过那首，
 * 不是新排列的末位。历史记录按 key 重新定位，所以离开队列的歌会从里面掉出去。
 * 什么都没变时返回同一个对象，主人因此只在真变化时才写回。
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
        // 签名是每首的 key 按位置连起来的，所以签名相等已经蕴含长度相等：再比长度永远当不了判决条件。
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

/** 走一步随机：要写回的那一轮，要播的下标（-1：这一轮没得播）。 */
export type ShuffleStep = {
    round: ShuffleRoundState;
    index: number;
};

/**
 * 随机里的「下一首」：这一轮还没放过的一首。走到排列末尾先重洗再重新开始，
 * 因为随机不会停在队列尽头。返回的那一轮一定把选中的歌压在历史最上面，
 * 「上一首」才回得到它。
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
    // 这一轮放完了（或当前曲不在排列里）：以此刻这首为起点重洗，历史留着 ——
    // 下一首属于新一轮，但「上一首」还得回得到上一轮里去。
    const next = position < 0 || position >= round.order.length - 1
        ? { ...round, order: buildShuffleOrder(queue.length, currentIndex, random) }
        : round;
    const index = nextPlayableShuffleIndexWithinRound(queue, next.order, currentIndex, isPlayable);
    if (index < 0) return { round: next, index: -1 };
    // 历史没变就把那一轮原样递回去，主人因此分得清「什么都没变」和「真走了一步」。
    const history = pushHistory(next.history, historyEntry(queue, index));
    return { round: history === next.history ? next : { ...next, history }, index };
};

/**
 * 随机里「上一首」退到队列的哪个下标：这一轮在此刻这首之前放过的、还在队列里的最近那一首。
 * 只读历史 —— 排列末位是这一轮还没放过的歌，走到那儿正是「上一首落在听众没听过的地方」那个 bug。
 * 这一轮在当前这首之前什么都没有时给 -1。
 */
const shuffleBackIndex = (
    queue: SongResult[],
    currentIndex: number,
    history: readonly ShuffleHistoryEntry[],
): number => {
    const currentKey = currentIndex >= 0 ? getPlaybackSongKey(queue[currentIndex]) : null;
    let end = history.length;
    // 最新那条是此刻这首 —— 或者，手动点过队列里另一首之后，是那首歌的前一首，整份历史都能用。
    // 两种情况都只有它之前的记录算数。
    if (currentKey !== null && end > 0 && history[end - 1].key === currentKey) end -= 1;
    for (let cursor = end - 1; cursor >= 0; cursor -= 1) {
        const index = historyEntryIndex(queue, history[cursor]);
        if (index >= 0) return index;
    }
    return -1;
};

/**
 * 随机里「上一首」会退到的下标，没有则 -1。邻里的标题也用它，箭头写的和按下去做的不会是两回事。
 * 有历史时只由历史回答；完全没有历史（调用方只递了一份排列过来）时退回按排列位置算，
 * 因为那时手上只有这个。
 */
export const prevShuffleIndexFromRound = (
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
 * 随机里的「上一首」：把这一轮的历史弹出去。一轮中间的队列编辑不动这份历史，
 * 也不临时再抽一次随机 —— 两样都会把听众丢到没去过的地方。
 * 返回的那一轮带着弹过的历史，所以连按两次就退两首。
 */
export const stepBackShuffleRound = (
    state: ShuffleRoundState,
    queue: SongResult[],
    currentSong: SongResult | null | undefined,
    random: () => number,
): ShuffleStep => {
    const round = syncShuffleRound(state, queue, currentSong, random);
    const currentIndex = shuffleCurrentQueueIndex(queue, currentSong, round.history);
    const index = prevShuffleIndexFromRound(queue, round.order, round.history, currentIndex);
    if (index < 0) return { round, index };
    const currentKey = queue[currentIndex] ? getPlaybackSongKey(queue[currentIndex]) : null;
    const history = currentKey !== null && round.history[round.history.length - 1]?.key === currentKey
        ? round.history.slice(0, -1)
        : round.history;
    return { round: history === round.history ? round : { ...round, history }, index };
};

// ---- 过渡要混进去的那一首 ----

/** 过渡为什么没有目标。日志按原因分开说，不再把几种情况都算成队列到头。 */
export type TransitionTargetReason =
    | 'ok'
    | 'queue-end'
    | 'shuffle-order-unknown'
    | 'shuffle-current-not-in-order'
    | 'shuffle-round-end'
    | 'fm-next-unfetched'
    | 'replay-current';

export type TransitionTarget = {
    song: SongResult | null;
    reason: TransitionTargetReason;
};

/**
 * 下一段过渡会混进去的那一首，没有时说明是哪一种没有。automix 混向它，预取把它放进分析范围。
 * 后面还有另一首（hasTrackAfter）时是 nextQueueIndex 那一首，列表循环时从最后一首绕回队首。
 * 私人 FM 的最后一首没有：下一首要现拉，还叫不出名字的曲目没法提前测量，FM 的队列也不绕回队首。
 * 这里不去拉。下一首和当前曲目是同一首歌（队列里排了两次）时也没有：那是重播，不是过渡。
 * 随机按这一轮的排列回答 —— 队列里的下一首是一首不会播的歌。没有排列时如实说没有排列
 * （shuffle-order-unknown），有排列但排列里没有这一首时说的是另一回事（shuffle-current-not-in-order），
 * 两者都不报一个根本不存在的队列到头。
 */
export const resolveTransitionTarget = (
    queue: SongResult[],
    currentSong: SongResult,
    loopMode: StageLoopMode,
    isFmMode: boolean,
    shuffleRound?: ShuffleOrderView | null,
): TransitionTarget => {
    const currentKey = getPlaybackSongKey(currentSong);
    // 随机的判断放在最前面：这个函数每次 timeupdate 都跑，为了一个要丢掉的答案去把整个队列按 key 走一遍，
    // 是白做的活。
    if (loopMode === 'shuffle' && !isFmMode) {
        const order = shuffleRound?.order ?? [];
        if (order.length === 0) return { song: null, reason: 'shuffle-order-unknown' };
        // 排了两次时历史知道此刻是哪一个副本；没有历史时按前一个副本算。
        const currentIndex = shuffleCurrentQueueIndex(queue, currentSong, shuffleRound?.history ?? []);
        const position = order.indexOf(currentIndex);
        // 有排列、只是排列里没有这一首 —— 这和「没有排列」是两回事，排查时指向的方向也不同。
        if (position < 0) return { song: null, reason: 'shuffle-current-not-in-order' };
        if (position >= order.length - 1) return { song: null, reason: 'shuffle-round-end' };
        const upcoming = queue.at(order[position + 1]) ?? null;
        return upcoming && getPlaybackSongKey(upcoming) !== currentKey
            ? { song: upcoming, reason: 'ok' }
            : { song: null, reason: 'replay-current' };
    }

    const index = queueIndexOfKey(queue, currentKey);
    if (isFmMode && fmNextIsUnfetchedAt(queue.length, index)) return { song: null, reason: 'fm-next-unfetched' };
    if (!hasTrackAfter(queue.length, index, loopMode)) return { song: null, reason: 'queue-end' };

    const next = queue.at(nextQueueIndex(queue.length, index, loopMode)) ?? null;
    return next && getPlaybackSongKey(next) !== currentKey
        ? { song: next, reason: 'ok' }
        : { song: null, reason: 'replay-current' };
};

/** 只要 resolveTransitionTarget 里那首歌，给只想知道下一首是谁的调用方。 */
export const nextTransitionSong = (
    queue: SongResult[],
    currentSong: SongResult,
    loopMode: StageLoopMode,
    isFmMode: boolean,
    shuffleRound?: ShuffleOrderView | null,
): SongResult | null => resolveTransitionTarget(queue, currentSong, loopMode, isFmMode, shuffleRound).song;

/**
 * 队列现在能不能打乱：不在私人 FM 里（FM 的队列由电台续上），舞台没有接管播放，队列不止一首。
 * shuffleQueue 自己先问它；播放条和 lattice 的打乱按钮、命令面板的「打乱队列」、Folium 的 shuffleQueue 问的也是它。
 * isStageActive 是调用方知道的那个「舞台在播」：handler、播放条和 lattice 给的是 now playing 舞台，
 * Folium 给的是任何舞台，命令面板的上下文里没有这一项，给的是 false。
 */
export const canShuffleQueue = (queueLength: number, isFmMode: boolean, isStageActive: boolean): boolean => (
    !isFmMode && !isStageActive && queueLength > 1
);

export type PlaybackNeighbor = {
    /** 该方向是否可以跳转 */
    canGo: boolean;
    /** 目标曲目标识；与快照里的 trackKey 同一套规则，便于遥控窗口把预读的面和切歌后的面认成同一个 */
    key: string | null;
    /** 目标曲目标题；可跳但目标未知时为 null */
    title: string | null;
    /** 目标曲目艺术家；用于遥控窗口提前渲染下一首 */
    artist: string | null;
    /** 目标曲目封面；用于遥控窗口提前预热图片与取色 */
    coverUrl: string | null;
};

export type PlaybackNeighbors = {
    prev: PlaybackNeighbor;
    next: PlaybackNeighbor;
};

// 每次现造，不共享实例：调用方拿到的是普通对象，写一下就会污染后续所有结果
const unknownNeighbor = (): PlaybackNeighbor => ({ canGo: true, key: null, title: null, artist: null, coverUrl: null });
const blockedNeighbor = (): PlaybackNeighbor => ({ canGo: false, key: null, title: null, artist: null, coverUrl: null });

type ResolvePlaybackNeighborsParams = {
    playQueue: SongResult[];
    currentSong: SongResult | null;
    loopMode: StageLoopMode;
    isFmMode: boolean;
    isStageActive: boolean;
    /**
     * 是否连艺术家与封面一起解析。这两项要走 provider 元数据（注册表查找 + 新建元数据对象），
     * 只有需要预读下一首的遥控窗口用得上；浮动播放条只读 canGo 与 title，默认不付这份开销。
     */
    withMetadata?: boolean;
    /**
     * 这一轮随机：排列，以及这一轮已经放过哪些。
     * 随机模式拿不到它时只能答「能跳」：下一首由那份排列决定，按队列顺序算出来的是另一首。
     * 应用内的调用方都从 usePlaybackStore（readShuffleRound）读，这里不读 —— utils 不许依赖 store。
     */
    shuffleRound?: ShuffleOrderView | null;
};

/**
 * 按 usePlaybackQueueController 中 handlePrevTrack / handleNextTrack 的同一套下标规则，
 * 推导上一首/下一首能否跳转，以及目标曲目的标题、艺术家与封面。
 * FM 模式停在队列最后一首时，跳转会现拉新曲目，此时 canGo 为 true 但目标信息未知；
 * FM 的队列不绕回，所以 FM 第一首没有上一首。
 * canGo 为 true 即按下去 handler 会去试；主窗口的箭头、遥控窗口与任务栏
 * （playbackSyncBridge）、队列操作回给舞台的快照读的都是这里的 canGo。
 * 两处它答不准：FM 最后一首拉不到新曲目时，按了没有结果，这事先不知道；
 * 过渡进行中 handler 从画面上那首算起，这里按传进来的 currentSong 算，传的是 store 里那首时会差一首。
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
    // 舞台播放时两个 handler 都会直接 return，这里必须同步禁用，否则箭头点了没反应
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

    // 随机模式走的是这一轮的排列，不是队列顺序（见 shuffleOrder* 那几个）。
    if (indexLoopMode === 'shuffle') {
        const order = shuffleRound?.order ?? [];
        if (order.length === 0) {
            return { prev: unknownNeighbor(), next: unknownNeighbor() };
        }
        const history = shuffleRound?.history ?? [];
        const currentIndex = shuffleCurrentQueueIndex(playQueue, currentSong, history);
        const position = order.indexOf(currentIndex);
        const prevIndex = prevShuffleIndexFromRound(playQueue, order, history, currentIndex);
        const nextIndex = nextShuffleIndexWrapping(order, currentIndex);
        // 停在排列最后一首时，下一首是谁要等重洗才知道：能按，但标题填不出来。
        const nextIsUnknown = position < 0 || position >= order.length - 1;
        return {
            prev: prevIndex >= 0 ? neighborAt(prevIndex) : blockedNeighbor(),
            next: nextIsUnknown || nextIndex < 0 ? unknownNeighbor() : neighborAt(nextIndex),
        };
    }

    const currentIndex = queueIndexOf(playQueue, currentSong);
    const prevIndex = prevQueueIndex(playQueue.length, currentIndex, indexLoopMode);
    const nextIndex = nextQueueIndex(playQueue.length, currentIndex, indexLoopMode);

    // FM 走到队列末尾时会追加新曲目再跳，标题此刻无法预知
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
