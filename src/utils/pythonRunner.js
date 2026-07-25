// Runs candidate Python client-side via Pyodide (CPython on WebAssembly) in a
// Web Worker. The worker is persistent — the runtime costs ~10MB to load, so
// it's paid once and reused; a hung loop is stopped by terminating the worker,
// which the next run transparently reloads. Results cross as JSON text so the
// shape matches the JS sandbox and deepEqual/the UI work for both languages.

const PYODIDE_BASE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const LOAD_TIMEOUT_MS = 120000; // first-ever load downloads the runtime
const RUN_TIMEOUT_MS = 5000; // per test, once the runtime is ready

const WORKER_SOURCE = `
  importScripts("${PYODIDE_BASE}pyodide.js");
  let pyodide = null;
  const loading = loadPyodide({ indexURL: "${PYODIDE_BASE}" }).then((p) => {
    pyodide = p;
    self.postMessage({ type: "ready" });
  });
  loading.catch((err) => {
    self.postMessage({ type: "load-error", error: String((err && err.message) || err) });
  });

  self.onmessage = async (e) => {
    const msg = e.data;
    if (!msg || msg.type !== "run") return;
    try {
      await loading;
      pyodide.globals.set("__code", msg.code);
      pyodide.globals.set("__args", msg.argsJson);
      const resultJson = pyodide.runPython(
        'import json as __json\\n' +
        '__ns = {}\\n' +
        'exec(__code, __ns)\\n' +
        'if "solve" not in __ns:\\n' +
        '    raise Exception("Define a function named solve(...)")\\n' +
        '__json.dumps(__ns["solve"](*__json.loads(__args)))'
      );
      self.postMessage({ type: "result", id: msg.id, ok: true, resultJson });
    } catch (err) {
      self.postMessage({ type: "result", id: msg.id, ok: false, error: String((err && err.message) || err) });
    }
  };
`;

let worker = null;
let readyPromise = null;
let nextId = 1;
const pending = new Map(); // id -> resolve

// Drives the "Loading Python runtime…" hint next to the Run button.
let status = "unloaded"; // "unloaded" | "loading" | "ready"
const statusListeners = new Set();

function setStatus(next) {
  status = next;
  for (const listener of statusListeners) listener(status);
}

export function getPythonStatus() {
  return status;
}

export function onPythonStatusChange(listener) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

// Pyodide errors carry a full traceback; the last line is the part worth
// showing in a one-line test result.
function lastTracebackLine(error) {
  const lines = String(error).trim().split("\n").filter((l) => l.trim());
  return lines[lines.length - 1] || String(error);
}

function resetWorker() {
  if (worker) worker.terminate();
  worker = null;
  readyPromise = null;
  setStatus("unloaded");
  for (const [, resolve] of pending) {
    resolve({ ok: false, error: "Python runtime was restarted." });
  }
  pending.clear();
}

function ensureWorker() {
  if (readyPromise) return readyPromise;
  setStatus("loading");
  worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "application/javascript" })));
  readyPromise = new Promise((resolve, reject) => {
    const loadTimer = setTimeout(() => {
      resetWorker();
      reject(new Error("Python runtime took too long to load — check your connection and try again."));
    }, LOAD_TIMEOUT_MS);

    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === "ready") {
        clearTimeout(loadTimer);
        setStatus("ready");
        resolve();
      } else if (msg.type === "load-error") {
        clearTimeout(loadTimer);
        const error = msg.error;
        resetWorker();
        reject(new Error(`Python runtime failed to load: ${error}`));
      } else if (msg.type === "result") {
        const resolvePending = pending.get(msg.id);
        if (resolvePending) {
          pending.delete(msg.id);
          resolvePending(msg);
        }
      }
    };
    worker.onerror = (e) => {
      clearTimeout(loadTimer);
      resetWorker();
      reject(new Error(e.message || "Python runtime crashed."));
    };
  });
  return readyPromise;
}

// Kick off the runtime download in the background so the first Run is fast.
export function preloadPython() {
  return ensureWorker().catch(() => {}); // errors surface on the next run instead
}

// Runs one test case. Resolves { ok: true, result } or { ok: false, error },
// same shape as the JS sandbox; never rejects.
export async function runPythonTest(code, testInput) {
  try {
    await ensureWorker();
  } catch (err) {
    return { ok: false, error: err.message };
  }

  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      // Killing the worker is the only way to stop a hung run.
      resetWorker();
      resolve({ ok: false, error: "Timed out (possible infinite loop) — Python runtime restarted" });
    }, RUN_TIMEOUT_MS);

    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (!msg.ok) {
        resolve({ ok: false, error: lastTracebackLine(msg.error) });
        return;
      }
      try {
        resolve({ ok: true, result: JSON.parse(msg.resultJson) });
      } catch {
        resolve({ ok: false, error: "solve() returned a value that can't be JSON-serialized." });
      }
    });

    worker.postMessage({ type: "run", id, code, argsJson: JSON.stringify(testInput) });
  });
}
