// Runs the open sentence-embedding model (all-MiniLM-L6-v2, Apache-2.0) off the main thread.
// The model (~23 MB) downloads once from Hugging Face, then the browser caches it.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL = 'Xenova/all-MiniLM-L6-v2';
let extractor = null;
let loading = null;

function load() {
  loading ||= pipeline('feature-extraction', MODEL, {
    quantized: true,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
      }
    },
  }).then((ex) => { extractor = ex; return ex; });
  return loading;
}

self.onmessage = async (e) => {
  const { id, type, texts } = e.data;
  try {
    await load();
    if (type === 'load') { self.postMessage({ id, type: 'ready' }); return; }
    const out = [];
    for (let i = 0; i < texts.length; i += 16) {
      const res = await extractor(texts.slice(i, i + 16), { pooling: 'mean', normalize: true });
      out.push(...res.tolist());
    }
    self.postMessage({ id, type: 'result', vectors: out });
  } catch (err) {
    loading = null;
    self.postMessage({ id, type: 'error', message: String(err?.message || err) });
  }
};
