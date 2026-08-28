import assert from 'node:assert/strict';
import { createInflate, constants as zlibConstants } from 'node:zlib';
import { Intents } from '@discordeno/types';
import { delay } from '@discordeno/utils';
import { type CreateGatewayManagerOptions, createGatewayManager, type GatewayManager } from '../../src/manager.js';
import Shard from '../../src/Shard.js';
import { TransportCompression } from '../../src/types.js';

describe('Gateway background work', () => {
  it('Keeps running when the resharding check fails', async () => {
    const errors: string[] = [];
    const gateway = createGatewayManagerWithLogger(errors, {
      enabled: true,
      shardsFullPercentage: 80,
      checkInterval: 10,
      getSessionInfo: async () => {
        throw new Error('The gateway information could not be fetched.');
      },
    });
    // The shards are irrelevant for this test, so they are not actually identified.
    gateway.tellWorkerToIdentify = async () => {};

    await gateway.spawnShards();
    await delay(100);

    clearInterval(gateway.resharding.checkIntervalId);

    assert.ok(errors.some((error) => error.includes('[Resharding]')));
  });

  it('Waits for the presence of every shard to be sent', async () => {
    const gateway = createGatewayManagerWithLogger([]);
    const sent: number[] = [];

    gateway.shards.set(0, { id: 0 } as Shard);
    gateway.shards.set(1, { id: 1 } as Shard);
    gateway.editShardStatus = async (shardId) => {
      await delay(20);
      sent.push(shardId);
    };

    await gateway.editBotStatus({ since: null, afk: false, status: 'online', activities: [] });

    assert.deepEqual(sent.sort(), [0, 1]);
  });

  it('Does not leak the error of a decompression write which is not awaited', async () => {
    const errors: string[] = [];
    const shard = new Shard({
      id: 0,
      connection: {
        compress: false,
        transportCompression: TransportCompression.zlib,
        intents: Intents.Guilds,
        properties: { os: 'linux', browser: 'Discordeno', device: 'Discordeno' },
        token: '',
        totalShards: 1,
        url: 'ws://127.0.0.1:1',
        version: 10,
      },
      events: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: (message) => errors.push(String(message)), fatal: () => {} },
    });

    shard.inflate = createInflate({ finishFlush: zlibConstants.Z_SYNC_FLUSH, chunkSize: 64 * 1024 });
    shard.inflate.on('error', () => {});
    // node:zlib destroys the stream on any decompression error, after which every following write fails.
    shard.inflate.destroy();

    // A frame which does not end with the zlib sync flush marker, so the write promise is abandoned.
    assert.equal(await shard.decompressPacket(Buffer.from([0x78, 0x9c])), null);
    await delay(50);

    assert.ok(errors.some((error) => error.includes('decompression stream')));
  });
});

function createGatewayManagerWithLogger(errors: string[], resharding?: CreateGatewayManagerOptions['resharding']): GatewayManager {
  return createGatewayManager({
    connection: {
      url: 'ws://127.0.0.1:1',
      shards: 1,
      sessionStartLimit: {
        total: 1000,
        remaining: 1000,
        resetAfter: 0,
        maxConcurrency: 1,
      },
    },
    token: '',
    url: 'ws://127.0.0.1:1',
    intents: Intents.Guilds,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: (message) => errors.push(String(message)), fatal: () => {} },
    resharding: resharding ?? {
      enabled: false,
      checkInterval: 0,
      shardsFullPercentage: 0,
    },
  });
}
