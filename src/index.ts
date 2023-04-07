import axios from 'axios'
import PQueue from 'p-queue'
import {EventEmitter} from 'events'

function noop() {
}

function defaultOnError(e) {
    console.error('EventStoreConsumer error: ' + (e.stack || e))
}

type EventStoreConsumerParams = {
    stream: string,
    group: string,
    handler: (event: any) => void,
    concurrency?: number,
    eventStoreUrl?: string,
    onEvent?: (event: any) => void,
    onAck?: (event: any) => void,
    onNack?: (event: any) => void,
    onError?: (error: Error) => void,
    pollDelay?: number
}

export class EventStoreConsumer extends EventEmitter {
    stream: string;
    group: string;
    handler: (event: any) => void;
    concurrency: number;
    eventStoreUrl: string;
    onEvent: (event: any) => void;
    onAck: (event: any) => void;
    onNack: (event: any) => void;
    onError: (error: Error) => void;
    running: boolean;
    polling: boolean;
    queue: PQueue;
    pollTimer?: NodeJS.Timer;
    pollDelay: number;

    constructor(params: EventStoreConsumerParams) {
        super()
        this.stream = params.stream
        this.group = params.group
        this.handler = params.handler
        this.concurrency = params.concurrency || 1
        this.running = false
        this.polling = false
        this.queue = new PQueue({concurrency: this.concurrency})
        this.pollDelay = params.pollDelay || 500
        this.eventStoreUrl = params.eventStoreUrl || process.env.EVENT_STORE_URL || ""
        if (!this.eventStoreUrl) {
            throw new Error('Event Store URL must be supplied to EventStoreConsumer. Either set the `eventStoreUrl` option or set the `EVENT_STORE_URL` env variable.')
        }

        this.onEvent = params.onEvent || noop
        this.onAck = params.onAck || noop
        this.onNack = params.onNack || noop
        this.onError = params.onError || defaultOnError
    }

    start() {
        this.running = true
        this.poll()
    }

    stop () {
        this.running = false
        this.cancelScheduledPoll()

        if (this.getQueueLength() === 0) {
            return Promise.resolve()
        } else {
            return new Promise(resolve => {
                this.on('drain', resolve)
            })
        }
    }

    getQueueLength() {
        return this.queue.size + this.queue.pending
    }

    poll() {
        //If the queue is already full, then schedule a poll later
        let count = this.concurrency - this.getQueueLength()
        if (count <= 0) {
            this.schedulePoll()
            return
        }

        //Only allow one poll request at a time
        if (this.polling) {
            return
        }
        this.polling = true

        //Make sure that any scheduled polls are cancelled
        this.cancelScheduledPoll()

        //Request up to `count` new events
        let url = `${this.eventStoreUrl}/subscriptions/${this.stream}/${this.group}/${count}?embed=Body`

        this.request('GET', url, 'application/vnd.eventstore.competingatom+json')
            .then(payload => {
                this.polling = false

                if (!this.running) {
                    return
                }

                const {entries} = payload.data
                if (entries.length > 0) {
                    //Add each event to the queue
                    entries.forEach(event => {
                        this.queue.add(this.handleEvent.bind(this, event))
                                  .then(this.didHandleEvent.bind(this), e => console.log(e.stack))
                    })

                    //Poll immediately
                    this.poll()
                } else {
                    //No events in queue at this time, so let's schedule a poll
                    this.schedulePoll()
                }

                this.emit('poll')
            }, e => {
                this.polling = false
                //Log the error and retry again soon
                this.onError(e)
                if (this.running) {
                    this.schedulePoll()
                }
            })
    }

    schedulePoll() {
        //Only allow one poll to be scheduled at a time
        if (this.pollTimer) {
            return
        }

        this.pollTimer = setTimeout(this.poll.bind(this), this.pollDelay)
    }

    cancelScheduledPoll() {
        clearTimeout(this.pollTimer)
        delete this.pollTimer
    }

    handleEvent(event) {
        this.onEvent(event)
        return Promise.resolve(this.handler(event))
            .then(() => {
                //Ack the event
                return this.ack(event)
            }, e => {
                //Log the error, nack the event
                this.onError(e)
                return this.nack(event)
            })
    }

    didHandleEvent() {
        //Emit a `drain` event if the queue is empty
        if (this.getQueueLength() === 0) {
            this.emit('drain')
        }

        //Try to poll again, if we're still running
        if (this.running) {
            this.poll()
        }
    }

    ack(event) {
        return this.ackNackHelper(event, 'ack')
    }

    nack(event) {
        return this.ackNackHelper(event, 'nack')
    }

    ackNackHelper(event, type, retries = 3, delayMs = 500) {
        if (type === 'ack') {
            this.onAck(event)
        } else {
            this.onNack(event)
        }
        let url
        for (let i = 0; i < event.links.length; i++) {
            let link = event.links[i]
            if (link.relation === type) {
                url = link.uri
                break
            }
        }
        if (!url) {
            return Promise.resolve()
        }
        // return this.request('POST', url)
        //     .catch(e => {
        //         //Log the error, but don't throw it since we don't want a failed ack/nack to crash the process
        //         //TODO: We could retry the ack/nack a few times before giving up
        //         this.onError(e)
        //     })
        let retryCount = 0
        return new Promise((resolve, reject) => {
            function doRequest() {
                this.request('POST', url)
                    .then((payload) => {
                        resolve(payload?.data)
                    })
                    .catch(e => {
                        retryCount++
                        if (retryCount === retries) {
                            this.onError(e)
                            reject(e)
                        } else {
                            setTimeout(doRequest.bind(this), delayMs)
                        }
                    })
            }
            doRequest.call(this)
        })
    }

    request(method: string, url: string, accept: string) {
        const options = {
            method: method,
            url: url,
            headers: {
                accept: accept
            }
        }
        return axios(options)
            .catch(e => { throw e })
    }
}
