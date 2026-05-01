import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createFileXml,
    getWebDAVContentLength,
    onRequest,
} from '../functions/dav/[[path]].js';

class MemoryKV {
    constructor(values = {}, records = {}) {
        this.values = new Map(Object.entries(values));
        this.records = new Map(Object.entries(records));
    }

    async get(key) {
        return this.values.get(key) ?? null;
    }

    async put(key, value) {
        this.values.set(key, value);
    }

    async getWithMetadata(key) {
        return this.records.get(key) ?? null;
    }
}

test('WebDAV PROPFIND uses byte-sized metadata for getcontentlength', () => {
    const xml = createFileXml({
        name: 'photos/cat.png',
        metadata: {
            FileName: 'cat.png',
            FileType: 'image/png',
            FileSize: '0.00',
            FileSizeBytes: 321,
        },
    });

    assert.match(xml, /<D:getcontentlength>321<\/D:getcontentlength>/);
    assert.match(xml, /<D:getcontenttype>image\/png<\/D:getcontenttype>/);
});

test('WebDAV content length falls back to FileSize megabytes for older metadata', () => {
    assert.equal(getWebDAVContentLength({ FileSize: '1.50' }), '1572864');
});

test('WebDAV probed content length overrides stale stored upload size', () => {
    assert.equal(
        getWebDAVContentLength({
            WebDAVContentLength: '68867',
            FileSizeBytes: 456817,
        }),
        '68867'
    );
});

test('WebDAV HEAD uses stored metadata when upstream length is zero', async () => {
    const originalFetch = globalThis.fetch;
    const env = {
        img_url: new MemoryKV(
            {
                'manage@sysConfig@others': JSON.stringify({
                    webDAV: { enabled: true },
                }),
            },
            {
                'folder/photo.png': {
                    value: '',
                    metadata: {
                        FileName: 'photo.png',
                        FileType: 'image/png',
                        FileSizeBytes: 321,
                    },
                },
            }
        ),
    };

    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        assert.equal(url.pathname, '/file/folder/photo.png');
        assert.equal(init.method, 'HEAD');
        return new Response(null, {
            status: 200,
            headers: {
                'Content-Type': 'image/png',
                'Content-Length': '0',
            },
        });
    };

    try {
        const response = await onRequest({
            request: new Request('https://example.com/dav/folder/photo.png', { method: 'HEAD' }),
            env,
        });

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Length'), '321');
        assert.equal(response.headers.get('Content-Type'), 'image/png');
        assert.equal(await response.text(), '');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('WebDAV GET forwards Range headers for preview reads', async () => {
    const originalFetch = globalThis.fetch;
    const env = {
        img_url: new MemoryKV({
            'manage@sysConfig@others': JSON.stringify({
                webDAV: { enabled: true },
            }),
        }),
    };

    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const headers = new Headers(init.headers);
        assert.equal(url.pathname, '/file/folder/photo.png');
        assert.equal(init.method, 'GET');
        assert.equal(headers.get('Range'), 'bytes=0-9');
        return new Response('0123456789', {
            status: 206,
            headers: {
                'Content-Type': 'image/png',
                'Content-Length': '10',
                'Content-Range': 'bytes 0-9/321',
            },
        });
    };

    try {
        const response = await onRequest({
            request: new Request('https://example.com/dav/folder/photo.png', {
                method: 'GET',
                headers: { Range: 'bytes=0-9' },
            }),
            env,
        });

        assert.equal(response.status, 206);
        assert.equal(response.headers.get('Content-Length'), '10');
        assert.equal(response.headers.get('Content-Range'), 'bytes 0-9/321');
        assert.equal(await response.text(), '0123456789');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('WebDAV PROPFIND on a file path returns file metadata', async () => {
    const originalFetch = globalThis.fetch;
    const env = {
        img_url: new MemoryKV(
            {
                'manage@sysConfig@others': JSON.stringify({
                    webDAV: { enabled: true },
                }),
            },
            {
                'folder/photo.png': {
                    value: '',
                    metadata: {
                        FileName: 'photo.png',
                        FileType: 'image/png',
                        FileSizeBytes: 321,
                    },
                },
            }
        ),
    };

    globalThis.fetch = async () => {
        throw new Error('single-file PROPFIND should not list directories');
    };

    try {
        const response = await onRequest({
            request: new Request('https://example.com/dav/folder/photo.png', { method: 'PROPFIND' }),
            env,
        });
        const xml = await response.text();

        assert.equal(response.status, 207);
        assert.match(xml, /<D:href>\/folder\/photo\.png<\/D:href>/);
        assert.match(xml, /<D:getcontentlength>321<\/D:getcontentlength>/);
        assert.doesNotMatch(xml, /<D:collection\/>/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
