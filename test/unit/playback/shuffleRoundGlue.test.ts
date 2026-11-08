import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PlayerState, type UnifiedSong } from '@/types';

// test/unit/playback/shuffleRoundGlue.test.ts — 切歌的 handler 真的把这一轮随机写回 store。
// 随机排列住在 usePlaybackStore 里，automix、预取、HiFi 无缝和浮动播放条的邻居读的都是那一份，
// 所以「handler 算了却没写回」是个静默错误：播放还在继续，别的消费者读到的是上一轮。这里钉住写回这件事。

const stateSetters = vi.hoisted(() => [] as Mock[]);
const hookRefs = vi.hoisted(() => ({ list: [] as { current: unknown }[], index: 0 }));
const hookStates = vi.hoisted(() => ({ list: [] as { value: unknown }[], index: 0 }));

vi.mock('react', () => ({
    useCallback: (callback: unknown) => callback,
    useMemo: (factory: () => unknown) => factory(),
    useRef: (current: unknown) => (hookRefs.list[hookRefs.index++] ??= { current }),
    useState: (value: unknown) => {
        const slot = (hookStates.list[hookStates.index++] ??= { value });
        const setter = vi.fn((next: unknown) => {
            slot.value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slot.value) : next;
        });
        stateSetters.push(setter);
        return [slot.value, setter];
    },
    useEffect: vi.fn(),
}));
vi.mock('react-i18next', () => ({
    initReactI18next: { type: '3rdParty', init: vi.fn() },
    useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/stores/usePlaybackStore', async importOriginal => {
    const actual = await importOriginal<typeof import('@/stores/usePlaybackStore')>();
    return { ...actual, usePlaybackStore: Object.assign(
        (selector: (state: unknown) => unknown) => selector(actual.usePlaybackStore.getState()), actual.usePlaybackStore) };
});
const audioSettings = vi.hoisted(() => ({ audioQuality: 'high', loopMode: 'all' as string, autoSkipUnplayable: false }));
vi.mock('@/stores/useAudioSettingsStore', () => ({
    useAudioSettingsStore: Object.assign(
        (selector: (state: unknown) => unknown) => selector(audioSettings),
        { getState: () => audioSettings },
    ),
}));
vi.mock('@/stores/useSearchNavigationStore', () => ({
    useSearchNavigationStore: (selector: (state: unknown) => unknown) => selector({}),
}));
vi.mock('@/services/hostExtensionHooks', () => ({ hasBeforePlayHook: () => false, lyricsForNoLyrics: () => null, notifyPlaybackFailed: vi.fn() }));
vi.mock('@/services/onlineMusic/omni', () => ({
    omni: {
        canPlaySong: () => true, canPlayExternally: () => false, getProviderLabel: (id: string) => id, getSongReplacement: vi.fn(async () => null),
        hasSetup: vi.fn((_id: string) => false),
    },
}));
vi.mock('@/services/onlineMusic/songAvailability', () => ({ askPlayedSong: () => null, isSongUnavailable: vi.fn(() => false) }));
vi.mock('@/services/onlineMusic/resourceCache', () => ({
    hasCachedSongAudio: async () => null,
    getCachedSongCoverUrl: vi.fn(async () => null),
}));
vi.mock('@/services/prefetchService', () => ({
    getPrefetchedData: () => null,
    prefetchNearbySongs: vi.fn(),
    invalidateAndRefetch: vi.fn(),
    refreshPrefetchAfterQueueEdit: vi.fn(),
}));
vi.mock('@/services/onlinePlayback', () => ({
    loadOnlineSongAudioSource: vi.fn(),
    applyOnlineAudioSourceMetadata: (song: unknown) => song,
    loadOnlineSongLyrics: vi.fn(async () => undefined),
}));
vi.mock('@/utils/onlineLyricsState', () => ({ loadOnlineLyricsState: vi.fn(async () => null) }));

const { usePlaybackQueueController } = await import('@/components/app/playback/start/usePlaybackQueueController');
const { usePlaybackStore } = await import('@/stores/usePlaybackStore');
const { askForSong } = await import('@/components/app/playback/currentSong');

const makeSong = (id: string): UnifiedSong => ({
    id, name: `Song ${id}`, artists: [], album: { id: '', name: '' }, durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'bodian', mediaId: id },
});
const songs: UnifiedSong[] = ['1', '2', '3'].map(makeSong);

beforeEach(() => {
    vi.clearAllMocks();
    stateSetters.length = 0;
    hookRefs.list.length = 0;
    hookStates.list.length = 0;
    vi.stubGlobal('window', { setTimeout: vi.fn(() => 1), setInterval: vi.fn(() => 2), clearTimeout: vi.fn(), clearInterval: vi.fn() });
    audioSettings.loopMode = 'shuffle';
    usePlaybackStore.setState({
        activePlaybackContext: 'main', currentSong: songs[0], playQueue: songs,
        playerState: PlayerState.PLAYING, isFmMode: false, audioSrc: 'https://cdn.example/1.mp3',
        shuffleOrder: [], shuffleSignature: '', shuffleHistory: [],
    });
    askForSong(songs[0]);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function controller() {
    hookRefs.index = 0;
    hookStates.index = 0;
    const pause = vi.fn();
    return usePlaybackQueueController({
        localSongs: [], localLibraryCatalog: {}, isNowPlayingStageActive: false, shouldNavigateToPlayerOnTrackChange: true,
        audioRef: { current: { pause } }, shouldAutoPlayRef: { current: true }, playbackAutoSkipCountRef: { current: 0 },
        blobUrlRef: { current: null as string | null }, pendingResumeTimeRef: { current: null },
        lastAudioRecoverySourceRef: { current: null }, currentOnlineAudioUrlFetchedAtRef: { current: null },
        mainPlaybackSnapshotRef: { current: null },
        setIsLyricsLoading: vi.fn(), setLyrics: vi.fn(), persistLastPlaybackCache: vi.fn(async () => undefined),
        navigateToPlaybackView: vi.fn(), restoreCachedThemeForSong: vi.fn(async () => undefined),
        interruptStagePlaybackForMainTransition: vi.fn(),
    } as never);
}

describe('随机切歌把这一轮写回 store', () => {
    it('下一首之后 store 里有一份完整的排列和本轮历史', async () => {
        const queue = controller();
        await queue.handleNextTrack();
        const state = usePlaybackStore.getState();
        // 排列是整份队列的一个排列，并且签名记下了它是对着哪一份队列洗的
        expect([...(state.shuffleOrder ?? [])].sort((a, b) => a - b)).toEqual([0, 1, 2]);
        expect(state.shuffleSignature).not.toBe('');
        // 历史里至少有此刻这首：别的消费者靠它认出「当前播放的是这一轮的第几首」
        expect(state.shuffleHistory.length).toBeGreaterThan(0);
        expect(state.shuffleHistory.at(-1)?.key).toBeTruthy();
    });
});
