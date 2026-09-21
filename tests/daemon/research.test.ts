import { expect, it, vi } from 'vitest';
import { Research, ResearchBody, researchBodyLimitBytes, type ResearchResponse, type ResearchTransport } from '../../src/daemon/research.js';

class FakeTransport implements ResearchTransport {
  readonly resolve = vi.fn(async (_host: string, _signal: AbortSignal) => [{ address: '93.184.216.34' }]);
  readonly get = vi.fn(async (_url: URL, _addresses: readonly { address: string }[], _signal: AbortSignal): Promise<ResearchResponse> => ({ status: 200, contentType: 'text/plain', body: 'evidence', truncated: false }));
}

it('rejects a private DNS result before any request is made', async () => {
  const transport = new FakeTransport();
  transport.resolve.mockResolvedValue([{ address: '127.0.0.1' }]);
  await expect(new Research(['example.com'], transport).read('https://example.com/private', new AbortController().signal)).rejects.toThrow('not public');
  expect(transport.get).not.toHaveBeenCalled();
});

it('revalidates every redirect against the configured host allowlist', async () => {
  const transport = new FakeTransport();
  transport.get.mockResolvedValue({ status: 302, location: 'https://other.example/secret', contentType: 'text/plain', body: '', truncated: false });
  await expect(new Research(['example.com'], transport).read('https://example.com/start', new AbortController().signal)).rejects.toThrow('outside configured');
  expect(transport.resolve).toHaveBeenCalledTimes(1);
  expect(transport.get).toHaveBeenCalledTimes(1);
});

it('bounds response bytes and exposes truncation to the caller', async () => {
  const body = new ResearchBody();
  expect(body.append(Buffer.alloc(researchBodyLimitBytes - 1, 97))).toBe(false);
  expect(body.append(Buffer.from('bc'))).toBe(true);
  expect(Buffer.byteLength(body.value())).toBe(researchBodyLimitBytes);
  expect(body.value().endsWith('b')).toBe(true);

  const transport = new FakeTransport();
  transport.get.mockResolvedValue({ status: 200, contentType: 'text/plain', body: body.value(), truncated: body.truncated });
  await expect(new Research(['example.com'], transport).read('https://example.com/large', new AbortController().signal)).resolves.toMatchObject({ truncated: true, body: body.value() });
});

it('honors an aborted run before DNS or HTTP transport', async () => {
  const transport = new FakeTransport(), controller = new AbortController(); controller.abort();
  await expect(new Research(['example.com'], transport).read('https://example.com/source', controller.signal)).rejects.toThrow();
  expect(transport.resolve).not.toHaveBeenCalled();
  expect(transport.get).not.toHaveBeenCalled();
});
