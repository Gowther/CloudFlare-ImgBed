import assert from 'node:assert/strict';
import { loadFunction, memoryDatabase } from './helpers/loadFunction.js';
import { createContext } from './helpers/context.js';

describe('WebDAV', () => {
    let db, route, webDAV, calls, fetchHandler, tokenCreations;

    beforeEach(async () => {
        db = memoryDatabase();
        calls = [];
        tokenCreations = 0;
        webDAV = { enabled: true, internalToken: 'internal-test-token' };
        fetchHandler = async () => { throw new Error('Unexpected fetch'); };
        route = await loadFunction('functions/dav/[[path]].js', {
            getDatabase: () => db,
            fetchOthersConfig: async () => ({ webDAV }),
            createApiToken: async (_db, _name, permissions) => {
                assert.ok(permissions.includes('manage'));
                tokenCreations++;
                return { token: 'created-test-token', id: 'created-id' };
            },
        }, {
            fetch: async (url, options = {}) => {
                calls.push({ url: new URL(url), options });
                return fetchHandler(new URL(url), options);
            },
            console: { error() {}, warn() {} },
        });
    });

    function request(method, path = '/dav/photo.png', headers = {}) {
        return route.onRequest(createContext(`https://imgbed.invalid${path}`, { method, headers }));
    }

    async function putFile(name = 'photo.png', metadata = {}) {
        await db.put(name, '', { metadata: { FileType: 'image/png', FileSizeBytes: 321, ...metadata } });
    }

    it('advertises HEAD while retaining MOVE, root redirects and Basic authentication', async () => {
        const options = await request('OPTIONS');
        assert.match(options.headers.get('Allow'), /\bHEAD\b/);
        assert.match(options.headers.get('Allow'), /\bMOVE\b/);
        assert.equal(options.headers.get('DAV'), '1');
        const redirect = await request('PROPFIND', '/dav');
        assert.equal(redirect.status, 301);
        assert.equal(redirect.headers.get('Location'), 'https://imgbed.invalid/dav/');
        webDAV.username = 'test-user';
        webDAV.password = 'test-password';
        assert.equal((await request('HEAD')).status, 401);
        assert.equal(calls.length, 0);
    });

    it('forwards range and conditional headers and preserves partial downloads', async () => {
        fetchHandler = async (url, options) => {
            assert.equal(url.pathname, '/file/photo.png');
            assert.equal(options.method, 'GET');
            const headers = new Headers(options.headers);
            assert.equal(headers.get('Range'), 'bytes=0-9');
            assert.equal(headers.get('If-Range'), '"image-version"');
            assert.equal(headers.get('Cache-Control'), 'no-cache');
            assert.equal(headers.get('Authorization'), null);
            assert.equal(headers.get('Cookie'), null);
            return new Response('0123456789', {
                status: 206,
                headers: { 'Content-Length': '10', 'Content-Range': 'bytes 0-9/321', ETag: '"image-version"' },
            });
        };
        const response = await request('GET', '/dav/photo.png', {
            Range: 'bytes=0-9', 'If-Range': '"image-version"', 'Cache-Control': 'no-cache',
            Authorization: 'Basic private-credentials', Cookie: 'private-cookie',
        });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('Content-Range'), 'bytes 0-9/321');
        assert.equal(response.headers.get('Content-Length'), '10');
        assert.equal(await response.text(), '0123456789');
    });

    it('preserves a conditional 304 and forwards cache validators', async () => {
        fetchHandler = async (_url, options) => {
            const headers = new Headers(options.headers);
            assert.equal(headers.get('If-None-Match'), '"unchanged"');
            assert.equal(headers.get('If-Modified-Since'), 'Wed, 21 Oct 2026 00:00:00 GMT');
            assert.equal(headers.get('Pragma'), 'no-cache');
            return new Response(null, { status: 304, headers: { ETag: '"unchanged"' } });
        };
        const response = await request('GET', '/dav/photo.png', {
            'If-None-Match': '"unchanged"', 'If-Modified-Since': 'Wed, 21 Oct 2026 00:00:00 GMT', Pragma: 'no-cache',
        });
        assert.equal(response.status, 304);
        assert.equal(response.headers.get('ETag'), '"unchanged"');
        assert.equal(response.body, null);
    });

    it('preserves unsatisfied ranges and their total-length header', async () => {
        fetchHandler = async () => new Response('Invalid range', { status: 416, headers: { 'Content-Range': 'bytes */321' } });
        const response = await request('GET', '/dav/photo.png', { Range: 'bytes=999-' });
        assert.equal(response.status, 416);
        assert.equal(response.headers.get('Content-Range'), 'bytes */321');
    });

    it('removes a bogus zero length without discarding a streamed GET body', async () => {
        fetchHandler = async () => new Response('actual file', { headers: { 'Content-Length': '0' } });
        const response = await request('GET');
        assert.equal(response.headers.get('Content-Length'), null);
        assert.equal(await response.text(), 'actual file');
    });

    it('uses the actual upstream HEAD length instead of stale stored metadata', async () => {
        await putFile('photo.png', { FileSizeBytes: 456817 });
        fetchHandler = async (_url, options) => {
            assert.equal(options.method, 'HEAD');
            return new Response(null, { headers: { 'Content-Length': '68867', 'Content-Type': 'image/png' } });
        };
        const response = await request('HEAD');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Length'), '68867');
        assert.equal(response.body, null);
    });

    for (const contentLength of [null, '0', 'invalid']) {
        it(`falls back to exact byte metadata for HEAD with upstream length ${contentLength}`, async () => {
            await putFile();
            fetchHandler = async () => new Response(null, {
                headers: contentLength === null ? {} : { 'Content-Length': contentLength },
            });
            const response = await request('HEAD');
            assert.equal(response.headers.get('Content-Length'), '321');
            assert.equal(response.body, null);
        });
    }

    it('does not invent HEAD lengths from rounded megabytes or overwrite range lengths', async () => {
        await putFile('photo.png', { FileSizeBytes: undefined, FileSize: '1.50' });
        fetchHandler = async () => new Response(null);
        assert.equal((await request('HEAD')).headers.get('Content-Length'), null);
        fetchHandler = async () => new Response(null, { status: 206, headers: { 'Content-Range': 'bytes 0-9/321', 'Content-Length': '10' } });
        const partial = await request('HEAD', '/dav/photo.png', { Range: 'bytes=0-9' });
        assert.equal(partial.status, 206);
        assert.equal(partial.headers.get('Content-Length'), '10');
    });

    it('keeps HEAD error responses bodyless and checks directory existence', async () => {
        fetchHandler = async () => new Response('Missing', { status: 404 });
        const missing = await request('HEAD');
        assert.equal(missing.status, 404);
        assert.equal(missing.body, null);
        await putFile('photos/photo.png');
        assert.equal((await request('HEAD', '/dav/')).status, 200);
        assert.equal((await request('HEAD', '/dav/photos/')).status, 200);
        assert.equal((await request('HEAD', '/dav/missing/')).status, 404);
        fetchHandler = async () => { throw new Error('upstream unavailable'); };
        const failed = await request('HEAD');
        assert.equal(failed.status, 502);
        assert.equal(failed.body, null);
    });

    for (const [metadata, expected] of [
        [{ FileSizeBytes: 321 }, 321],
        [{ FileSizeBytes: 0, FileSize: '1.5' }, 0],
        [{ FileSizeBytes: undefined, FileSize: '1.50' }, 1572864],
        [{ FileSizeBytes: 'invalid', 'File-Size': 42 }, 42],
        [{ FileSizeBytes: -1, ContentLength: 64 }, 64],
    ]) {
        it(`returns a single-file PROPFIND with validated length ${expected}`, async () => {
            await putFile('photo.png', metadata);
            const response = await request('PROPFIND');
            assert.equal(response.status, 207);
            const xml = await response.text();
            assert.ok(xml.includes(`<D:getcontentlength>${expected}</D:getcontentlength>`));
            assert.match(xml, /<D:href>\/dav\/photo.png<\/D:href>/);
            assert.doesNotMatch(xml, /<D:collection\/>/);
            assert.equal(calls.length, 0);
        });
    }

    it('probes historical Telegram files with the internal token without rewriting the database', async () => {
        webDAV.internalToken = undefined;
        await putFile('photo.png', { Channel: 'TelegramNew', FileSizeBytes: 456817 });
        fetchHandler = async (url, options) => {
            assert.equal(url.pathname, '/file/photo.png');
            assert.equal(url.searchParams.get('from'), 'admin');
            assert.equal(options.method, 'HEAD');
            assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer created-test-token');
            assert.ok(options.signal instanceof AbortSignal);
            return new Response(null, { headers: { 'Content-Length': '68867' } });
        };
        const response = await request('PROPFIND');
        assert.match(await response.text(), /<D:getcontentlength>68867<\/D:getcontentlength>/);
        assert.equal(tokenCreations, 1);
        assert.equal(JSON.parse(await db.get('manage@sysConfig@others')).webDAV.internalToken, 'created-test-token');
        assert.equal((await db.getWithMetadata('photo.png')).metadata.FileSizeBytes, 456817);
        assert.equal((await db.getWithMetadata('photo.png')).metadata.WebDAVContentLength, undefined);
    });

    for (const result of ['missing', 'zero', 'invalid', 'failed', 'timeout', 'encoded']) {
        it(`keeps known metadata when a historical size probe is ${result}`, async () => {
            await putFile('photo.png', { Channel: 'Telegram', FileSizeBytes: 456817 });
            fetchHandler = async () => {
                if (result === 'timeout') throw new DOMException('Probe timed out', 'TimeoutError');
                const headers = result === 'missing' ? {} : { 'Content-Length': result === 'invalid' ? 'unknown' : result === 'zero' ? '0' : '10' };
                if (result === 'encoded') headers['Content-Encoding'] = 'gzip';
                return new Response(null, { status: result === 'failed' ? 502 : 200, headers });
            };
            const response = await request('PROPFIND');
            assert.equal(response.status, 207);
            assert.match(await response.text(), /<D:getcontentlength>456817<\/D:getcontentlength>/);
        });
    }

    it('probes directory listings with bounded concurrency and skips chunked/non-Telegram files', async () => {
        for (let index = 0; index < 6; index++) await putFile(`photos/${index}.png`, { Channel: 'TelegramNew' });
        await putFile('photos/chunked.png', { Channel: 'TelegramNew', IsChunked: true });
        await putFile('photos/r2.png', { Channel: 'CloudflareR2' });
        let active = 0, maximum = 0, probes = 0;
        fetchHandler = async (url) => {
            if (url.pathname === '/api/manage/list') {
                assert.equal(url.searchParams.get('dir'), 'photos');
                return Response.json({ files: (await db.list({ prefix: 'photos/' })).keys, directories: [] });
            }
            probes++;
            maximum = Math.max(maximum, ++active);
            await new Promise(resolve => setImmediate(resolve));
            active--;
            return new Response(null, { headers: { 'Content-Length': '123' } });
        };
        const response = await request('PROPFIND', '/dav/photos/');
        assert.equal(response.status, 207);
        const xml = await response.text();
        assert.equal((xml.match(/<D:getcontentlength>123<\/D:getcontentlength>/g) || []).length, 6);
        assert.equal((xml.match(/<D:getcontentlength>321<\/D:getcontentlength>/g) || []).length, 2);
        assert.equal(probes, 6);
        assert.equal(maximum, 4);
    });

    it('retains Depth: 0, missing-path 404s, timestamps and escaped XML paths', async () => {
        const name = 'a&b/photo#<tag>.png';
        await putFile(name, { TimeStamp: Date.UTC(2026, 0, 1), FileType: 'image/png; name="a&b"' });
        const directory = await request('PROPFIND', '/dav/a%26b/', { Depth: '0' });
        const directoryXml = await directory.text();
        assert.match(directoryXml, /<D:href>\/dav\/a%26b\/<\/D:href>/);
        assert.match(directoryXml, /<D:displayname>a&amp;b<\/D:displayname>/);
        assert.doesNotMatch(directoryXml, /getcontentlength/);
        assert.equal(calls.length, 0);
        const file = await request('PROPFIND', '/dav/a%26b/photo%23%3Ctag%3E.png');
        const fileXml = await file.text();
        assert.match(fileXml, /<D:href>\/dav\/a%26b\/photo%23%3Ctag%3E.png<\/D:href>/);
        assert.match(fileXml, /photo#&lt;tag&gt;.png/);
        assert.match(fileXml, /name=&quot;a&amp;b&quot;/);
        assert.match(fileXml, /2026-01-01T00:00:00.000Z/);
        assert.equal((await request('PROPFIND', '/dav/does-not-exist')).status, 404);
        fetchHandler = async url => {
            assert.equal(url.pathname, '/file/a%26b/photo%23%3Ctag%3E.png');
            assert.equal(url.hash, '');
            return new Response('image');
        };
        assert.equal((await request('GET', '/dav/a%26b/photo%23%3Ctag%3E.png')).status, 200);
    });

    it('retains MOVE and its internal-token rename request', async () => {
        await putFile('photo.png');
        fetchHandler = async (url, options) => {
            assert.equal(url.pathname, '/api/manage/rename/photo.png');
            assert.equal(options.method, 'POST');
            assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer internal-test-token');
            assert.deepEqual(JSON.parse(options.body), { newFileId: 'renamed.png' });
            return Response.json({ success: true });
        };
        const response = await request('MOVE', '/dav/photo.png', { Destination: 'https://imgbed.invalid/dav/renamed.png' });
        assert.equal(response.status, 201);
    });
});
