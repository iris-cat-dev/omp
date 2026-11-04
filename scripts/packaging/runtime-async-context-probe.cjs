// Execute with the selected Desktop executable in ELECTRON_RUN_AS_NODE mode.
// No SDK, user profile, network, credentials, or installed application state.
const assert = require("node:assert/strict");
const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs");
const vm = require("node:vm");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");

async function probe() {
  const context = new AsyncLocalStorage();
  const foreign = vm.runInNewContext("(async read => { await Promise.resolve(); return read(); })");
  const result = await Promise.all(
    ["first", "second"].map((scope) =>
      context.run(scope, async () => {
        await Promise.resolve();
        assert.equal(context.getStore(), scope, "await must retain its own run");
        assert.equal(
          await foreign(() => context.getStore()),
          scope,
          "foreign realm must retain the run",
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(context.getStore(), scope, "async callbacks must retain the run");
        await context.run("nested", async () => {
          await Promise.resolve();
          assert.equal(context.getStore(), "nested");
        });
        return context.getStore();
      }),
    ),
  );
  assert.deepEqual(result, ["first", "second"], "concurrent/nested runs must never mix");
  assert.equal(context.getStore(), undefined, "run must restore caller context");
  context.disable();
  return result;
}

async function main() {
  const main = await probe();
  const worker = new Worker(__filename);
  const completion = Promise.withResolvers();
  let result;
  const timer = setTimeout(() => {
    worker.terminate();
    completion.reject(new Error("Desktop async context worker timed out"));
  }, 15000);
  worker.once("message", (value) => {
    result = value;
  });
  worker.once("error", (error) => {
    clearTimeout(timer);
    completion.reject(error);
  });
  worker.once("exit", (code) => {
    clearTimeout(timer);
    if (code !== 0) completion.reject(new Error(`Desktop async context worker exited ${code}`));
    else completion.resolve(result);
  });
  const threaded = await completion.promise;
  assert.deepEqual(threaded, ["first", "second"]);
  fs.writeSync(1, `${JSON.stringify({ asyncContextPropagation: 1, main, worker: threaded })}\n`);
}

if (isMainThread) {
  main().catch((error) => {
    fs.writeSync(2, `${error.stack}\n`);
    process.exitCode = 1;
  });
} else {
  probe()
    .then((result) => {
      parentPort.postMessage(result);
      parentPort.close();
    })
    .catch((error) => {
      throw error;
    });
}
