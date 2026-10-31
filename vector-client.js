/* Vector server adapter — ST core HTTP client for /api/vector/*.
 *
 * Thin and dumb on purpose: every route/schema/auth detail lives here so the
 * rest of the extension never touches fetch. No extension imports; the only
 * ST core dependency is `getRequestHeaders` (CSRF), same tier as script.js.
 * All calls are POST JSON with an abortable timeout; failures throw
 * VectorClientError so the orchestrator can distinguish lifecycle cancels
 * (signal.reason) from real failures.
 */

/* v0.6.0: LAZY import — script.js is browser-only, and a static import made
 * this whole module graph (retriever.js included) un-importable from node
 * tests (T3.6). The header getter is only needed when a real request fires;
 * in the browser the dynamic import resolves to the already-loaded module. */
let getRequestHeadersFn = null;
async function loadRequestHeaders() {
    if (!getRequestHeadersFn) {
        /* Primary source: the global SillyTavern context — no import needed.
           The dynamic import below kept failing at runtime in some loads
           ("loadRequestHeaders(...) is not a function") even though /script.js
           exports the function, silently killing every vector request. */
        const viaContext = globalThis.SillyTavern?.getContext?.()?.getRequestHeaders;
        if (typeof viaContext === 'function') {
            getRequestHeadersFn = viaContext;
            return getRequestHeadersFn;
        }
        console.warn('[Memory Weaver] header getter unavailable via SillyTavern.getContext — falling back to dynamic script.js import.');
        const ns = await import('../../../../script.js');
        console.warn('[Memory Weaver] script.js namespace:', Object.keys(ns ?? {}).length, 'exports | getRequestHeaders:', typeof (ns ?? {}).getRequestHeaders);
        ({ getRequestHeaders: getRequestHeadersFn } = ns);
    }
    return getRequestHeadersFn;
}

export class VectorClientError extends Error {
    constructor(message, status = 0, name = 'VectorClientError') {
        super(message);
        this.name = name;
        this.status = status;
    }
}

async function post(path, body, { timeoutMs = 15000, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('vector request timed out', 'TimeoutError')), Math.max(1000, Number(timeoutMs) || 15000));
    const onExternalAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
        const response = await fetch(`/api/vector/${path}`, {
            method: 'POST',
            /* NOTE: (await loadRequestHeaders())() — the parens are LOAD-
               BEARING. `await loadRequestHeaders()()` parses as
               `await (loadRequestHeaders()())`: the async fn returns a
               PROMISE, the trailing () calls the promise, and every vector
               request dies with "loadRequestHeaders(...) is not a function"
               before fetch (the silent v0.4.0-era killer). */
            headers: (await loadRequestHeaders())(),
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) throw new VectorClientError(`vector ${path} failed with HTTP ${response.status}`, response.status);
        if (path === 'insert' || path === 'delete' || path === 'purge') return true;
        return await response.json();
    } catch (error) {
        if (error instanceof VectorClientError) throw error;
        /* Abort reasons pass through with their own name so the orchestrator
           can tell a lifecycle cancel from a network failure. */
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
            throw new VectorClientError(`vector ${path} aborted (${error.name})`, 0, error.name);
        }
        throw new VectorClientError(`vector ${path} failed: ${error?.message ?? error}`);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);
    }
}

/* source: 'transformers' (server-side local model, free) is the only source
   P2 wires into settings; the adapter accepts any source/model pair the ST
   server supports because the contract is identical. */
export function createVectorClient({ source = 'transformers', model = '', timeoutMs = 15000 } = {}) {
    const base = { source, ...(model ? { model } : {}) };
    return {
        source: base.source,
        listHashes: (collectionId, signal) =>
            post('list', { ...base, collectionId }, { timeoutMs, signal }).then(hashes => {
                /* v0.6.0 (T7.1): a non-array /list response is a protocol
                   violation — throwing (instead of pretending an empty
                   index) prevents a phantom-empty diff from deleting the
                   whole collection. */
                if (!Array.isArray(hashes)) throw new VectorClientError('malformed /list response (expected array)');
                return hashes.map(Number);
            }),
        insertDocuments: (collectionId, items, signal) =>
            post('insert', { ...base, collectionId, items: items.map(({ hash, text, index }) => ({ hash, text, index })) }, { timeoutMs, signal }),
        deleteHashes: (collectionId, hashes, signal) =>
            post('delete', { ...base, collectionId, hashes: hashes.map(Number) }, { timeoutMs, signal }),
        purgeCollection: (collectionId, signal) =>
            post('purge', { ...base, collectionId }, { timeoutMs, signal }),
        query: (collectionId, searchText, topK, signal) =>
            post('query', { ...base, collectionId, searchText, topK }, { timeoutMs, signal }).then(result => {
                /* v0.6.0 (T7.1): missing/null fields mean "no hits" ([]);
                   wrong-typed fields (object/string/number) are a protocol
                   violation — throw, same spirit as protocol 2 (v0.5.2). */
                const metadata = result?.metadata;
                const hashes = result?.hashes;
                if (metadata != null && !Array.isArray(metadata)) throw new VectorClientError('malformed /query response (metadata)');
                if (hashes != null && !Array.isArray(hashes)) throw new VectorClientError('malformed /query response (hashes)');
                return {
                    metadata: Array.isArray(metadata) ? metadata : [],
                    hashes: Array.isArray(hashes) ? hashes.map(Number) : [],
                };
            }),
    };
}
