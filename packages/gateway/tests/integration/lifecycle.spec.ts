import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { GatewayCloseEventCodes, GatewayOpcodes, Intents } from '@discordeno/types';
import { delay } from '@discordeno/utils';
import { createGatewayManager, type GatewayManager } from '../../src/manager.js';
import Shard from '../../src/Shard.js';
import { ShardSocketCloseCodes, ShardState } from '../../src/types.js';
import { creatWSServer } from './websocket.js';

describe('Gateway Shard lifecycle', () => {
  // Mocha does not abort the body of a test which times out, so a test left waiting on a promise that never settles would keep its server and
  // sockets open and the runner would never exit. Anything that holds the event loop open is registered here and torn down in `afterEach`,
  // which does run after a timeout, so a hanging test fails the suite instead of hanging it.
  const teardown: (() => void)[] = [];

  afterEach(() => {
    for (const close of teardown.splice(0)) close();
  });

  /** Start a TCP server on a random port which hands every accepted socket to `onConnection`. */
  async function listen(onConnection: (socket: Socket) => void): Promise<number> {
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      onConnection(socket);
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    teardown.push(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });

    const address = server.address();
    if (typeof address !== 'object' || !address) throw new TypeError('The address of the server should be an non-null object');

    return address.port;
  }

  it('Rejects the connection request when the socket is closed before it opened', async () => {
    // A server which drops the connection instead of answering the upgrade request, so the socket is closed before it ever opened. Dialing a
    // port nothing listens on would do as well, but whether that is refused or silently dropped depends on the machine the test runs on.
    const port = await listen((socket) => socket.destroy());

    const shard = createShard(`ws://127.0.0.1:${port}`);
    // The shard would otherwise start an endless reconnect loop against the server.
    shard.handleClose = async () => {};

    await assert.rejects(shard.connect());
  });

  it('Closes a socket which is still connecting', async () => {
    // A server which accepts the connection but never answers the upgrade request, keeping the socket in the `CONNECTING` state.
    const port = await listen(() => {});

    const shard = createShard(`ws://127.0.0.1:${port}`);
    const connecting = shard.connect().then(
      () => 'resolved',
      () => 'rejected',
    );

    await delay(100);
    assert.equal(shard.socket?.readyState, WebSocket.CONNECTING);

    await shard.close(ShardSocketCloseCodes.Shutdown, 'Shard shutting down while connecting.');

    assert.equal(await connecting, 'rejected');
    assert.equal(shard.state, ShardState.Disconnected);

    // The aborted handshake may not be treated as an unexpected closure, so the shard may not reconnect on its own.
    await delay(100);
    assert.equal(shard.socket, undefined);
  });

  it('Does not throw out of the close handler on an unrecoverable close code', async () => {
    const shard = createShard('ws://127.0.0.1:1');

    await shard.handleClose({ code: GatewayCloseEventCodes.DisallowedIntents, reason: 'Disallowed intent(s)' } as CloseEvent);

    assert.equal(shard.state, ShardState.Offline);
  });

  it('Settles the queued payloads of a shard which is shut down', async () => {
    const shard = createShard('ws://127.0.0.1:1');
    const sending = shard.send({ op: GatewayOpcodes.RequestGuildMembers, d: {} }).then(
      () => 'resolved',
      () => 'rejected',
    );

    await delay(20);
    assert.equal(shard.offlineSendQueue.length, 1);

    await shard.shutdown();

    assert.equal(await sending, 'rejected');
    assert.equal(shard.offlineSendQueue.length, 0);

    // To avoid needing to wait 1m to get the bucket refil timer to fire we cancel it
    clearTimeout(shard.bucket.timeoutId);
  });

  it('Does not send payloads before the shard has identified', async () => {
    const ops: number[] = [];
    const { promise: sent, resolve: resolveSent } = promiseWithResolvers<void>();

    const { port, close } = creatWSServer({
      onMessage: (message) => {
        ops.push(message.op);

        if (message.op === GatewayOpcodes.RequestGuildMembers) resolveSent();
      },
    });

    teardown.push(close);

    const gateway = createGatewayManagerWithPort(port);
    teardown.push(() => {
      for (const shard of gateway.shards.values()) clearTimeout(shard.bucket.timeoutId);
    });
    gateway.events.connected = (shard) => {
      gateway.sendPayload(shard.id, { op: GatewayOpcodes.RequestGuildMembers, d: { guild_id: '1', query: '', limit: 0 } }).catch(() => {});
    };

    await gateway.spawnShards();
    await sent;

    assert.deepEqual(ops, [GatewayOpcodes.Identify, GatewayOpcodes.RequestGuildMembers]);

    await gateway.shutdown(ShardSocketCloseCodes.TestingFinished, 'Testing finished');
  });
});

function createShard(url: string): Shard {
  return new Shard({
    id: 0,
    connection: {
      compress: false,
      transportCompression: null,
      intents: Intents.Guilds,
      properties: { os: 'linux', browser: 'Discordeno', device: 'Discordeno' },
      token: '',
      totalShards: 1,
      url,
      version: 10,
    },
    events: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} },
  });
}

function createGatewayManagerWithPort(port: number): GatewayManager {
  return createGatewayManager({
    connection: {
      url: `ws://localhost:${port}`,
      shards: 1,
      sessionStartLimit: {
        total: 1000,
        remaining: 1000,
        resetAfter: 0,
        maxConcurrency: 1,
      },
    },
    token: '',
    url: `ws://localhost:${port}`,
    intents: Intents.Guilds,
    resharding: {
      enabled: false,
      checkInterval: 0,
      shardsFullPercentage: 0,
    },
  });
}

// Polyfill for https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers
function promiseWithResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;

  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}
