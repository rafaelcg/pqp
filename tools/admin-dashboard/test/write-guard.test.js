import { strict as assert } from "node:assert";
import test from "node:test";
import { writeRefusal } from "../src/write-guard.js";

/**
 * What stops a page on another site from making the operator's browser (which
 * holds the dashboard's Basic Auth) write through the Worker. The cases are the
 * shapes a cross-site page can actually send.
 */
const HERE = "https://pqp-admin.example.workers.dev";
const h = (obj) => new Headers(obj);

test("the dashboard's own write passes: JSON, same origin", () => {
  assert.equal(writeRefusal(h({ "Content-Type": "application/json", Origin: HERE, "Sec-Fetch-Site": "same-origin" }), HERE), null);
  assert.equal(writeRefusal(h({ "Content-Type": "application/json; charset=utf-8" }), HERE), null, "a client that sends no Origin (curl) is not a browser");
});

test("a simple cross-site POST (text/plain, no preflight) is refused before it is forwarded", () => {
  for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
    const refusal = writeRefusal(h(type ? { "Content-Type": type } : {}), HERE);
    assert.equal(refusal?.status, 415, `content type ${JSON.stringify(type)}`);
  }
});

test("JSON from another origin is refused too, whatever the browser said about the site", () => {
  assert.equal(writeRefusal(h({ "Content-Type": "application/json", Origin: "https://evil.example" }), HERE)?.status, 403);
  assert.equal(writeRefusal(h({ "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }), HERE)?.status, 403);
  assert.equal(writeRefusal(h({ "Content-Type": "application/json", "Sec-Fetch-Site": "same-site" }), HERE)?.status, 403);
});

test("a type that merely starts with application/json is not JSON", () => {
  assert.equal(writeRefusal(h({ "Content-Type": "application/jsonp" }), HERE)?.status, 415);
});
