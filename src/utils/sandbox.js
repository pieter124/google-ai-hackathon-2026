import { deepEqual } from "./deepEqual.js";
import { runPythonTest } from "./pythonRunner.js";

// Runs candidate JavaScript client-side with no backend. The source is spliced
// as text into a tiny worker script, run in a Web Worker with no access to our
// DOM or state; a setTimeout terminates the worker if the code hangs, so an
// infinite loop can only stall that disposable thread, never the page.
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

// Runs every test case and returns the lastTestResults array shape the app
// expects. JS gets a disposable worker per case; Python goes through the
// persistent Pyodide worker — both resolve to the same { ok, result | error }.
export async function runAllTests(code, testCases, language = "javascript") {
  const results = [];
  for (const tc of testCases) {
    const outcome =
      language === "python" ? await runPythonTest(code, tc.input) : await runInSandbox(code, tc.input);
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
