import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  STORAGES,
  VERSION_FILE,
  clearWebCache,
  clearWebCacheIfShellUpdated,
  readRecordedVersion,
  recordVersion,
} = require("./web-cache.js");

function fakeSession({ failOn } = {}) {
  const calls = [];
  return {
    calls,
    async clearCache() {
      calls.push(["clearCache"]);
      if (failOn === "cache") throw new Error("disk");
    },
    async clearStorageData(options) {
      calls.push(["clearStorageData", options]);
      if (failOn === "storage") throw new Error("locked");
    },
  };
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pqp-web-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("clearWebCache", () => {
  it("drops the HTTP cache and the service worker with its precache, and nothing else", async () => {
    const ses = fakeSession();
    await clearWebCache(ses);
    assert.deepEqual(ses.calls, [
      ["clearCache"],
      ["clearStorageData", { storages: ["serviceworkers", "cachestorage"] }],
    ]);
    // Signed in, drafts, IndexedDB: none of these may ever be on the list.
    for (const kept of ["cookies", "localstorage", "indexdb", "websql", "filesystem"]) {
      assert.equal(STORAGES.includes(kept), false);
    }
  });
});

describe("clearWebCacheIfShellUpdated", () => {
  it("clears and records the version the first time a shell runs against a profile", async () => {
    const ses = fakeSession();
    const result = await clearWebCacheIfShellUpdated({
      userDataPath: dir,
      version: "0.1.10",
      session: ses,
    });
    assert.equal(result, "cleared");
    assert.equal(ses.calls.length, 2);
    assert.equal(readRecordedVersion(dir), "0.1.10");
  });

  it("leaves the cache alone when this shell version already ran here", async () => {
    recordVersion(dir, "0.1.10");
    const ses = fakeSession();
    const result = await clearWebCacheIfShellUpdated({
      userDataPath: dir,
      version: "0.1.10",
      session: ses,
    });
    assert.equal(result, "same");
    assert.deepEqual(ses.calls, []);
  });

  it("clears again when the shell has been updated since", async () => {
    recordVersion(dir, "0.1.9");
    const ses = fakeSession();
    const result = await clearWebCacheIfShellUpdated({
      userDataPath: dir,
      version: "0.1.10",
      session: ses,
    });
    assert.equal(result, "cleared");
    assert.equal(readRecordedVersion(dir), "0.1.10");
  });

  it("also clears for a downgrade: any different version is a different shell", async () => {
    recordVersion(dir, "0.2.0");
    const ses = fakeSession();
    assert.equal(
      await clearWebCacheIfShellUpdated({ userDataPath: dir, version: "0.1.9", session: ses }),
      "cleared",
    );
  });

  it("does not record the version when the clear failed, so the next launch tries again, and does not throw", async () => {
    const logged = [];
    for (const failOn of ["cache", "storage"]) {
      const ses = fakeSession({ failOn });
      const result = await clearWebCacheIfShellUpdated({
        userDataPath: dir,
        version: "0.1.10",
        session: ses,
        log: (...args) => logged.push(args.join(" ")),
      });
      assert.equal(result, "failed");
      assert.equal(readRecordedVersion(dir), null);
    }
    assert.equal(logged.length, 2);
  });

  it("treats an unreadable record as no record", async () => {
    writeFileSync(path.join(dir, VERSION_FILE), "{not json");
    const ses = fakeSession();
    assert.equal(
      await clearWebCacheIfShellUpdated({ userDataPath: dir, version: "0.1.10", session: ses }),
      "cleared",
    );
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, VERSION_FILE), "utf8")), {
      version: "0.1.10",
    });
  });

  it("still reports cleared when the record cannot be written", async () => {
    const ses = fakeSession();
    const result = await clearWebCacheIfShellUpdated({
      userDataPath: path.join(dir, "does", "not", "exist"),
      version: "0.1.10",
      session: ses,
    });
    assert.equal(result, "cleared");
  });
});
