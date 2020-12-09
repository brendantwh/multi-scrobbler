import dayjs from "dayjs";
import {buildTrackString, capitalize, createLabelledLogger, sleep} from "../utils.js";

export default class AbstractSource {

    name;
    type;
    identifier;

    config;
    clients;
    logger;

    canPoll = false;
    polling = false;
    tracksDiscovered = 0;

    constructor(type, name, config = {}, clients = []) {
        this.type = type;
        this.name = name;
        this.identifier = `${capitalize(this.type)} - ${name}`;
        this.logger = createLabelledLogger(this.identifier, this.identifier);
        this.config = config;
        this.clients = clients;
    }

    getRecentlyPlayed = async (options = {}) => {
        return [];
    }

    // by default if the track was recently played it is valid
    // this is useful for sources where the track doesn't have complete information like Subsonic
    // TODO make this more descriptive? or move it elsewhere
    recentlyPlayedTrackIsValid = (playObj) => {
        return true;
    }

    poll = async (allClients) => {
        await this.startPolling(allClients);
    }

    /**
     * @param {ScrobbleClients} allClients
     */
    startPolling = async (allClients) => {
        if (this.polling === true) {
            return;
        }
        this.logger.info('Polling started');
        let lastTrackPlayedAt = dayjs();
        let checkCount = 0;
        try {
            this.polling = true;
            while (true) {
                if(this.polling === false) {
                    this.logger.info('Stopped polling due to user input');
                    break;
                }
                let playObjs = [];
                this.logger.debug('Refreshing recently played')
                playObjs = await this.getRecentlyPlayed({formatted: true});
                checkCount++;
                let newTracksFound = false;
                let closeToInterval = false;
                const now = dayjs();

                const playInfo = playObjs.reduce((acc, playObj) => {
                    if(this.recentlyPlayedTrackIsValid(playObj)) {
                        const {data: {playDate} = {}} = playObj;
                        if (playDate.unix() > lastTrackPlayedAt.unix()) {
                            newTracksFound = true;
                            this.logger.info(`New Track => ${buildTrackString(playObj)}`);

                            if (closeToInterval === false) {
                                closeToInterval = Math.abs(now.unix() - playDate.unix()) < 5;
                            }

                            return {
                                plays: [...acc.plays, {...playObj, meta: {...playObj.meta, newFromSource: true}}],
                                lastTrackPlayedAt: playDate
                            }
                        }
                        return {
                            ...acc,
                            plays: [...acc.plays, playObj]
                        }
                    }
                    return acc;
                }, {plays: [], lastTrackPlayedAt});
                playObjs = playInfo.plays;
                lastTrackPlayedAt = playInfo.lastTrackPlayedAt;

                if (closeToInterval) {
                    // because the interval check was so close to the play date we are going to delay client calls for a few secs
                    // this way we don't accidentally scrobble ahead of any other clients (we always want to be behind so we can check for dups)
                    // additionally -- it should be ok to have this in the for loop because played_at will only decrease (be further in the past) so we should only hit this once, hopefully
                    this.logger.info('Track is close to polling interval! Delaying scrobble clients refresh by 10 seconds so other clients have time to scrobble first');
                    await sleep(10 * 1000);
                }

                if (newTracksFound === false) {
                    if (playObjs.length === 0) {
                        this.logger.debug(`No new tracks found and no tracks returned from API`);
                    } else {
                        this.logger.debug(`No new tracks found. Newest track returned was ${buildTrackString(playObjs.slice(-1)[0])}`);
                    }
                } else {
                    checkCount = 0;
                }

                const scrobbleResult = await allClients.scrobble(playObjs, {
                    forceRefresh: closeToInterval,
                    scrobbleFrom: this.identifier,
                    scrobbleTo: this.clients
                });

                if (scrobbleResult.length > 0) {
                    checkCount = 0;
                    this.tracksDiscovered += scrobbleResult.length;
                }

                const {interval = 30} = this.config;

                let sleepTime = interval;
                // don't need to do back off calc if interval is 10 minutes or greater since its already pretty light on API calls
                // and don't want to back off if we just started the app
                if (checkCount > 5 && sleepTime < 600) {
                    const lastPlayToNowSecs = Math.abs(now.unix() - lastTrackPlayedAt.unix());
                    // back off if last play was longer than 10 minutes ago
                    const backoffThreshold = Math.min((interval * 10), 600);
                    if (lastPlayToNowSecs >= backoffThreshold) {
                        // back off to a maximum of 5 minutes
                        sleepTime = Math.min(interval * 5, 300);
                    }
                }

                // sleep for interval
                this.logger.debug(`Sleeping for ${sleepTime}s`);
                await sleep(sleepTime * 1000);

            }
        } catch (e) {
            this.logger.error('Error occurred while polling');
            this.logger.error(e);
            this.polling = false;
        }
    }
}
