import { EventEmitter } from 'events';
import type { Channel } from 'amqplib';
import { keepSubscribed } from '@ticketing/messaging/dist/consumer';
import { closeConnection } from '@ticketing/messaging/dist/connection';

const flush = () => new Promise((resolve) => jest.requireActual('timers').setImmediate(resolve));

describe('Consumer resubscribe after the broker drops the channel', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  jest.spyOn(console, 'error').mockImplementation(() => {});

  it('subscribes again when the channel closes, retrying while the broker is still down', async () => {
    const channels: EventEmitter[] = [];
    let brokerUp = true;
    const subscribe = jest.fn(async () => {
      if (!brokerUp) throw new Error('ECONNREFUSED');
      const channel = new EventEmitter();
      channels.push(channel);
      return channel as unknown as Channel;
    });

    await keepSubscribed('test-queue', subscribe);
    expect(subscribe).toHaveBeenCalledTimes(1);

    brokerUp = false;
    channels[0].emit('error', new Error('connection closed')); // must not crash the process
    channels[0].emit('close');

    jest.advanceTimersByTime(1000);
    await flush();
    expect(subscribe).toHaveBeenCalledTimes(2); // tried, broker still down

    brokerUp = true;
    jest.advanceTimersByTime(1000);
    await flush();
    expect(subscribe).toHaveBeenCalledTimes(3);
    expect(channels).toHaveLength(2); // a live channel again

    jest.advanceTimersByTime(10_000);
    await flush();
    expect(subscribe).toHaveBeenCalledTimes(3); // no extra subscriptions once healthy
  });

  it('does not resubscribe after an intentional closeConnection()', async () => {
    const channel = new EventEmitter();
    const subscribe = jest.fn(async () => channel as unknown as Channel);

    await keepSubscribed('test-queue', subscribe);
    await closeConnection(); // no live connection in this test; just marks shutdown
    channel.emit('close');

    jest.advanceTimersByTime(10_000);
    await flush();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
