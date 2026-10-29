#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
const requireFrom = (relative) => createRequire(new URL(relative, root));
const load = async (require, name) => import(pathToFileURL(require.resolve(name)).href);

for (const relative of ["extensions/acpx/package.json", "extensions/codex/package.json"]) {
  const toml = await load(requireFrom(relative), "smol-toml");
  const parsed = toml.parse('title = "test"');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.deepEqual({ ...parsed }, { title: "test" });
  const document = Object.fromEntries(Array.from({ length: 1000 }, (_, n) => ["key" + n, n]));
  assert.deepEqual({ ...toml.parse(toml.stringify(document)) }, document);
}
const matrix = requireFrom("extensions/matrix/package.json");
const metadata = await load(matrix, "music-metadata");
const wav = Buffer.alloc(46);
wav.write("RIFF", 0);
wav.writeUInt32LE(38, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(2, 40);
assert.equal((await metadata.parseBuffer(wav, { mimeType: "audio/wav" })).format.sampleRate, 8000);

const imap = requireFrom("extensions/imap/package.json");
for (const parent of ["mailauth", "mailparser"]) {
  const require = createRequire(imap.resolve(parent));
  const { default: nodemailer } = await load(require, "nodemailer");
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const sent = await transport.sendMail({
    from: "sender@example.test",
    to: "receiver@example.test",
    subject: "Compatibility",
    text: "Offline",
  });
  assert.match(sent.message.toString(), /Subject: Compatibility/);
  assert.deepEqual(sent.envelope.to, ["receiver@example.test"]);
}
const sdk = createRequire(
  requireFrom("package.json").resolve("@modelcontextprotocol/sdk/client/index.js"),
);
const { Hono } = await load(sdk, "hono");
const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
assert.deepEqual(await (await app.request("http://localhost/health")).json(), { ok: true });
const rateLimit = createRequire(sdk.resolve("express-rate-limit"));
const { Address4 } = await load(rateLimit, "ip-address");
assert.equal(new Address4("192.0.2.1/24").correctForm(), "192.0.2.1");
const ajv = createRequire(sdk.resolve("ajv"));
const { default: uri } = await load(ajv, "fast-uri");
assert.equal(uri.parse("https://example.test/a").host, "example.test");
assert.ok(uri.parse("%6Aavascript:alert(1)").error);
const express = createRequire(requireFrom("package.json").resolve("express"));
const { default: qs } = await load(express, "qs");
assert.deepEqual(qs.parse("filter[name]=test"), { filter: { name: "test" } });
assert.equal(Object.hasOwn(qs.parse("__proto__[polluted]=yes"), "polluted"), false);
const ui = requireFrom("ui/package.json");
const { Client } = await load(ui, "@modelcontextprotocol/client");
const client = new Client({ name: "offline-security-compatibility", version: "1.0.0" });
assert.equal(typeof client.connect, "function");
assert.equal(typeof client.close, "function");
console.log(
  "Dependency compatibility checks passed (TOML, media metadata, offline mail, Hono, IP, URI, query parser, MCP client).",
);
