import dayjs, { Dayjs } from "dayjs";
import EventEmitter from "events";
import { TrackObject, UserGetRecentTracksResponse } from "lastfm-node-client";
import request from "superagent";
import { PlayObject, SOURCE_SOT } from "../../core/Atomic.js";
import { isNodeNetworkException } from "../common/errors/NodeErrors.js";
import { FormatPlayObjectOptions, InternalConfig, TRANSFORM_HOOK } from "../common/infrastructure/Atomic.js";
import { LastfmSourceConfig } from "../common/infrastructure/config/source/lastfm.js";
import LastfmApiClient from "../common/vendor/LastfmApiClient.js";
import { sortByOldestPlayDate } from "../utils.js";
import { RecentlyPlayedOptions } from "./AbstractSource.js";
import MemorySource from "./MemorySource.js";
import { timePassesScrobbleThreshold } from "../utils/TimeUtils.js";
import { buildTrackString } from "../../core/StringUtils.js";

export default class LastfmSource extends MemorySource {

    api: LastfmApiClient;
    requiresAuth = true;
    requiresAuthInteraction = true;

    declare config: LastfmSourceConfig;

    constructor(name: any, config: LastfmSourceConfig, internal: InternalConfig, emitter: EventEmitter) {
        const {
            data: {
                interval = 15,
                maxInterval = 60,
                ...restData
            } = {}
        } = config;
        super('lastfm', name, {...config, data: {interval, maxInterval, ...restData}}, internal, emitter);
        this.canPoll = true;
        this.canBacklog = true;
        this.supportsUpstreamRecentlyPlayed = true;
        this.supportsUpstreamNowPlaying = true;
        this.api = new LastfmApiClient(name, {...config.data, configDir: internal.configDir, localUrl: internal.localUrl}, {logger: this.logger});
        this.playerSourceOfTruth = SOURCE_SOT.HISTORY;
        // https://www.last.fm/api/show/user.getRecentTracks
        this.SCROBBLE_BACKLOG_COUNT = 200;
        this.logger.info(`Note: The player for this source is an analogue for the 'Now Playing' status exposed by ${this.type} which is NOT used for scrobbling. Instead, the 'recently played' or 'history' information provided by this source is used for scrobbles.`)
    }

    static formatPlayObj(obj: any, options: FormatPlayObjectOptions = {}): PlayObject {
        return LastfmApiClient.formatPlayObj(obj, options);
    }

    protected async doBuildInitData(): Promise<true | string | undefined> {
        return await this.api.initialize();
    }

    protected async doCheckConnection():Promise<true | string | undefined> {
        try {
            await request.get('http://ws.audioscrobbler.com/2.0/');
            return true;
        } catch (e) {
            if(isNodeNetworkException(e)) {
                throw new Error('Could not communicate with Last.fm API server', {cause: e});
            } else if(e.status >= 500) {
                throw new Error('Last.fm API server returning an unexpected response', {cause: e})
            }
            return true;
        }
    }
    doAuthentication = async () => {
        try {
            return await this.api.testAuth();
        } catch (e) {
            throw e;
        }
    }


    getLastfmRecentTrack = async(options: RecentlyPlayedOptions = {}): Promise<[PlayObject[], PlayObject[]]> => {
        const {limit = 20} = options;
        const resp = await this.api.callApi<UserGetRecentTracksResponse>((client: any) => client.userGetRecentTracks({
            user: this.api.user,
            sk: this.api.client.sessionKey,
            limit,
            extended: true
        }));
        const {
            recenttracks: {
                track: list = [],
            }
        } = resp;

        const plays = list.reduce((acc: PlayObject[], x: TrackObject) => {
            try {
                const formatted = LastfmApiClient.formatPlayObj(x);
                const {
                    data: {
                        track,
                        playDate,
                    },
                    meta: {
                        mbid,
                        nowPlaying,
                    }
                } = formatted;
                if(playDate === undefined) {
                    if(nowPlaying === true) {
                        formatted.data.playDate = dayjs();
                        return acc.concat(formatted);
                    }
                    this.logger.warn(`Last.fm recently scrobbled track did not contain a timestamp, omitting from time frame check`, {track, mbid});
                    return acc;
                }
                return acc.concat(formatted);
            } catch (e) {
                this.logger.warn('Failed to format Last.fm recently scrobbled track, omitting from time frame check', {error: e.message});
                this.logger.debug('Full api response object:');
                this.logger.debug(x);
                return acc;
            }
        }, []).sort(sortByOldestPlayDate);
        // if the track is "now playing" it doesn't get a timestamp so we can't determine when it started playing
        // and don't want to accidentally count the same track at different timestamps by artificially assigning it 'now' as a timestamp
        // so we'll just ignore it in the context of recent tracks since really we only want "tracks that have already finished being played" anyway
        const history = plays.filter(x => x.meta.nowPlaying !== true);
        const now = plays.filter(x => x.meta.nowPlaying === true);
        return [history, now];
    }

    getRecentlyPlayed = async(options: RecentlyPlayedOptions = {}): Promise<PlayObject[]> => {
        try {
            const [history, now] = await this.getLastfmRecentTrack(options);
            this.processRecentPlays(now);
            return  history;
        } catch (e) {
            throw e;
        }
    }

    getUpstreamRecentlyPlayed = async (options: RecentlyPlayedOptions = {}): Promise<PlayObject[]> => {
        try {
            const [history, now] = await this.getLastfmRecentTrack(options);
            return history;
        } catch (e) {
            throw e;
        }
    }

    getUpstreamNowPlaying = async (): Promise<PlayObject[]> => {
        try {
            const [history, now] = await this.getLastfmRecentTrack();
            return now;
        } catch (e) {
            throw e;
        }
    }

    protected getBackloggedPlays = async (options: RecentlyPlayedOptions = {}) => await this.getRecentlyPlayed({formatted: true, ...options})

    getLastfmDateRange = async(from: Dayjs, to: Dayjs = dayjs()): Promise<[PlayObject[], PlayObject[]]> => {
        this.logger.info(`Fetching scrobbles from ${from.format()} to ${to.format()}`);
        
        interface RecentTracksAttr {
            page: string;
            total: string;
            user: string;
            perPage: string;
            totalPages: string;
        }
        
        interface RecentTracksResponse {
            recenttracks: {
                '@attr': RecentTracksAttr;
                track: TrackObject[];
            }
        }
        
        let page = 1;
        let totalPages = 1;
        let list: TrackObject[] = [];

        do {
            try {
                const resp = await this.api.callApi<RecentTracksResponse>((client: any) => client.userGetRecentTracks({
                    user: this.api.user,
                    sk: this.api.client.sessionKey,
                    from: from.unix(),
                    to: to.unix(),
                    page,
                    extended: true
                }));

                const {
                    recenttracks: {
                        track: pageTracks = [],
                        '@attr': {
                            totalPages: total = '1'
                        } = {} as RecentTracksAttr
                    }
                } = resp;

                totalPages = parseInt(total);
                list = list.concat(pageTracks);
                page++;
            } catch (e) {
                this.logger.error('Error fetching scrobbles:', e);
                throw e;
            }
        } while (page <= totalPages);
    
        const plays = list.reduce((acc: PlayObject[], x: TrackObject) => {
            try {
                const formatted = LastfmApiClient.formatPlayObj(x);
                const {
                    data: {
                        track,
                        playDate,
                    },
                    meta: {
                        mbid,
                        nowPlaying,
                    }
                } = formatted;
                if(playDate === undefined) {
                    if(nowPlaying === true) {
                        formatted.data.playDate = dayjs();
                        return acc.concat(formatted);
                    }
                    this.logger.warn(`Last.fm recently scrobbled track did not contain a timestamp, omitting from time frame check`, {track, mbid});
                    return acc;
                }
                return acc.concat(formatted);
            } catch (e) {
                this.logger.warn('Failed to format Last.fm recently scrobbled track, omitting from time frame check', {error: e.message});
                this.logger.debug('Full api response object:');
                this.logger.debug(x);
                return acc;
            }
        }, []).sort(sortByOldestPlayDate);
    
        const history = plays.filter(x => x.meta.nowPlaying !== true);
        const now = plays.filter(x => x.meta.nowPlaying === true);
    
        return [history, now];
    }

    processHistoricalPlays = async (plays: PlayObject[]): Promise<PlayObject[]> => {
        const {
            options: {
                scrobbleThresholds = {}
            }
        } = this.config;
    
        const newHistoricalPlays: PlayObject[] = [];
        this.logger.debug(`Processing ${plays.length} historical plays`);
    
        // Process each historical play
        for (const play of plays) {
            // Mark as historical to bypass time validation
            play.meta = {
                ...play.meta,
                historical: true
            }

            // TODO: Fix threshold calculation for historical plays
            // For historical plays from Last.fm, assume they were listened to fully 
            // if duration exists, otherwise pass threshold check
            const effectiveListenedFor = play.data.duration ?? 30; // Default 30s if no duration
            play.data.listenedFor = effectiveListenedFor;

            // Check if it passes threshold
            const thresholdResults = timePassesScrobbleThreshold(
                scrobbleThresholds,
                effectiveListenedFor,
                play.data.duration
            );

            this.logger.debug(`Historical play threshold results: ${JSON.stringify(thresholdResults)}, play data: ${JSON.stringify(play.data)}`);
    
            // TODO: Hacky way to pass threshold check for historical plays
            thresholdResults.passes = true;

            if (thresholdResults.passes) {
                // Check if already discovered
                const matchingRecent = this.existingDiscovered(play);
                if (matchingRecent === undefined) {
                    this.logger.debug(`New historical play: ${buildTrackString(play)}`);
                    newHistoricalPlays.push(play);
                }
            }
        }
    
        // Trigger scrobbling if we found new plays
        if (newHistoricalPlays.length > 0) {
            this.logger.info(`Found ${newHistoricalPlays.length} new historical plays to scrobble`);
            // Use discover + scrobble to maintain consistent event emission
            const discovered = this.discover(newHistoricalPlays);
            this.scrobble(discovered);
        } else {
            this.logger.info('No new historical plays found to scrobble');
        }
    
        return newHistoricalPlays;
    };
}
