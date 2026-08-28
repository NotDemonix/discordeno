import { expect } from 'chai';
import { afterEach, beforeEach, describe, it } from 'mocha';
import sinon from 'sinon';
import { urlToBase64 } from '../src/urlToBase64.js';

describe('urlToBase64.ts', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('urlToBase64 function', () => {
    it('Will convert a png image to base64', async () => {
      const mockArrayBuffer = new ArrayBuffer(8);

      fetchStub.resolves({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: () => Promise.resolve(mockArrayBuffer),
      });

      const url = await urlToBase64('https://example.com/image.png');

      expect(url).equal('data:image/png;base64,AAAAAAAAAAA=');
    });

    it('Will throw on a non ok response', async () => {
      fetchStub.resolves({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      });

      let error: unknown;

      try {
        await urlToBase64('https://example.com/image.png');
      } catch (err) {
        error = err;
      }

      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.equal('Failed to fetch https://example.com/image.png: 404 Not Found');
    });

    it('Will not include the query string in the mime type', async () => {
      fetchStub.resolves({
        ok: true,
        headers: new Headers(),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      });

      const url = await urlToBase64('https://cdn.discordapp.com/avatars/785384884197392384/1234.webp?size=128');

      expect(url).equal('data:image/webp;base64,AAAAAAAAAAA=');
    });
  });
});
