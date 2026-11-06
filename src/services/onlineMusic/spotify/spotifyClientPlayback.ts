import type { SongResult } from '../../../types';
import { OnlineProviderError } from '../../../types/onlineMusic';
import type { ExternalPlaybackStartOptions, OnlineExternalPlaybackProvider, ProviderExternalPlaybackStatus } from '../../../types/onlineMusic';
import { requireSpotifySong } from './spotifyNormalize';
import { requestSpotify } from './spotifyTransport';
import type { SpotifyWireClientStatus } from './spotifyTransport';

// src/services/onlineMusic/spotify/spotifyClientPlayback.ts
// Spotify's songs sound in Spotify's own desktop app (electron/spotify/officialClient.cjs): Spotify
// gives a free account no audio key for any other player. Folia keeps the queue; the app is told
// which track to play, where to move, and which tracks follow, and Folia follows its clock. The
// songs that follow are put in the app's queue, so it moves on by itself without a gap; when it
// does, the song Folia asked for is reported ended and the next play adopts the running track.
//
// D2: when the app cannot take the songs at all (not installed, or neither its DevTools port nor
// the system media session answers), this route is given up for the rest of the run and Spotify's
// songs play through Folia's own player (electron/spotify/audio.cjs) instead of failing.
// M4: the media session names no track. While it answers, nothing is prepared in the app's queue,
// its coarse position never replaces the song's duration, and a title it shows that is not the
// song Folia asked for ends this external session so Folia's own queue takes the next song.

/** How many songs that follow are put in the app's queue. */
const PREPARED_SONGS = 2;
/** What the app's own answer to a start says (N8): it took the track, a newer start took over, or it never got to it. */
type SpotifyClientPlayAnswer = 'loaded' | 'preempted' | 'not-loaded';
/** A track change this close to the end of the song Folia asked for is that song ending. */
const END_TOLERANCE_MS = 3000;

interface Attempt {
    id: string;
    /** The song's own name and artist, as the app's page does not say them when it falls back. */
    name: string;
    artist: string;
    hasPlayed: boolean;
    positionMs: number;
    durationMs: number;
    /** The ids put in the app's queue after this song, in order. Written once the app took them. */
    nextIds: string[];
    /** The last answer came from the system media session: it names no track, so nothing is prepared. */
    degraded: boolean;
    /** The id Folia had the app play before this one: the track the app's own "previous" goes back to. */
    previousId: string;
    /** The app was moved to another track by its own controls and Folia already pulled it back once. */
    pulledBack: boolean;
}

let attempt: Attempt | null = null;
/** The id the app already moved on to by itself; the next play of it starts nothing. */
let handoffId: string | null = null;
/** Whether the app can be steered here: 'unknown' until it was asked once (D2). */
let availability: 'unknown' | 'available' | 'unusable' = 'unknown';
/** The question being asked, so two songs in a row ask it once. */
let probing: Promise<boolean> | null = null;

/** Whether this build can reach the desktop side at all: the Windows desktop app only. */
const spotifyTransportReady = (): boolean => (
    typeof window !== 'undefined' && typeof window.electron?.spotifyRequest === 'function' && window.electron?.platform === 'win32'
);

/** The steering runs on the Windows desktop app only, and only while it can take the songs (D2). */
export const canSteerSpotifyApp = (): boolean => spotifyTransportReady() && availability !== 'unusable';

/**
 * Whether Spotify's app is on this computer (D2). The desktop side only looks at the launcher on
 * disk and keeps its answer for a minute, so this costs no process and no port; a song asks it
 * before it is sent, and a "no" sends the song down Folia's own player instead of failing it.
 */
export const probeSpotifyClientApp = async (): Promise<boolean> => {
    if (!spotifyTransportReady()) return false;
    if (availability === 'available') return true;
    if (availability === 'unusable') return false;
    probing ??= requestSpotify<{ available?: boolean }>('client_probe')
        .then(answer => {
            availability = answer?.available === true ? 'available' : 'unusable';
            if (availability === 'unusable') {
                console.info('[SpotifyClient] Spotify\'s app cannot be steered here; its songs play in Folia');
            }
            return availability === 'available';
        }, error => {
            // A question that could not be asked says nothing about the app: it is asked again.
            console.warn('[SpotifyClient] whether Spotify\'s app is installed could not be read', error);
            return availability !== 'unusable';
        })
        .finally(() => { probing = null; });
    return probing;
};

/** The app said it cannot take the song: this run stops steering and plays its songs here (D2). */
const giveUpSteering = (error: unknown): void => {
    const code = (error as { code?: string } | null)?.code;
    if (code !== 'unavailable' && code !== 'unsupported') return;
    availability = 'unusable';
    console.warn('[SpotifyClient] the Spotify app cannot take the song; its songs play in Folia from now on', error);
};

const songIdOf = (song: SongResult): string | null => {
    try { return requireSpotifySong(song); } catch { return null; }
};

/** The song's artist names, however the provider keeps them. */
const artistNamesOf = (song: SongResult): string => {
    const artists = (song as { artists?: unknown }).artists;
    if (!Array.isArray(artists)) return '';
    return artists
        .map(artist => (typeof artist === 'string' ? artist : String((artist as { name?: unknown })?.name ?? '')))
        .filter(Boolean)
        .join(', ');
};

const ended = (current: Attempt): ProviderExternalPlaybackStatus => ({
    mediaId: current.id, isPlaying: false, ended: true,
    durationMs: current.durationMs, positionMs: current.durationMs || current.positionMs,
});

const plainName = (text: unknown): string => String(text ?? '').trim().toLocaleLowerCase();

/** Whether one of the artist names the media session shows is the song's own (it joins them its way). */
const mentionsArtist = (wanted: string, shown: string): boolean => {
    const target = plainName(wanted);
    if (!target) return true;
    return shown.split(/[,;&/]/).map(part => plainName(part)).filter(Boolean)
        .some(part => part.includes(target) || target.includes(part));
};

/**
 * Whether the track the media session shows is another song than the one Folia asked for: its
 * title differs, or it names an artist that is not this song's. Without a title, nothing is known
 * and the answer is "no".
 */
const namesAnotherTrack = (current: Attempt, data: SpotifyWireClientStatus): boolean => {
    const title = String(data.title ?? '').trim();
    if (!title || !current.name) return false;
    if (plainName(title) !== plainName(current.name)) return true;
    const artist = String(data.artist ?? '').trim();
    return Boolean(artist && current.artist) && !mentionsArtist(current.artist, artist);
};

/** Turns what the app said into Folia's status for the song it asked for. */
export const statusOfClient = (data: SpotifyWireClientStatus): ProviderExternalPlaybackStatus => {
    const current = attempt;
    const isPlaying = !data.isPaused && !data.isBuffering;
    // An advertisement plays between songs of a free account: it is muted on the desktop side, and
    // shown as the song still loading here, never as another song to stop.
    if (data.ad) {
        return { mediaId: current?.id ?? '', isPlaying: false, ended: false, starting: true, advertisement: true,
            positionMs: current?.positionMs ?? 0, durationMs: current?.durationMs ?? 0 };
    }
    // The media session answered instead of the app's own player: the DevTools port is down and the
    // app is steered through SMTC (electron/spotify/officialClient.cjs).
    const fallback = data.fallback === true;
    if (current) current.degraded = fallback;
    const id = fallback ? current?.id ?? '' : data.id;
    const status: ProviderExternalPlaybackStatus = {
        mediaId: id, isPlaying, ended: false, positionMs: data.positionMs,
        // A coarse answer knows no duration for this song: it never replaces the one held (M4).
        durationMs: fallback && current ? current.durationMs : data.durationMs,
        starting: !data.isPaused && data.isBuffering,
        degraded: fallback,
    };
    if (!current) return status;
    if (fallback) {
        // The media session names no track, so the app's own move to another song is read from the
        // title it shows: the external session ends and Folia's queue takes the next song (M4).
        if (current.hasPlayed && namesAnotherTrack(current, data)) {
            console.info('[SpotifyClient] Spotify moved on to another track; the external session ends');
            return ended(current);
        }
        if (isPlaying) current.hasPlayed = true;
        current.positionMs = data.positionMs;
        return status;
    }
    if (id === current.id) {
        current.hasPlayed ||= isPlaying;
        if (data.durationMs > 0) current.durationMs = data.durationMs;
        current.positionMs = data.positionMs;
        return status;
    }
    if (id && current.hasPlayed && current.nextIds[0] === id) {
        // The app moved on to the song Folia put next: the asked-for song is over.
        handoffId = id;
        return ended(current);
    }
    if (id && current.hasPlayed && current.durationMs > 0 && current.positionMs >= current.durationMs - END_TOLERANCE_MS) {
        // The song ran out and the app went on to a song of its own (its autoplay): the asked-for song
        // is over; Folia's next play replaces what the app chose.
        return ended(current);
    }
    if (id && current.hasPlayed && !current.pulledBack) {
        // Not Folia's doing and not the song's end: the listener used the app's own controls (its
        // window, a media key it got). The queue is Folia's, so the step is pulled back to Folia's
        // queue in the direction the app moved: onto the track it played before, or on.
        current.pulledBack = true;
        const skipped = id === current.previousId ? 'previous' : 'next';
        console.info(`[SpotifyClient] Spotify was moved to another track by its own controls; Folia's queue goes ${skipped}`);
        return { ...ended(current), skipped };
    }
    return status;
};

export const spotifyClientPlayback: OnlineExternalPlaybackProvider = {
    canPlay: song => canSteerSpotifyApp() && songIdOf(song) !== null,
    isPrepared(song) {
        const id = songIdOf(song);
        return id !== null && (handoffId === id || Boolean(attempt?.hasPlayed && attempt.nextIds[0] === id));
    },
    async prepareNext(song, upcoming) {
        const current = attempt;
        if (!current || current.id !== songIdOf(song)) return;
        // The media session names no track: what the app would move on to cannot be checked, so
        // nothing is prepared while the app is steered coarsely (M4).
        if (current.degraded) return;
        const ids: string[] = [];
        for (const next of upcoming) {
            const id = songIdOf(next);
            if (!id || ids.length >= PREPARED_SONGS) break;
            ids.push(id);
        }
        if (ids.join() === current.nextIds.join()) return;
        // Written only once the app took them: a queue write that failed leaves nothing prepared,
        // so the next try asks again instead of reporting a song as ready (L4).
        await requestSpotify('client_queue', { ids });
        current.nextIds = ids;
    },
    async play(song, startSec, options: ExternalPlaybackStartOptions = {}) {
        const id = songIdOf(song);
        if (!id) throw new OnlineProviderError('not-playable', 'Not a Spotify track', 'spotify');
        // The song goes to Folia's own player when the app cannot take it, rather than failing (D2).
        if (!(await probeSpotifyClientApp())) {
            throw new OnlineProviderError('unavailable', 'The Spotify app cannot play the song', 'spotify');
        }
        const startMs = Math.max(0, Math.round(startSec * 1000));
        const adopt = handoffId === id && startMs === 0;
        const previousId = attempt && attempt.id !== id ? attempt.id : attempt?.previousId ?? '';
        handoffId = null;
        attempt = {
            id, name: String(song.name ?? ''), artist: artistNamesOf(song),
            hasPlayed: adopt, positionMs: startMs, durationMs: song.durationMs ?? 0, nextIds: [], degraded: false,
            previousId, pulledBack: false,
        };
        if (adopt) {
            console.info('[SpotifyClient] The app already plays the next song; it is adopted');
            return;
        }
        // An advance Folia made by itself is not a press: the desktop side is told so, and does not
        // start or restart Spotify for it (T5).
        const userAction = options.userAction !== false;
        try {
            const answer = await requestSpotify<SpotifyClientPlayAnswer>('client_play', { id, startMs, userAction });
            // A newer start replaced this one: nothing went wrong, and there is nothing to report (N8).
            if (answer === 'preempted') {
                console.info('[SpotifyClient] a newer play took the app; this one stops');
                return;
            }
            // The app took the call and never got to the track: that is a failure of this song (N8).
            // It is reported as one and does not retire the app for the run: one track Spotify will
            // not load says nothing about the next one.
            if (answer !== 'loaded') {
                throw new OnlineProviderError('not-playable', 'The Spotify app did not load the song', 'spotify');
            }
        } catch (error) {
            // An advance Folia made by itself that could not reach the app stops there (T5): the
            // listener pressed nothing, so a restart that was not allowed is no reason to leave the
            // app for the rest of the run. Only a press that the app refused retires the route (N1).
            if (userAction) giveUpSteering(error);
            throw error;
        }
        console.info('[SpotifyClient] The app plays the song');
    },
    async pause() {
        await requestSpotify('client_pause');
    },
    async resume() {
        try {
            await requestSpotify('client_resume');
        } catch (error) {
            // The listener pressed play and the app cannot be resumed: it was closed (or is gone
            // from its port). That press is the listener's own action, so the app is started again
            // on the song Folia holds, from the position Folia holds (D1). A pause, and the advance
            // Folia makes by itself, never come here.
            const code = (error as { code?: string } | null)?.code;
            const current = attempt;
            if (!current || (code !== 'unavailable' && code !== 'network')) throw error;
            console.info('[SpotifyClient] Spotify cannot be resumed; the listener pressed play, so it is started on the song again', error);
            // A new start empties the app's queue and history: what was prepared is written again
            // below, because Folia's own record of what it prepared does not change and would not ask.
            const prepared = current.nextIds;
            current.nextIds = [];
            current.hasPlayed = false;
            current.pulledBack = false;
            current.degraded = false;
            const answer = await requestSpotify<SpotifyClientPlayAnswer>('client_play', {
                id: current.id, startMs: Math.max(0, Math.round(current.positionMs)), userAction: true,
            });
            if (answer === 'preempted') return;
            if (answer !== 'loaded') throw new OnlineProviderError('not-playable', 'The Spotify app did not load the song', 'spotify');
            // A song asked for in the meantime owns the queue now.
            if (attempt !== current || prepared.length === 0) return;
            try {
                await requestSpotify('client_queue', { ids: prepared });
                current.nextIds = prepared;
            } catch (queueError) {
                // The song plays; only its tail is missing, and the next queue edit writes it again.
                console.warn('[SpotifyClient] the songs that follow could not be put back after the restart', queueError);
            }
        }
    },
    async seek(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) {
            throw new OnlineProviderError('invalid-response', 'Spotify seek position is invalid', 'spotify');
        }
        await requestSpotify('client_seek', { ms: Math.round(seconds * 1000) });
    },
    async setVolume(volume) {
        await requestSpotify('client_volume', { value: Math.min(1, Math.max(0, volume)) });
    },
    async getStatus() {
        return statusOfClient(await requestSpotify<SpotifyWireClientStatus>('client_status'));
    },
    isStatusForSong(song, status) {
        return status.mediaId !== '' && status.mediaId === songIdOf(song);
    },
    // Asked once when the app starts: an app that is not installed must not be tried on every song (D2).
    probe: () => probeSpotifyClientApp(),
    // The setting that wakes the player with Folia: the app has to be running with its DevTools
    // port before a song can be steered into it.
    warmUp: () => launchSpotifyApp(),
};

/** Starts Spotify's app with its DevTools port (the setting that wakes it with Folia, D1). */
export const launchSpotifyApp = async (): Promise<void> => {
    if (!canSteerSpotifyApp()) return;
    try {
        await requestSpotify('client_launch');
    } catch (error) {
        giveUpSteering(error);
        throw error;
    }
};

/** Test seam: forgets the song asked for and what was read about the app. */
export const resetSpotifyClientPlayback = (): void => {
    attempt = null;
    handoffId = null;
    availability = 'unknown';
    probing = null;
};

/** Test seam: what is held of the song asked for. */
export const spotifyClientAttempt = (): Attempt | null => attempt;

/** Test seam: whether this run still steers the app. */
export const spotifyClientAvailability = (): 'unknown' | 'available' | 'unusable' => availability;
