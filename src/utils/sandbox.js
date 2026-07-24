import { deepEqual } from "./deepEqual.js";

// ---------------------------------------------------------------------------
// SANDBOX EXECUTION — runs candidate JavaScript entirely client-side, with no
// backend and no code-execution service (no Judge0, no server sandbox).
//
// The candidate's source is spliced as *text* into a tiny worker script,
// which is handed to the browser as a Blob URL and run inside a real Web
// Worker: a separate thread with no access to our DOM, our state, or the
// network beyond what the worker itself opens. A hard setTimeout guarantees
// that a candidate's infinite loop or runaway recursion can only hang that
// disposable worker thread, never the page — we just terminate() it.
//
// Splicing `code` into the template literal below is safe even if the
// candidate's own code contains backticks or ${...}: by the time `${code}`
// is substituted, we're just building a plain string. The backtick syntax
// only matters while *this* file is being parsed, which happens once, before
// any candidate code exists — the resulting workerCode string is parsed
// fresh, from scratch, by the Worker itself.
// ---------------------------------------------------------------------------
function runInSandbox(code, testInput, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const workerCode = `
      self.onmessage = (e) => {
        try {
          ${code}
          const result = solve(...e.data);
          self.postMessage({ ok: true, result });
        } catch (err) {
          self.postMessage({ ok: false, error: err.message });
        }
      };
    `;
    let worker;
    try {
      worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: "application/javascript" })));
    } catch (err) {
      resolve({ ok: false, error: `Could not start sandbox: ${err.message}` });
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, error: "Timed out (possible infinite loop)" });
    }, timeoutMs);
    worker.onmessage = (e) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ ok: false, error: e.message || "Unknown sandbox error" });
    };
    worker.postMessage(testInput);
  });
}

// Runs every test case for the current problem against the candidate's
// current editor contents, one sandboxed Worker per case, and returns the
// `lastTestResults` array shape the rest of the app expects.
export async function runAllTests(code, testCases) {
  const results = [];
  for (const tc of testCases) {
    const outcome = await runInSandbox(code, tc.input);
    if (outcome.ok) {
      results.push({
        passed: deepEqual(outcome.result, tc.expected),
        input: tc.input,
        expected: tc.expected,
        actual: outcome.result,
      });
    } else {
      results.push({
        passed: false,
        input: tc.input,
        expected: tc.expected,
        actual: null,
        error: outcome.error,
      });
    }
  }
  return results;
}
