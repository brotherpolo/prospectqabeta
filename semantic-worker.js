// Runs open sentence-embedding models off the main thread. Each model downloads once from
// Hugging Face (quantized, 23–34 MB), then the browser caches it.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;
env.useBrowserCache = true;

const loaded = new Map(); // model id -> Promise<extractor>

function load(model) {
  if (!loaded.has(model)) {
    const p = pipeline('feature-extraction', model, {
      quantized: true,
      progress_callback: (e) => {
        if (e.status === 'progress' && e.total) self.postMessage({ type: 'progress', model, file: e.file, loaded: e.loaded, total: e.total });
      },
    });
    p.catch(() => loaded.delete(model));
    loaded.set(model, p);
  }
  return loaded.get(model);
}

self.onmessage = async (e) => {
  const { id, type, texts, model, pooling } = e.data;
  try {
    if (type === 'unload') {
      const p = loaded.get(model);
      loaded.delete(model);
      if (p) { try { (await p).dispose?.(); } catch { /* already gone */ } }
      self.postMessage({ id, type: 'ready' });
      return;
    }
    const extractor = await load(model);
    if (type === 'load') { self.postMessage({ id, type: 'ready' }); return; }
    const out = [];
    for (let i = 0; i < texts.length; i += 16) {
      const res = await extractor(texts.slice(i, i + 16), { pooling: pooling || 'mean', normalize: true });
      out.push(...res.tolist());
    }
    self.postMessage({ id, type: 'result', vectors: out });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message || err) });
  }
};
