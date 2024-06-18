import { ethers } from 'ethers';
import amqplib from 'amqplib';
import { FillEventObject } from '@synfutures/oyster-sdk/build/types/typechain/Instrument';
import { Core, Plugin } from '@synfutures/fx-core';
import { warn } from '@synfutures/logger';
import { formatHexString } from '@synfutures/base-plugins';
import { Subscription } from '@synfutures/db';

const orderFilledQueue = 'order-filled';

type SubscriberConfig = {
    url: string;
};

export class Subscriber extends Plugin {
    private connection: amqplib.Connection;
    private channels = new Map<string, amqplib.Channel>();

    // TODO: positionChanged, ammChanged...
    private orderFilled = new Set<string>();

    constructor(core: Core, private config: SubscriberConfig) {
        super(core);
    }

    private get sdk() {
        const common = this.core.getPlugin('Common');
        if (!common) {
            throw new Error('missing Common plugin');
        }
        return common.sdk;
    }

    private get db() {
        const db = this.core.getPlugin('DB');
        if (!db) {
            throw new Error('missing DB plugin');
        }
        return db;
    }

    private send(queue: string, data: any) {
        const channel = this.channels.get(queue);

        if (!channel) {
            warn('Subscriber', 'missing queue:', queue, 'ignored...');
            return;
        }

        channel.sendToQueue(queue, Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)));
    }

    private onNewParsedEvent = (log: ethers.providers.Log, parsed: ethers.utils.LogDescription, processed: boolean) => {
        if (processed) {
            // ignore processed event...
            return;
        }

        if (parsed.name === 'Fill') {
            const args = parsed.args as unknown as FillEventObject;

            if (this.orderFilled.has(formatHexString(args.trader))) {
                this.send(orderFilledQueue, {
                    address: args.trader,
                    instrument: log.address,
                    expiry: args.expiry,
                    tick: args.tick,
                    nonce: args.nonce,
                });
            }
        }

        // TODO: UpdatePosition...
    };

    /**
     * Subscribe order filled event
     * @param address User address
     * @param persist Is persistence required?
     */
    async subscribeOrderFilled(address: string, persist = true) {
        address = formatHexString(address);

        if (persist) {
            const exists = await Subscription.findOne({
                where: {
                    chainId: this.sdk.ctx.chainId,
                    type: orderFilledQueue,
                    data: { address },
                },
            });

            if (!exists) {
                await Subscription.create({
                    chainId: this.sdk.ctx.chainId,
                    type: orderFilledQueue,
                    data: { address },
                });
            }
        }

        if (!this.channels.has(orderFilledQueue)) {
            const channel = await this.connection.createChannel();
            await channel.assertQueue(orderFilledQueue);

            this.channels.set(orderFilledQueue, channel);
        }

        this.orderFilled.add(address);
    }

    /**
     * Unsubscribe order filled event
     * @param address User address
     */
    async unsubscribeOrderFilled(address: string) {
        address = formatHexString(address);

        await Subscription.destroy({
            where: {
                chainId: this.sdk.ctx.chainId,
                type: orderFilledQueue,
                data: { address },
            },
        });

        this.orderFilled.delete(address);

        if (this.orderFilled.size === 0) {
            const channel = this.channels.get(orderFilledQueue);

            if (channel) {
                this.channels.delete(orderFilledQueue);

                await channel.close();
            }
        }
    }

    /**
     * Lifecycle function
     */
    async onInit() {
        this.connection = await amqplib.connect(this.config.url);

        await this.db.init();

        // loading persistent information
        for (const subscription of await Subscription.findAll({ where: { chainId: this.sdk.ctx.chainId } })) {
            if (subscription.type === orderFilledQueue) {
                await this.subscribeOrderFilled((subscription.data as any).address, false);
            }
        }
    }

    /**
     * Lifecycle function
     */
    async onStart() {
        this.core.nonBlocking.on('newParsedEvent', this.onNewParsedEvent);
    }

    /**
     * Lifecycle function
     */
    async onDestroy() {
        this.core.nonBlocking.off('newParsedEvent', this.onNewParsedEvent);

        for (const channel of this.channels.values()) {
            await channel.close();
        }

        await this.connection.close();
    }
}
