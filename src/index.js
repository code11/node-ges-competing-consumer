import requestp from 'request-promise'
import Queue from 'promise-queue'
import {EventEmitter} from 'events'
import logger from '../logger'

export const POLL_DELAY = 500 //ms

export default class EventStoreConsumer extends EventEmitter {
    constructor(stream, group, handler, {concurrency = 1, eventStoreUrl} = {}) {
        super()
        this.stream = stream
        this.group = group
        this.handler = handler
        this.concurrency = concurrency
        this.running = false
        this.polling = false
        this.queue = new Queue(this.concurrency, Infinity)

        this.eventStoreUrl = eventStoreUrl || process.env.EVENT_STORE_URL
        if (!this.eventStoreUrl) {
            throw new Error('Event Store URL must be supplied to EventStoreConsumer. Either set the `eventStoreUrl` option or set the `EVENT_STORE_URL` env variable.')
        }
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
        return this.queue.getQueueLength() + this.queue.getPendingLength()
    }

    async poll() {
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

        let payload
        try {
            payload = await this.request('GET', url, {
                accept: 'application/vnd.eventstore.competingatom+json'
            })
        } catch (e) {
            //Log the error and retry again soon
            logger.logError(e)
            if (this.running) {
                this.schedulePoll()
            }
            return
        }

        this.polling = false

        if (!this.running) {
            return
        }

        let {entries} = payload
        if (entries.length > 0) {
            //Add each event to the queue
            entries.forEach(event => {
                this.queue.add(this.handleEvent.bind(this, event))
                    .then(this.didHandleEvent.bind(this))
            })

            //Poll immediately
            this.poll()
        } else {
            //No events in queue at this time, so let's schedule a poll
            this.schedulePoll()
        }

        this.emit('poll')
    }

    schedulePoll() {
        //Only allow one poll to be scheduled at a time
        if (this.pollTimer) {
            return
        }

        this.pollTimer = setTimeout(this.poll.bind(this), POLL_DELAY)
    }

    cancelScheduledPoll() {
        clearTimeout(this.pollTimer)
        delete this.pollTimer
    }

    async handleEvent(event) {
        logger.info({
            type: 'x-event-store-event-received',
            eventId: event.eventId,
            eventType: event.eventType,
            data: event.data
        })
        //Run the handler for the event in a try-catch block
        try {
             await this.handler(event)
        } catch (e) {
            //Log the error, nack the event
            logger.logError(e)
            await this.nack(event)
            return
        }

        //Ack the event
        await this.ack(event)
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

    async ack(event) {
        return this.ackNackHelper(event, 'ack')
    }

    async nack(event) {
        return this.ackNackHelper(event, 'nack')
    }

    async ackNackHelper(event, type) {
        logger.info({
            type: 'x-event-store-event-' + type,
            eventId: event.eventId
        })
        let url = event.links.find(link => link.relation === type).uri
        try {
            return await this.request('POST', url)
        } catch (e) {
            //Log the error, but don't throw it since we don't want a failed ack/nack to crash the process
            //TODO: We could retry the ack/nack a few times before giving up
            logger.logError(e)
        }
    }

    request(method, url, {accept} = {}) {
        let options = {
            method,
            url,
            json: true,
            headers: {
                accept
            }
        }

        return requestp(options)
            .catch(e => {
                if (e.name === 'StatusCodeError') {
                    let e2 = new Error(`EventStore error ${e.statusCode}: ${e.response.statusMessage}. Method: ${method}. URL: ${url}`)
                    e2.code = 'EVENT_STORE_ERROR'
                    e2.status = e.statusCode
                    throw e2
                }
                throw e
            })
    }
}
