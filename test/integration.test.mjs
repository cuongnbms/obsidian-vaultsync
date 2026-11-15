// Two devices, one real server, the real sync engine. Only Obsidian is stubbed.
//
// These are the tests that could not be written before: everything above this file
// checks a piece in isolation, and everything that has actually gone wrong so far
// went wrong between the pieces.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer, makeDevice } from "./harness/device.mjs";
import { VaultCipher } from "./_crypto.mjs";
import { SyncClient } from "./_sync-engine.mjs";

async function twoDevices(options = {}) {
	const server = await startServer();
	const a = await makeDevice(server, "mac", server.tokens.a, options);
	const b = await makeDevice(server, "iphone", server.tokens.b, options);
	return {
		server,
		a,
		b,
		async cleanup() {
			await a.cleanup();
			await b.cleanup();
			await server.stop();
		},
	};
}

test("an edit on one device reaches the other", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("Notes/Yerevan.md", "the cascade\n");
	await a.sync();
	await b.sync();

	assert.equal(await b.vault.read("Notes/Yerevan.md"), "the cascade\n");
});

test("a second round trip carries an edit back", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "one\n");
	await a.sync();
	await b.sync();

	await b.edit("note.md", "one\ntwo\n");
	await b.sync();
	await a.sync();

	assert.equal(await a.vault.read("note.md"), "one\ntwo\n");
});

test("edits to different parts of a note merge without asking", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "one\ntwo\nthree\n");
	await a.sync();
	await b.sync();

	await a.edit("note.md", "ONE\ntwo\nthree\n");
	await b.edit("note.md", "one\ntwo\nTHREE\n");
	await a.sync();
	const report = await b.sync();

	assert.equal(report.conflicts, 0, "a merge that needs no decision must not ask for one");
	assert.equal(await b.vault.read("note.md"), "ONE\ntwo\nTHREE\n");
	await a.sync();
	assert.equal(await a.vault.read("note.md"), "ONE\ntwo\nTHREE\n");
});

test("edits to the same line keep both versions and ask", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "shared\n");
	await a.sync();
	await b.sync();

	await a.edit("note.md", "from the mac\n");
	await b.edit("note.md", "from the phone\n");
	await a.sync();
	await b.sync();

	assert.equal(b.conflicts.length, 1, "the phone should have been asked");
	const pending = b.index.conflicts[0];
	assert.ok(pending, "the conflict has to survive in the index, not just in a notice");
	assert.equal(pending.device, "iphone");
	assert.equal(pending.server_device, "mac", "the other side must be named by its own name");

	const files = await b.vault.snapshot();
	assert.equal(files["note.md"], "from the mac\n", "the note takes the server version");
	assert.equal(files[pending.copy], "from the phone\n", "and this device's version is kept whole");
});

test("keeping both edits writes one note with both texts", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "shared\n");
	await a.sync();
	await b.sync();
	await a.edit("note.md", "from the mac\n");
	await b.edit("note.md", "from the phone\n");
	await a.sync();
	await b.sync();

	await b.engine.resolveConflict("note.md", "merged");
	const merged = await b.vault.read("note.md");
	assert.match(merged, /from the mac/);
	assert.match(merged, /from the phone/);
	assert.equal(b.index.conflicts.length, 0);

	await a.sync();
	assert.equal(await a.vault.read("note.md"), merged, "the decision reaches the other device");
});

test("a deletion on one device removes an untouched file on the other", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("gone.md", "temporary\n");
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.exists("gone.md"), true);

	await a.delete("gone.md");
	await a.sync();
	await b.sync();

	assert.equal(await b.vault.exists("gone.md"), false);
});

test("an edit beats a deletion, in both directions", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "original\n");
	await a.sync();
	await b.sync();

	// Deleted on the mac, edited on the phone at the same time.
	await a.delete("note.md");
	await b.edit("note.md", "original, edited\n");
	await a.sync();
	await b.sync();
	await b.sync();

	assert.equal(await b.vault.exists("note.md"), true, "the edited file must survive");
	await a.sync();
	assert.equal(await a.vault.read("note.md"), "original, edited\n", "and come back on the other side");
});

test("recreating a path after it was deleted supersedes the tombstone, not reconciles against it", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("qwe.md", "original\n");
	await a.sync();
	await b.sync();

	await a.delete("qwe.md");
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.exists("qwe.md"), false, "the deletion must land on the other device first");

	// One more pass lets the pull cursor catch up with this device's own
	// deletion. Without this, the recreate below is masked: the pull phase
	// would still see the pending deletion change, resolve it as a local edit
	// that beat a remote delete, and hand the push phase the tombstone's
	// revision as a side effect — never actually exercising the conflict path
	// this test is for.
	await a.sync();

	// Recreated locally with a fresh base_rev of 0: the server's view is a
	// tombstone, which has no content to reconcile against. Without the fix this
	// throws trying to fetch the tombstone as if it were a revision, the file
	// stays dirty, and every later sync repeats the same failure.
	await a.edit("qwe.md", "recreated\n");
	const report = await a.sync();

	assert.equal(report.errors.length, 0, "it must not loop trying to fetch the tombstone as content");
	assert.equal(report.uploaded, 1);

	await b.sync();
	assert.equal(await b.vault.read("qwe.md"), "recreated\n", "and the recreation must reach the other device");
});

test("a rename travels as a rename", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("old name.md", "body\n");
	await a.sync();
	await b.sync();

	await a.rename("old name.md", "new name.md");
	await a.sync();
	const report = await b.sync();

	assert.equal(await b.vault.read("new name.md"), "body\n");
	assert.equal(await b.vault.exists("old name.md"), false);
	assert.equal(report.renamed, 1, "it must arrive as a move, not as a deletion and a download");
});

test("a device that was away catches up on everything at once", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	for (let i = 0; i < 25; i++) await a.edit(`notes/${i}.md`, `note ${i}\n`);
	await a.sync();

	await b.sync();
	const files = await b.vault.snapshot();
	assert.equal(Object.keys(files).length, 25);
	assert.equal(files["notes/24.md"], "note 24\n");
});

test("syncing twice changes nothing the second time", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "content\n");
	await a.sync();
	await b.sync();

	const second = await b.sync();
	assert.equal(second.downloaded, 0);
	assert.equal(second.uploaded, 0);
	assert.equal(second.conflicts, 0);
	// A quiet pass has to stay quiet, or every device wakes up for nothing forever.
});

test("non-ASCII paths survive a round trip between devices", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	const paths = ["Заметки/Ереван.md", "ノート/東京.md", "Notas/café.md"];
	for (const p of paths) await a.edit(p, `content of ${p}\n`);
	await a.sync();
	await b.sync();

	for (const p of paths) assert.equal(await b.vault.read(p), `content of ${p}\n`);
});

test("with encryption on, the server holds bytes it cannot read", async (t) => {
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const a = await makeDevice(server, "mac", server.tokens.a, { cipher });
	const b = await makeDevice(server, "iphone", server.tokens.b, { cipher });
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	await a.edit("secret.md", "the passphrase to everything is hunter2\n");
	await a.sync();

	const raw = await server.rawBytes(server.tokens.a, "secret.md");
	assert.equal(raw.includes("hunter2"), false, "the plaintext must not be on the server");
	assert.equal(raw.includes("passphrase"), false);

	await b.sync();
	assert.equal(
		await b.vault.read("secret.md"),
		"the passphrase to everything is hunter2\n",
		"and the other device must still read it",
	);
});

test("encrypted content still deduplicates and stays quiet", async (t) => {
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const a = await makeDevice(server, "mac", server.tokens.a, { cipher });
	t.after(async () => {
		await a.cleanup();
		await server.stop();
	});

	await a.edit("note.md", "same content\n");
	await a.sync();
	await a.edit("note.md", "same content\n"); // saved again, unchanged
	const second = await a.sync();

	assert.equal(second.uploaded, 0, "an unchanged file must not become a new revision");
});

test("a binary file changed on both sides keeps both and does not try to merge", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	const bytes = (fill) => {
		const u = new Uint8Array(64);
		u.fill(fill);
		u[0] = 0; // a NUL byte is what marks this as not text
		return Buffer.from(u).toString("binary");
	};

	await a.vault.writeBinary("image.bin", new Uint8Array([0, 1, 2, 3]).buffer);
	await a.edit("image.bin", bytes(1));
	await a.sync();
	await b.sync();

	await a.edit("image.bin", bytes(2));
	await b.edit("image.bin", bytes(3));
	await a.sync();
	await b.sync();

	const pending = b.index.conflicts[0];
	assert.ok(pending, "a binary conflict still has to be reported");
	assert.equal(pending.mergeable, false, "and it must not offer a line-by-line merge");
	assert.equal(await b.vault.exists(pending.copy), true, "both versions stay on disk");
});

test("a note rewritten end to end on one side keeps both and does not offer a merge", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
	await a.edit("long.md", lines.join("\n") + "\n");
	await a.sync();
	await b.sync();

	// Every line now differs from the base: too far apart to line up.
	await a.edit("long.md", lines.join("\r\n") + "\r\n");
	await b.edit("long.md", lines.map((l, i) => (i === 5 ? "line five" : l)).join("\n") + "\n");
	await a.sync();
	await b.sync();

	const pending = b.index.conflicts[0];
	assert.ok(pending, "the two versions still have to be put to a person");
	assert.equal(pending.mergeable, false, "a merge of the whole file is not offered");
	assert.equal(await b.vault.read(pending.copy), lines.map((l, i) => (i === 5 ? "line five" : l)).join("\n") + "\n");
	await assert.rejects(b.engine.resolveConflict("long.md", "merged"), /cannot be merged/);
});

test("a merge asked for after the note was rewritten end to end is refused", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
	const withLine5 = (text) => lines.map((l, i) => (i === 5 ? text : l));
	await a.edit("long.md", lines.join("\n") + "\n");
	await a.sync();
	await b.sync();
	await a.edit("long.md", withLine5("from the mac").join("\n") + "\n");
	await b.edit("long.md", withLine5("from the phone").join("\n") + "\n");
	await a.sync();
	await b.sync();
	assert.equal(b.index.conflicts[0]?.mergeable, true, "an ordinary conflict can be merged");

	// Before choosing, somebody converts the note's line endings.
	const rewritten = withLine5("from the mac").join("\r\n") + "\r\n";
	await b.vault.write("long.md", rewritten);
	await assert.rejects(b.engine.resolveConflict("long.md", "merged"), /cannot be merged/);
	assert.equal(await b.vault.read("long.md"), rewritten, "the note is left as it was");
	assert.equal(b.index.conflicts.length, 1, "and the question stays open");
});

test("choosing this device's version sends it to the other one", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "shared\n");
	await a.sync();
	await b.sync();
	await a.edit("note.md", "from the mac\n");
	await b.edit("note.md", "from the phone\n");
	await a.sync();
	await b.sync();

	await b.engine.resolveConflict("note.md", "mine");
	assert.equal(await b.vault.read("note.md"), "from the phone\n");
	assert.equal(b.index.conflicts.length, 0);

	await a.sync();
	assert.equal(await a.vault.read("note.md"), "from the phone\n");
});

test("choosing the other device's version drops the copy and keeps the note", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "shared\n");
	await a.sync();
	await b.sync();
	await a.edit("note.md", "from the mac\n");
	await b.edit("note.md", "from the phone\n");
	await a.sync();
	await b.sync();

	const copy = b.index.conflicts[0].copy;
	await b.engine.resolveConflict("note.md", "server");
	assert.equal(await b.vault.read("note.md"), "from the mac\n");
	assert.equal(await b.vault.exists(copy), false, "the rejected copy is cleaned up");
	assert.equal(b.index.conflicts.length, 0);
});

test("a rename on one device and an edit on the other lose nothing", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("old.md", "body\n");
	await a.sync();
	await b.sync();

	await a.rename("old.md", "new.md");
	await b.edit("old.md", "body, edited\n");
	await a.sync();
	await b.sync();
	await b.sync();
	await a.sync();

	const everywhere = { ...(await a.vault.snapshot()), ...(await b.vault.snapshot()) };
	const texts = Object.values(everywhere);
	assert.ok(
		texts.some((t) => t.includes("body, edited")),
		"the edit made against the old name must exist somewhere",
	);
});

// A rename the server refuses, or never hears about, is dropped and the file goes up
// as a new one under its new name. The destination used to keep the source's
// revision: its upload was refused against a path the server had never seen, the
// merge then asked for that path and got a 404, on every pass, forever.
async function renameThatFails(t) {
	const net = { down: false, renameFails: false };
	const server = await startServer();
	const a = await makeDevice(server, "mac", server.tokens.a, {
		wrapClient: (c) =>
			new Proxy(c, {
				get(o, k) {
					const v = o[k];
					if (typeof v !== "function") return v;
					return (...args) => {
						if (net.down || (k === "rename" && net.renameFails)) {
							if (k === "rename") net.renameFails = false;
							return Promise.reject(new TypeError("Failed to fetch"));
						}
						return v.apply(o, args);
					};
				},
			}),
	});
	const b = await makeDevice(server, "iphone", server.tokens.b);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});
	return { a, b, net };
}

async function syncCleanly(device) {
	const report = await device.sync();
	assert.deepEqual(report.errors, [], `${device.settings.deviceName}: ${JSON.stringify(report)}`);
	return report;
}

async function newNameKeepsSyncing(a, b) {
	await a.edit("new.md", "body, edited after the rename\n");
	await syncCleanly(a);
	await syncCleanly(a);
	await syncCleanly(b);
	assert.equal(await b.vault.read("new.md"), "body, edited after the rename\n");
}

for (const settled of [false, true]) {
	test(`a rename lost on the network still arrives (synced ${settled ? "twice" : "once"} first)`, async (t) => {
		const { a, b, net } = await renameThatFails(t);
		await a.edit("old.md", "body\n");
		await a.sync();
		if (settled) await a.sync();
		await b.sync();

		await a.rename("old.md", "new.md");
		net.renameFails = true;
		await a.sync();
		await syncCleanly(a);
		await syncCleanly(b);

		assert.equal(await b.vault.read("new.md"), "body\n");
		assert.equal(await b.vault.exists("old.md"), false, "the old name is gone on the other device");
		assert.equal(await a.vault.exists("old.md"), false, "and does not come back here");
		await newNameKeepsSyncing(a, b);
	});
}

test("a rename the server applied but whose answer was lost still arrives once", async (t) => {
	const server = await startServer();
	let lose = false;
	const a = await makeDevice(server, "mac", server.tokens.a, {
		wrapClient: (c) =>
			Object.assign(Object.create(c), {
				async rename(...args) {
					const res = await c.rename(...args);
					if (lose) {
						lose = false;
						throw new TypeError("Failed to fetch");
					}
					return res;
				},
			}),
	});
	const b = await makeDevice(server, "iphone", server.tokens.b);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});
	await a.edit("old.md", "body\n");
	await a.sync();
	await b.sync();

	await a.rename("old.md", "new.md");
	lose = true;
	await a.sync();
	await syncCleanly(a);
	await syncCleanly(b);
	await syncCleanly(b);
	await syncCleanly(a);

	const files = async (d) => Object.keys(await d.vault.snapshot()).sort();
	assert.deepEqual(await files(a), ["new.md"], "no duplicate or conflict copy here");
	assert.deepEqual(await files(b), ["new.md"], "nor on the other device");
	assert.equal(await b.vault.read("new.md"), "body\n");
	await newNameKeepsSyncing(a, b);
});

test("a folder rename that fails does not bring the old folder back", async (t) => {
	const { a, b, net } = await renameThatFails(t);
	// Folders reach the index only from the server, written there as folders.
	await b.clients(null).plain.putFolder("Empty", 0);
	await a.sync();
	assert.equal(await a.vault.exists("Empty"), true);

	await a.rename("Empty", "Blank");
	net.down = true;
	await a.sync().catch(() => {});
	net.down = false;
	await syncCleanly(a);
	await syncCleanly(b);
	await syncCleanly(a);

	assert.equal(await a.vault.exists("Empty"), false, "the renamed folder came back");
	assert.equal(await a.vault.exists("Blank"), true);
});

test("a rename made while the server is unreachable still arrives", async (t) => {
	const { a, b, net } = await renameThatFails(t);
	await a.edit("old.md", "body\n");
	await a.sync();
	await b.sync();

	await a.rename("old.md", "new.md");
	net.down = true;
	await a.sync().catch(() => {});
	net.down = false;
	await syncCleanly(a);
	await syncCleanly(a);
	await syncCleanly(b);

	assert.equal(await b.vault.read("new.md"), "body\n");
	assert.equal(await b.vault.exists("old.md"), false);
	assert.equal(await a.vault.exists("old.md"), false);
	await newNameKeepsSyncing(a, b);
});

test("a rename refused because the other device edited the old name loses nothing", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);
	await a.edit("old.md", "body\n");
	await a.sync();
	await b.sync();
	await b.edit("old.md", "body, edited on the phone\n");
	await b.sync();

	await a.rename("old.md", "new.md");
	await a.sync();
	await syncCleanly(a);
	await syncCleanly(b);
	await syncCleanly(b);

	assert.equal(await b.vault.read("new.md"), "body\n");
	const everywhere = Object.values({ ...(await a.vault.snapshot()), ...(await b.vault.snapshot()) });
	assert.ok(
		everywhere.some((text) => text.includes("body, edited on the phone")),
		"an edit beats the deletion the rename implied",
	);
	await newNameKeepsSyncing(a, b);
});

test("a rename refused because the other device deleted the old name still arrives", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);
	await a.edit("old.md", "body\n");
	await a.sync();
	await b.sync();
	await b.delete("old.md");
	await b.sync();

	await a.rename("old.md", "new.md");
	await a.sync();
	await syncCleanly(a);
	await syncCleanly(b);

	assert.equal(await b.vault.read("new.md"), "body\n");
	assert.equal(await b.vault.exists("old.md"), false);
	assert.equal(await a.vault.exists("old.md"), false);
	await newNameKeepsSyncing(a, b);
});

test("two devices creating the same path from nothing keep both texts", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("same.md", "written on the mac\n");
	await b.edit("same.md", "written on the phone\n");
	await a.sync();
	await b.sync();

	const files = await b.vault.snapshot();
	const all = Object.values(files).join("\n");
	assert.match(all, /written on the mac/);
	assert.match(all, /written on the phone/, "neither first draft may be thrown away");
});

test("excluded paths never leave the device", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	a.settings.excludes.push("private/");
	await a.edit("private/secret.md", "not for the server\n");
	await a.edit("shared.md", "this one travels\n");
	await a.sync();
	await b.sync();

	assert.equal(await b.vault.exists("shared.md"), true);
	assert.equal(await b.vault.exists("private/secret.md"), false);
});

test("a lost index is rebuilt without losing anything", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "content\n");
	await a.sync();
	await b.sync();

	// The index is a cache. Losing it should cost time, not text.
	b.index.reset();
	await b.index.save();
	const report = await b.sync();

	assert.equal(await b.vault.read("note.md"), "content\n");
	assert.equal(report.conflicts, 0, "identical content must not look like a conflict");
});

test("a rename that only changes case arrives intact", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "body\n");
	await a.sync();
	await b.sync();

	await a.rename("note.md", "Note.md");
	await a.sync();
	await b.sync();

	assert.equal(await b.vault.read("Note.md"), "body\n");
});

test("notes written before encryption was turned on still read afterwards", async (t) => {
	const server = await startServer();
	const a = await makeDevice(server, "mac", server.tokens.a);
	t.after(async () => {
		await a.cleanup();
		await server.stop();
	});

	await a.edit("early.md", "written in the clear\n");
	await a.sync();

	const { cipher } = await VaultCipher.create("later passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	a.setCipher(cipher);
	a.index.reset();
	await a.sync();

	assert.equal(await a.vault.read("early.md"), "written in the clear\n");
	// A vault can be encrypted gradually instead of in one frightening step.
});

test("a server that goes away and comes back loses nothing", async (t) => {
	const { server, a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("before.md", "written before the outage\n");
	await a.sync();
	await b.sync();

	// The client keeps working against a server that is simply not answering.
	await a.edit("during.md", "written while it was down\n");
	const url = a.settings.serverUrl;
	a.settings.serverUrl = "http://127.0.0.1:9";
	await a.sync().catch(() => {});
	assert.equal(await a.vault.read("during.md"), "written while it was down\n");

	a.settings.serverUrl = url;
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.read("during.md"), "written while it was down\n");
	void server;
});

test("with paths hidden, the server never learns a file name", async (t) => {
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const pathCipher = await cipher.pathCipher();
	const opts = { cipher, pathCipher };
	const a = await makeDevice(server, "mac", server.tokens.a, opts);
	const b = await makeDevice(server, "iphone", server.tokens.b, opts);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	// A vault says a great deal through its names alone, before anything is opened.
	await a.edit("Job search/Applications.md", "sent to three places\n");
	await a.edit("Job search/Curriculum.md", "the current version\n");
	await a.sync();

	const log = await server.rawChanges(server.tokens.a);
	const asText = JSON.stringify(log);

	// Only words long enough that finding one by chance is not a coin toss. A short
	// string like "CV" turns up in base64 by luck, and an assertion that passes by
	// luck is worse than no assertion: it fails on somebody else's machine, months
	// later, and looks like a real bug.
	for (const word of ["search", "Applications", "Curriculum", "three places", "current version"]) {
		assert.equal(asText.includes(word), false, `the server can see ${JSON.stringify(word)}`);
	}

	// Stronger than looking for words: no path the server stored may be a path the
	// vault would recognise.
	const stored = log.entries.map((e) => e.path);
	assert.equal(stored.length, 2);
	for (const p of stored) {
		assert.equal(p.includes("Job search"), false);
		assert.equal(p.endsWith(".md"), false, "even the kind of file is a leak");
		assert.equal(p.split("/").length, 2, "though the shape of the tree is not hidden");
	}

	await b.sync();
	assert.equal(await b.vault.read("Job search/Applications.md"), "sent to three places\n");
	assert.equal(await b.vault.read("Job search/Curriculum.md"), "the current version\n");
});

test("with paths hidden, content the server wrote in the clear is refused", async (t) => {
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const pathCipher = await cipher.pathCipher();
	const opts = { cipher, pathCipher };
	const a = await makeDevice(server, "mac", server.tokens.a, opts);
	const b = await makeDevice(server, "iphone", server.tokens.b, opts);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	await a.edit("plan.md", "the real plan\n");
	await a.sync();
	await b.sync();

	// The server cannot read the vault, but it can store anything under a name it
	// has seen. Every file in a vault that hides names is sealed, so readable
	// content there was not written by a device with the key. It used to be
	// written to disk as it came, as if from before encryption was turned on.
	const [stored] = (await server.rawChanges(server.tokens.a)).entries;
	const forger = new SyncClient(server.url, server.tokens.a, "server", null);
	await forger.putFile(stored.path, stored.rev, new TextEncoder().encode("forged\n").buffer, Date.now());

	const report = await b.sync();
	assert.equal(await b.vault.read("plan.md"), "the real plan\n");
	assert.match(report.errors.join("\n"), /plan\.md: .*not encrypted/);
});

test("hidden paths survive renames and deletions between devices", async (t) => {
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const opts = { cipher, pathCipher: await cipher.pathCipher() };
	const a = await makeDevice(server, "mac", server.tokens.a, opts);
	const b = await makeDevice(server, "iphone", server.tokens.b, opts);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	await a.edit("notes/first.md", "body\n");
	await a.sync();
	await b.sync();

	await a.rename("notes/first.md", "notes/second.md");
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.read("notes/second.md"), "body\n");
	assert.equal(await b.vault.exists("notes/first.md"), false);

	await a.delete("notes/second.md");
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.exists("notes/second.md"), false);
});

test("a file deleted on one device can be brought back from the other", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("notes/important.md", "the text that mattered\n");
	await a.sync();
	await b.sync();

	await a.delete("notes/important.md");
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.exists("notes/important.md"), false);

	// Deleting never erased anything. This is what makes that true in practice
	// rather than only in the storage layer.
	const gone = await b.engine.deletedFiles();
	const entry = gone.find((f) => f.path === "notes/important.md");
	assert.ok(entry, "the deletion has to be listed as recoverable");

	await b.engine.restore(entry.path, entry.rev, entry.content_rev);
	assert.equal(await b.vault.read("notes/important.md"), "the text that mattered\n");

	await a.sync();
	assert.equal(
		await a.vault.read("notes/important.md"),
		"the text that mattered\n",
		"and it comes back everywhere, not just where it was restored",
	);
});

test("restoring refuses to write over a file that exists", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "first life\n");
	await a.sync();
	await b.sync();
	await a.delete("note.md");
	await a.sync();
	await b.sync();

	// Somebody made a new file at the same path in the meantime.
	await b.edit("note.md", "second life\n");
	const entry = (await b.engine.deletedFiles()).find((f) => f.path === "note.md");
	await assert.rejects(() => b.engine.restore(entry.path, entry.rev, entry.content_rev));
	assert.equal(await b.vault.read("note.md"), "second life\n", "the newer file is untouched");
});

test("deleted files stay recoverable with paths hidden", async (t) => {
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const opts = { cipher, pathCipher: await cipher.pathCipher() };
	const a = await makeDevice(server, "mac", server.tokens.a, opts);
	t.after(async () => {
		await a.cleanup();
		await server.stop();
	});

	await a.edit("Private/note.md", "hidden even by name\n");
	await a.sync();
	await a.delete("Private/note.md");
	await a.sync();

	const gone = await a.engine.deletedFiles();
	assert.equal(gone.length, 1);
	assert.equal(gone[0].path, "Private/note.md", "the list has to show names a person recognises");

	await a.engine.restore(gone[0].path, gone[0].rev, gone[0].content_rev);
	assert.equal(await a.vault.read("Private/note.md"), "hidden even by name\n");
});

test("a conflict whose copy was deleted by hand stops being asked about", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "shared\n");
	await a.sync();
	await b.sync();
	await a.edit("note.md", "from the mac\n");
	await b.edit("note.md", "from the phone\n");
	await a.sync();
	await b.sync();

	const pending = b.index.conflicts[0];
	assert.ok(pending);

	// Deleting the copy is an ordinary way of saying the question needs no answer.
	await b.vault.remove(pending.copy);
	await b.sync();

	assert.equal(b.index.conflicts.length, 0, "the question outlived one of its answers");
});

test("names are only hidden in a vault that starts empty", async (t) => {
	// The guard exists because a vault cannot hold both kinds of path. Turning name
	// hiding on where files already live would upload each of them again under its
	// hidden name and leave the readable copy sitting there.
	const server = await startServer();
	const a = await makeDevice(server, "mac", server.tokens.a);
	t.after(async () => {
		await a.cleanup();
		await server.stop();
	});

	await a.edit("already here.md", "written in the clear\n");
	await a.sync();

	const stats = await (
		await fetch(`${server.url}/v1/stats`, {
			headers: { Authorization: `Bearer ${server.tokens.a}` },
		})
	).json();
	assert.ok(stats.files > 0, "the vault has to be occupied for this to mean anything");
	// The plugin reads exactly this before deciding, which is what the guard hangs on.
});

test("a failed change does not move the cursor past itself", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("first.md", "one\n");
	await a.edit("second.md", "two\n");
	await a.sync();

	// Make writing the first arrival fail, the way an unwritable name does on a phone.
	const realWrite = b.vault.adapter.writeBinary;
	let failed = false;
	b.vault.adapter.writeBinary = async (path, data) => {
		if (!failed && path === "first.md") {
			failed = true;
			throw new Error("could not be opened");
		}
		return realWrite.call(b.vault, path, data);
	};

	const bad = await b.sync();
	assert.ok(bad.errors.length > 0, "the failure has to be reported");
	// The cursor moves on, the change does not get lost: it is kept aside, and the
	// file behind it arrives in the same pass instead of waiting.
	assert.equal(b.index.deferred.length, 1, "the failed change is kept");
	assert.equal(b.index.deferred[0].path, "first.md");
	assert.equal(await b.vault.read("second.md"), "two\n");

	// The next pass, with writing working again, has to pick up what was missed.
	const good = await b.sync();
	assert.equal(good.errors.length, 0);
	assert.equal(await b.vault.read("first.md"), "one\n");
	assert.equal(b.index.deferred.length, 0);
	// Before this, a pass that failed marked the change handled and nothing ever
	// asked for it again: the edit was gone from that device for good.
});

test("reading a vault with a key after reading it without starts over", async (t) => {
	const server = await startServer();
	const a = await makeDevice(server, "mac", server.tokens.a);
	t.after(async () => {
		await a.cleanup();
		await server.stop();
	});

	await a.edit("note.md", "body\n");
	await a.sync(); // uploads; a device does not advance its cursor on its own writes
	await a.sync(); // reads its own change back and moves the cursor past it
	assert.ok(a.index.lastSeq > 0, "the cursor should have moved by now");

	const { cipher } = await VaultCipher.create("passphrase", { iterations: 1, memory_kib: 64 });
	a.setCipher(cipher);
	await a.sync();

	// Whatever was read without the key was read wrongly, so the cursor goes back.
	assert.equal(a.index.readEncrypted, true);
});

test("renaming a folder does not leave the old one behind", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("Finance/2026/budget.md", "numbers\n");
	await a.edit("Finance/passwords.md", "secrets\n");
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.exists("Finance/passwords.md"), true);

	// A folder rename reaches the other device as its files moving one by one. The
	// folder they came from used to stay behind, empty, looking exactly like a
	// duplicate of the folder that was renamed.
	await a.rename("Finance/2026/budget.md", "Money/2026/budget.md");
	await a.rename("Finance/passwords.md", "Money/passwords.md");
	await a.sync();
	await b.sync();

	assert.equal(await b.vault.read("Money/passwords.md"), "secrets\n");
	assert.equal(await b.vault.read("Money/2026/budget.md"), "numbers\n");
	assert.equal(await b.vault.exists("Finance"), false, "the emptied folder stayed behind");
});

test("every folder pruned in one go stops being suppressed afterwards", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("d1/d2/note.md", "text\n");
	await a.sync();
	await b.sync();

	await a.delete("d1/d2/note.md");
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.exists("d1"), false);
	assert.equal(b.engine.isSuppressed("d1/d2"), true, "pruning did not suppress the folder");

	// Each pruned folder is suppressed only for the moment it takes to remove it.
	// The timer used to read a variable the loop had moved on by then, so it lifted
	// nothing and both folders stayed suppressed for good.
	await new Promise((r) => setTimeout(r, 1700));
	assert.equal(b.engine.isSuppressed("d1/d2"), false);
	assert.equal(b.engine.isSuppressed("d1"), false);
});

test("a folder somebody else still uses is left alone", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("Shared/one.md", "first\n");
	await a.edit("Shared/two.md", "second\n");
	await a.sync();
	await b.sync();

	await a.delete("Shared/one.md");
	await a.sync();
	await b.sync();

	assert.equal(await b.vault.exists("Shared/two.md"), true);
	assert.equal(await b.vault.exists("Shared"), true, "a folder with files in it was removed");
});

test("a folder rename in an encrypted vault moves rather than duplicates", async (t) => {
	// The plain-text version of this test passed while the bug was live: the server
	// stores the hash of the ciphertext and the device hashes the plaintext, so the
	// two only agree when nothing is encrypted.
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const opts = { cipher, pathCipher: await cipher.pathCipher() };
	const a = await makeDevice(server, "phone", server.tokens.a, opts);
	const b = await makeDevice(server, "mac", server.tokens.b, opts);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	await a.edit("Finance/2026/budget.md", "numbers\n");
	await a.edit("Finance/passwords.md", "secrets\n");
	await a.sync();
	await b.sync();

	await a.rename("Finance/2026/budget.md", "Money/2026/budget.md");
	await a.rename("Finance/passwords.md", "Money/passwords.md");
	await a.sync();
	const report = await b.sync();

	assert.equal(report.renamed, 2, "both files should have arrived as moves");
	assert.equal(await b.vault.read("Money/passwords.md"), "secrets\n");
	assert.equal(await b.vault.read("Money/2026/budget.md"), "numbers\n");
	assert.equal(await b.vault.exists("Finance"), false, "the old folder stayed behind");
	assert.equal(await b.vault.exists("Finance/passwords.md"), false, "and so did its files");
});

test("a rename lands even when the index has forgotten what it knew", async (t) => {
	// Index entries lose fields in the wild: older versions rebuilt them in several
	// places and dropped the plaintext hash. The decision to move a file must not
	// depend on the index being in perfect health, because on real devices it is not.
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const opts = { cipher, pathCipher: await cipher.pathCipher() };
	const a = await makeDevice(server, "phone", server.tokens.a, opts);
	const b = await makeDevice(server, "mac", server.tokens.b, opts);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	await a.edit("Finance/passwords.md", "secrets\n");
	await a.sync();
	await b.sync();

	// Wound the index the way old versions did.
	const entry = b.index.get("Finance/passwords.md");
	delete entry.plain_hash;
	b.index.set("Finance/passwords.md", entry);

	await a.rename("Finance/passwords.md", "Money/passwords.md");
	await a.sync();
	const report = await b.sync();

	assert.equal(report.renamed, 1, "the move must still be recognised as a move");
	assert.equal(await b.vault.exists("Finance/passwords.md"), false, "no duplicate left behind");
	assert.equal(await b.vault.read("Money/passwords.md"), "secrets\n");

	// And nothing resurrects on the next exchange in either direction.
	await b.sync();
	await a.sync();
	assert.equal(await a.vault.exists("Finance/passwords.md"), false, "nothing came back");
});

test("a deletion lands even when the index has forgotten what it knew", async (t) => {
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const opts = { cipher, pathCipher: await cipher.pathCipher() };
	const a = await makeDevice(server, "phone", server.tokens.a, opts);
	const b = await makeDevice(server, "mac", server.tokens.b, opts);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	await a.edit("note.md", "body\n");
	await a.sync();
	await b.sync();

	const entry = b.index.get("note.md");
	delete entry.plain_hash;
	b.index.set("note.md", entry);

	await a.delete("note.md");
	await a.sync();
	await b.sync();

	// The file was not edited on b, so the deletion must apply rather than being
	// mistaken for an edit and resurrected onto every device.
	assert.equal(await b.vault.exists("note.md"), false, "the deletion was resisted");
	await b.sync();
	await a.sync();
	assert.equal(await a.vault.exists("note.md"), false, "and nothing resurrected");
});

test("wiping the passphrase mid-pass leaks nothing", async (t) => {
	// The cipher is taken once per pass. Read live, it could be swapped to the
	// pass-through by a blur handler while an upload was still running, and the tail
	// of that pass went to the server in plaintext.
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const opts = { cipher, pathCipher: await cipher.pathCipher() };
	const a = await makeDevice(server, "mac", server.tokens.a, opts);
	t.after(async () => {
		await a.cleanup();
		await server.stop();
	});

	for (let i = 0; i < 5; i++) await a.edit(`notes/${i}.md`, `secret number ${i}\n`);
	let swapped = false;
	a.engine["deps"].onProgress = () => {
		if (!swapped) {
			swapped = true;
			a.setCipher({ enabled: false, encrypt: async (d) => d, decrypt: async (d) => d });
		}
	};
	await a.sync();

	const log = await server.rawChanges(server.tokens.a);
	for (const entry of log.entries) {
		const raw = await server.rawBytes(server.tokens.a, entry.path);
		assert.equal(raw.includes("secret number"), false, `${entry.path} went up readable`);
	}
});

test("a vault that existed before the plugin is uploaded on its first sync", async (t) => {
	// The watcher never mentions files that were there before it started, and that
	// is every file in a vault somebody actually wants to sync. The first sync of
	// such a vault used to finish instantly, up to date, having sent nothing.
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	// Written straight to disk, bypassing the index entirely, like a pre-existing vault.
	await a.vault.write("Notes/one.md", "first\n");
	await a.vault.write("Notes/deep/two.md", "second\n");
	await a.vault.write("three.md", "third\n");

	const report = await a.sync();
	assert.equal(report.uploaded, 3, "every pre-existing file must go up");

	await b.sync();
	assert.equal(await b.vault.read("Notes/deep/two.md"), "second\n");
	assert.equal(await b.vault.read("three.md"), "third\n");

	// And a second pass sends nothing again.
	const again = await a.sync();
	assert.equal(again.uploaded, 0);
});

// --- changes made while nobody was watching --------------------------------------
// The watcher only hears about changes while Obsidian and the plugin are running.
// A note edited by another app, or by a sync tool, while the plugin was off used to
// stay on this device forever. vault.write and vault.remove below bypass the
// watcher the same way.

test("a note edited while the plugin was off is sent on the next start", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);
	await a.edit("x.md", "v1\n");
	await a.edit("y.md", "untouched\n");
	await a.sync();
	await b.sync();

	await a.vault.write("x.md", "v2, written by another app\n");
	a.restart();
	const report = await a.sync();
	await b.sync();

	assert.equal(report.uploaded, 1, JSON.stringify(report));
	assert.equal(await b.vault.read("x.md"), "v2, written by another app\n");
	assert.equal(await b.vault.read("y.md"), "untouched\n");
});

test("a note deleted while the plugin was off is deleted everywhere on the next start", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);
	await a.edit("x.md", "keep\n");
	await a.edit("y.md", "delete me\n");
	await a.sync();
	await b.sync();

	await a.vault.remove("y.md");
	a.restart();
	const report = await a.sync();
	await b.sync();

	assert.equal(report.deleted, 1, JSON.stringify(report));
	assert.equal(await b.vault.exists("y.md"), false);
	assert.equal(await b.vault.read("x.md"), "keep\n");
});

test("a note deleted while off and edited elsewhere comes back with the edit", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);
	await a.edit("x.md", "v1\n");
	await a.sync();
	await b.sync();

	await a.vault.remove("x.md");
	await b.edit("x.md", "v2 from the phone\n");
	await b.sync();
	a.restart();
	await a.sync();
	await a.sync();
	await b.sync();

	assert.equal(await a.vault.read("x.md"), "v2 from the phone\n");
	assert.equal(await b.vault.read("x.md"), "v2 from the phone\n");
});

// Most of a vault gone at once is more often a folder that is not there right now
// (an unmounted drive, cloud files evicted from the device) than a decision.
async function vaultOf(t, count) {
	const pair = await twoDevices();
	t.after(pair.cleanup);
	for (let i = 0; i < count; i++) await pair.a.edit(`n${String(i).padStart(2, "0")}.md`, `note ${i}\n`);
	await pair.a.sync();
	await pair.b.sync();
	return pair;
}

test("most of the vault missing at start does not delete it everywhere", async (t) => {
	const { a, b } = await vaultOf(t, 12);
	for (let i = 0; i < 10; i++) await a.vault.remove(`n${String(i).padStart(2, "0")}.md`);
	await a.vault.write("n11.md", "edited while off\n");
	a.restart();
	const report = await a.sync();
	await b.sync();

	assert.equal(report.deleted, 0, JSON.stringify(report));
	assert.match(report.errors.join("\n"), /10 of 12 files are missing/);
	assert.equal(await b.vault.read("n00.md"), "note 0\n", "the other device keeps them");
	assert.equal(await b.vault.read("n11.md"), "edited while off\n", "edits are still found");
});

test("deletions held back at start are sent by a sync started by hand", async (t) => {
	const { a, b } = await vaultOf(t, 12);
	for (let i = 0; i < 10; i++) await a.vault.remove(`n${String(i).padStart(2, "0")}.md`);
	a.restart();
	await a.sync();

	const quiet = await a.sync(); // the timer's next pass
	assert.deepEqual(quiet.errors, [], "said once, not every minute");
	assert.equal(quiet.deleted, 0);

	const byHand = await a.engine.sync(true);
	assert.equal(byHand.deleted, 10, JSON.stringify(byHand));
	await b.sync();
	assert.equal(await b.vault.exists("n00.md"), false);
	assert.equal(await b.vault.read("n10.md"), "note 10\n");
});

test("the warning comes first even when the first pass is started by hand", async (t) => {
	const { a } = await vaultOf(t, 12);
	for (let i = 0; i < 10; i++) await a.vault.remove(`n${String(i).padStart(2, "0")}.md`);
	a.restart();
	const first = await a.engine.sync(true);
	assert.equal(first.deleted, 0, JSON.stringify(first));
	assert.match(first.errors.join("\n"), /10 of 12 files are missing/);
	const second = await a.engine.sync(true);
	assert.equal(second.deleted, 10, JSON.stringify(second));
});

test("a file that cannot be read at start does not hold back the others", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);
	await a.edit("x.md", "v1\n");
	await a.edit("y.md", "v1\n");
	await a.sync();
	await b.sync();

	await a.vault.write("x.md", "v2, but the file is a cloud placeholder now\n");
	await a.vault.write("y.md", "v2\n");
	const readBinary = a.vault.adapter.readBinary;
	a.vault.adapter.readBinary = (p) => (p === "x.md" ? Promise.reject(new Error("EIO")) : readBinary(p));
	a.restart();
	const report = await a.sync();
	await b.sync();

	assert.match(report.errors.join("\n"), /x\.md: EIO/);
	assert.equal(await b.vault.read("y.md"), "v2\n");
	assert.equal(await b.vault.read("x.md"), "v1\n");
	assert.deepEqual((await a.sync()).errors, [], "the next pass goes on as usual");
});

test("a start reads only the files whose time or size changed", async (t) => {
	const { a, b } = await vaultOf(t, 12);
	a.restart();
	await a.sync(); // the first start after the upgrade reads every file once

	const read = [];
	const readBinary = a.vault.adapter.readBinary;
	a.vault.adapter.readBinary = (p) => {
		read.push(p);
		return readBinary(p);
	};
	await a.vault.write("n03.md", "edited while off\n");
	a.restart();
	await a.sync();
	assert.deepEqual(read.filter((p) => !p.startsWith(".index")), ["n03.md", "n03.md"], "the scan, then the upload");
	await b.sync();
	assert.equal(await b.vault.read("n03.md"), "edited while off\n");
});

test("a few files missing in a large vault are deleted without asking", async (t) => {
	const { a, b } = await vaultOf(t, 25);
	for (let i = 0; i < 10; i++) await a.vault.remove(`n${String(i).padStart(2, "0")}.md`);
	a.restart();
	const report = await a.sync();
	assert.equal(report.deleted, 10, JSON.stringify(report));
	await b.sync();
	assert.equal(await b.vault.exists("n09.md"), false);
});

test("unloading the plugin stops a running pass, and the next one finishes the job", async (t) => {
	// A pass is a chain of awaits and unloading does not cancel it. The old copy of
	// an updated plugin kept uploading for two minutes beside its replacement,
	// sending every file twice and overwriting the journal on its way out.
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	for (let i = 0; i < 40; i++) await a.vault.write(`n/${String(i).padStart(2, "0")}.md`, `note ${i}\n`);
	let seen = 0;
	a.engine["deps"].onProgress = () => {
		seen++;
		if (seen === 5) a.stop();
	};
	const first = await a.sync();
	assert.ok(first.uploaded < 40, "the pass must stop early once unloaded");

	a.resume();
	const second = await a.sync();
	assert.equal(first.uploaded + second.uploaded, 40, "nothing sent twice, nothing lost");
	await b.sync();
	assert.equal(await b.vault.read("n/39.md"), "note 39\n");
});

test("a first sync sends notes before attachments", async (t) => {
	// The other device receives in upload order, so on a vault of many notes and a
	// gigabyte of attachments every note is readable there within the first minute.
	// Four uploads run at once, so completion order is not start order: what is
	// guaranteed is that no attachment starts until every note has been taken.
	const { a, cleanup } = await twoDevices();
	t.after(cleanup);

	for (let i = 0; i < 20; i++) await a.vault.write(`note-${String(i).padStart(2, "0")}.md`, `text ${i}\n`);
	await a.vault.writeBinary("scan.pdf", new Uint8Array(2048).buffer);
	await a.vault.writeBinary("photo.png", new Uint8Array(512).buffer);
	await a.sync();

	const order = a.logs.filter((l) => l.includes(" sent ")).map((l) => l.split(" sent ")[1].split(" in ")[0]);
	const failed = a.logs.filter((l) => l.startsWith("push "));
	assert.equal(order.length, 22, `uploads failed: ${failed.join(" | ")}`);
	// With four in flight, an attachment can only start after at least sixteen
	// notes have finished, so the first sixteen completions are all notes.
	assert.ok(order.slice(0, 16).every((p) => p.endsWith(".md")), `notes did not go first: ${order.join(", ")}`);
	// The two attachments are dequeued image first, but they are in flight together,
	// so which one finishes first is the network's choice, not the queue's.
});

// --- turning encryption on later -----------------------------------------------

async function plainPair(t) {
	const server = await startServer();
	const a = await makeDevice(server, "desktop", server.tokens.a);
	const b = await makeDevice(server, "phone", server.tokens.b);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});
	const stats = async () =>
		(await fetch(`${server.url}/v1/stats`, { headers: { Authorization: `Bearer ${server.tokens.a}` } })).json();
	return { server, a, b, stats };
}

test("encryption can be turned on for a vault that is already on the server", async (t) => {
	const { server, a, b, stats } = await plainPair(t);
	await a.edit("notes/plan.md", "the passphrase to everything is hunter2\n");
	await a.edit("todo.md", "buy milk\n");
	await a.vault.writeBinary("img/photo.png", new Uint8Array([1, 2, 3, 4]).buffer);
	await a.sync();
	await b.sync();
	// A file the desktop has not seen yet. It must survive, so the migration takes
	// it in before it erases anything.
	await b.edit("from-phone.md", "phone only\n");
	await b.sync();

	const { cipher, params } = await VaultCipher.create("later is fine");
	const paths = await cipher.pathCipher();
	const { plain, sealed } = a.clients(paths);
	await plain.putVaultKey(params);
	const report = await a.engine.encryptInPlace({ plain, sealed, cipher, paths });
	a.setCipher(cipher);
	a.setPathCipher(paths);

	assert.equal(report.pulled, 1);
	assert.equal(report.uploaded, 4);
	assert.equal(report.erased, 4);
	assert.equal(await a.vault.read("from-phone.md"), "phone only\n");

	// The server: four hidden entries, nothing readable, nothing restorable.
	const live = (await server.rawChanges(server.tokens.a)).entries.filter((e) => !e.deleted);
	assert.equal(live.length, 4);
	for (const e of live) {
		assert.doesNotMatch(e.path, /\.(md|png)$/);
		await paths.decrypt(e.path);
	}
	assert.equal((await stats()).deleted, 0);
	const bytes = await server.rawBytes(server.tokens.a, await paths.encrypt("notes/plan.md"));
	assert.equal(bytes.includes("hunter2"), false);
	assert.equal((await plain.getVaultKey()).migration, undefined);

	// The desktop is settled: another pass moves nothing.
	const again = await a.sync();
	assert.equal(again.uploaded + again.downloaded + again.conflicts, 0, JSON.stringify(again));

	// The phone joins with the passphrase and adopts what it already has, no
	// downloads and no conflicts, then edits flow both ways as before.
	const phoneCipher = await VaultCipher.unlock("later is fine", params);
	b.setCipher(phoneCipher);
	b.setPathCipher(await phoneCipher.pathCipher());
	const joined = await b.sync();
	assert.equal(joined.conflicts, 0, JSON.stringify(joined));
	assert.equal(joined.downloaded, 0, JSON.stringify(joined));
	const onPhone = Object.keys(await b.vault.snapshot()).filter((p) => !p.startsWith(".index")).sort();
	assert.deepEqual(onPhone, ["from-phone.md", "img/photo.png", "notes/plan.md", "todo.md"]);

	await b.edit("todo.md", "buy milk and bread\n");
	await b.sync();
	await a.sync();
	assert.equal(await a.vault.read("todo.md"), "buy milk and bread\n");
	await a.delete("notes/plan.md");
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.exists("notes/plan.md"), false);
});

// A device that excludes a path neither holds the file there nor wants it, so it
// can neither seal it nor erase it: erasing would take the other devices' only copy
// on the server with it. Encryption has to start from a device without that exclude.
async function excludedOnPhone(t) {
	const pair = await plainPair(t);
	const { a, b } = pair;
	a.settings.excludes.push("secret/");
	await b.edit("secret/plan.md", "only on the phone\n");
	await b.edit("n.md", "shared\n");
	await b.sync();
	await a.sync();
	assert.equal(await a.vault.exists("secret/plan.md"), false, "the desktop never takes the excluded file");
	return pair;
}

test("a device that excludes files on the server finds them before any key is set", async (t) => {
	const { a, b } = await excludedOnPhone(t);
	const { plain } = a.clients(null);
	assert.deepEqual(await a.engine.excludedOnServer(plain), ["secret/plan.md"]);
	assert.deepEqual(await b.engine.excludedOnServer(b.clients(null).plain), [], "the phone excludes nothing");
	assert.equal(await plain.getVaultKey(), null, "looking sets nothing");
});

test("encryption stops before touching anything when this device excludes files on the server", async (t) => {
	const { server, a } = await excludedOnPhone(t);
	const { cipher, params } = await VaultCipher.create("pass");
	const paths = await cipher.pathCipher();
	const { plain, sealed } = a.clients(paths);
	await plain.putVaultKey(params);
	const before = (await server.rawChanges(server.tokens.a)).entries;

	await assert.rejects(a.engine.encryptInPlace({ plain, sealed, cipher, paths }), /secret\/plan\.md/);
	assert.deepEqual((await server.rawChanges(server.tokens.a)).entries, before, "nothing pulled, sealed or erased");
	// The key is set and cannot be unset, so the migration stays open and the other
	// devices keep waiting rather than join a vault that is half readable.
	assert.equal((await plain.getVaultKey()).migration?.device, "desktop");

	// Without the exclude the same device finishes the job, the phone's file included.
	a.settings.excludes.length = 0;
	const report = await a.engine.encryptInPlace({ plain, sealed, cipher, paths });
	assert.equal(report.erased, 2);
	const live = (await server.rawChanges(server.tokens.a)).entries.filter((e) => !e.deleted);
	const names = await Promise.all(live.map((e) => paths.decrypt(e.path)));
	assert.deepEqual(names.sort(), ["n.md", "secret/plan.md"]);
	assert.equal(await a.vault.read("secret/plan.md"), "only on the phone\n");
});

test("an interrupted encryption finishes where it stopped, and nobody else writes meanwhile", async (t) => {
	const { server, a, b } = await plainPair(t);
	for (let i = 1; i <= 6; i++) await a.edit(`n${i}.md`, `note ${i}\n`);
	await a.sync();
	await b.sync();

	const { cipher, params } = await VaultCipher.create("pw");
	const paths = await cipher.pathCipher();
	const { plain, sealed } = a.clients(paths);
	await plain.putVaultKey(params);

	// The app dies during the third upload.
	let calls = 0;
	const dying = {
		enabled: true,
		decrypt: (d) => cipher.decrypt(d),
		encrypt: async (d) => {
			if (++calls === 3) a.stop();
			return cipher.encrypt(d);
		},
	};
	await assert.rejects(a.engine.encryptInPlace({ plain, sealed, cipher: dying, paths }), /stopped/);

	// The marker stands, the readable copies are all still there, and the phone
	// cannot write until it is done.
	assert.equal((await plain.getVaultKey()).migration?.device, "desktop");
	const mid = (await server.rawChanges(server.tokens.a)).entries.filter((e) => !e.deleted);
	assert.equal(mid.filter((e) => e.path.endsWith(".md")).length, 6);
	assert.ok(mid.length > 6, "some hidden uploads should have landed before the stop");
	await assert.rejects(
		b.clients(null).plain.putFile("late.md", 0, new TextEncoder().encode("x").buffer, Date.now()),
		/encryption is being turned on from desktop/,
	);

	a.resume();
	const report = await a.engine.encryptInPlace({ plain, sealed, cipher, paths });
	assert.equal(report.uploaded + report.kept, 6);
	assert.ok(report.kept >= 1, "files sent before the stop are not sent again");
	assert.equal(report.erased, 6);
	const live = (await server.rawChanges(server.tokens.a)).entries.filter((e) => !e.deleted);
	assert.equal(live.length, 6);
	assert.equal(live.filter((e) => e.path.endsWith(".md")).length, 0);
	assert.equal((await plain.getVaultKey()).migration, undefined);
	// Each note exactly once under its hidden name.
	const names = await Promise.all(live.map((e) => paths.decrypt(e.path)));
	assert.deepEqual(names.sort(), ["n1.md", "n2.md", "n3.md", "n4.md", "n5.md", "n6.md"]);
});

// --- large files on a phone that sleeps ---------------------------------------------

test("a large download cut off half-way resumes at the last whole slice", async (t) => {
	const server = await startServer();
	const a = await makeDevice(server, "desktop", server.tokens.a);
	let slices = 0;
	const b = await makeDevice(server, "phone", server.tokens.b, {
		chunkBytes: 64 * 1024,
		deferBaseMs: 0,
		wrapClient: (c) =>
			Object.assign(Object.create(c), {
				async getFileRange(...args) {
					// The screen goes dark after the second slice.
					if (++slices === 3) b.stop();
					return c.getFileRange(...args);
				},
			}),
	});
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	const big = new Uint8Array(300 * 1024);
	for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
	await a.vault.writeBinary("deck.pptx", big.buffer);
	await a.edit("after.md", "a note that comes after the big file\n");
	await a.sync();

	const first = await b.sync();
	assert.equal(await b.vault.exists("deck.pptx"), false, "the file is not there yet");
	assert.equal(b.index.deferred.length, 1, JSON.stringify(first));
	assert.equal(b.index.deferred[0].path, "deck.pptx");

	b.resume();
	const second = await b.sync();
	assert.equal(b.index.deferred.length, 0, JSON.stringify(second));
	assert.ok(
		b.logs.some((l) => /resumed deck\.pptx at slice 3 of 5/.test(l)),
		`expected a resume trace, got:\n${b.logs.filter((l) => /deck/.test(l)).join("\n")}`,
	);
	const got = new Uint8Array(await b.vault.readBinary("deck.pptx"));
	assert.equal(got.length, big.length);
	assert.ok(got.every((v, i) => v === big[i]), "bytes must match after the resume");
	assert.equal(await b.vault.read("after.md"), "a note that comes after the big file\n");
});

test("a file that will not download does not hold back the files behind it", async (t) => {
	const server = await startServer();
	const a = await makeDevice(server, "desktop", server.tokens.a);
	let failures = 0;
	const b = await makeDevice(server, "phone", server.tokens.b, {
		deferBaseMs: 0,
		wrapClient: (c) =>
			Object.assign(Object.create(c), {
				async getFile(path, rev) {
					if (path === "poison.md" && failures < 2) {
						failures++;
						throw new Error("the network dropped");
					}
					return c.getFile(path, rev);
				},
			}),
	});
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	await a.edit("first.md", "1\n");
	await a.edit("poison.md", "eventually\n");
	await a.edit("last.md", "3\n");
	await a.sync();

	const one = await b.sync();
	assert.equal(await b.vault.read("first.md"), "1\n");
	assert.equal(await b.vault.read("last.md"), "3\n", "the file behind the failure must arrive");
	assert.equal(await b.vault.exists("poison.md"), false);
	assert.equal(b.index.deferred.length, 1);
	assert.equal(one.errors.length, 1, "the failure is reported once");

	const two = await b.sync();
	assert.equal(two.errors.length, 0, "a repeat failure goes to the journal, not the report");
	assert.equal(b.index.deferred[0].attempts, 2);

	await b.sync();
	assert.equal(await b.vault.read("poison.md"), "eventually\n");
	assert.equal(b.index.deferred.length, 0);
});

test("a pass that unlocks during its own guard still translates every name", async (t) => {
	// The cold-start shape of #3: the passphrase is applied and the path key derived
	// inside the guard, after the pass has already begun. The client must be built
	// after that moment, or the pass reads ciphertext names as local paths.
	const server = await startServer();
	const a = await makeDevice(server, "desktop", server.tokens.a);
	let b;
	// Registered before anything that can throw, so a failed assertion still tears
	// the server down instead of hanging the whole suite on an open handle.
	t.after(async () => {
		await a.cleanup();
		if (b) await b.cleanup();
		await server.stop();
	});

	const { cipher, params } = await VaultCipher.create("cold start");
	const paths = await cipher.pathCipher();
	// A plain client (no path cipher) writes the key record; the device exposes one.
	await a.clients(paths).plain.putVaultKey(params);
	a.setCipher(cipher);
	a.setPathCipher(paths);
	await a.edit("notes/plan.md", "written before the phone woke up\n");
	await a.sync();

	let unlocked = false;
	b = await makeDevice(server, "phone", server.tokens.b, {
		guard: async () => {
			// What applyEncryption does on a cold start, seconds into the pass.
			b.setCipher(cipher);
			b.setPathCipher(await cipher.pathCipher());
			unlocked = true;
			return "";
		},
	});

	const report = await b.sync();
	assert.ok(unlocked, "the guard must have run");
	assert.equal(report.errors.length, 0, JSON.stringify(report));
	assert.equal(await b.vault.read("notes/plan.md"), "written before the phone woke up\n");
	const names = Object.keys(await b.vault.snapshot()).filter((p) => !p.startsWith(".index"));
	assert.deepEqual(names, ["notes/plan.md"], `ciphertext names leaked into the vault: ${names}`);
});

/** A same-line conflict on note.md, recorded on b. Returns the copy's path. */
async function sameLineConflict(a, b, round = "") {
	await a.edit("note.md", `shared${round}\n`);
	await a.sync();
	await b.sync();
	await a.edit("note.md", `from the mac${round}\n`);
	await b.edit("note.md", `from the phone${round}\n`);
	await a.sync();
	await b.sync();
	const copy = b.index.conflicts.find((c) => c.path === "note.md")?.copy;
	assert.ok(copy, "a conflict was recorded");
	return copy;
}

test("a conflict copy stays on the device that made it", async (t) => {
	// The copy exists for the person who has to choose, not for the sync. Uploaded,
	// it reached every device, none of which held a conflict to resolve it by.
	const { server, a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	const copy = await sameLineConflict(a, b);
	await b.sync();
	await a.sync();

	assert.equal(await b.vault.read(copy), "from the phone\n", "the copy is kept here");
	assert.equal(await a.vault.exists(copy), false, "and nowhere else");
	const log = await server.rawChanges(server.tokens.a);
	assert.deepEqual(log.entries.map((e) => e.path), ["note.md"]);
	assert.equal(b.index.get(copy), undefined, "the copy is not tracked");
});

test("an earlier conflict copy stays local when the same note conflicts again", async (t) => {
	// Only one pending conflict is kept per note, so the first copy is no longer
	// named by any conflict once the second is recorded.
	const { server, a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	const first = await sameLineConflict(a, b, " 1");
	// The copy's name carries the device and the minute; a new device name keeps the
	// second copy from landing on the first within the same minute.
	b.settings.deviceName = "iphone 2";
	const second = await sameLineConflict(a, b, " 2");
	assert.notEqual(second, first);
	await b.sync();
	await a.sync();

	assert.equal(await b.vault.read(first), "from the phone 1\n");
	assert.equal(await a.vault.exists(first), false, "the first copy must not be adopted");
	const log = await server.rawChanges(server.tokens.a);
	assert.deepEqual(log.entries.map((e) => e.path), ["note.md"]);
});

test("two conflicts on one note within a minute keep both copies", async (t) => {
	// The copy's name only goes down to the minute. Kept on this device alone, a
	// copy written over by the next one is gone for good.
	const { server, a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	const first = await sameLineConflict(a, b, " 1");
	const second = await sameLineConflict(a, b, " 2");
	assert.notEqual(second, first);
	assert.equal(await b.vault.read(first), "from the phone 1\n");
	assert.equal(await b.vault.read(second), "from the phone 2\n");

	await b.sync();
	await a.sync();
	const log = await server.rawChanges(server.tokens.a);
	assert.deepEqual(log.entries.map((e) => e.path), ["note.md"]);
});

test("a conflict copy an older version uploaded is deleted everywhere once resolved", async (t) => {
	const { server, a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	const copy = await sameLineConflict(a, b);
	// What an earlier version did: the watcher saw the copy and sent it up.
	await b.edit(copy, "from the phone\n");
	await b.sync();
	await a.sync();
	assert.equal(await a.vault.read(copy), "from the phone\n", "the legacy upload reached the mac");

	await b.engine.resolveConflict("note.md", "server");
	await b.sync();
	await a.sync();

	assert.equal(await b.vault.exists(copy), false);
	assert.equal(await a.vault.exists(copy), false, "the removal must reach the other device");
	const log = await server.rawChanges(server.tokens.a);
	assert.equal(log.entries.find((e) => e.path === copy)?.deleted, true);
});

// --- Download everything ---------------------------------------------------------

/** Every path in the vault apart from the index. */
async function vaultPaths(device) {
	return Object.keys(await device.vault.snapshot())
		.filter((p) => !p.startsWith(".index"))
		.sort();
}

test("download everything makes no backup of a file that is already the same", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "the same on both\n");
	await a.sync();
	// A device that has the file but has never synced it.
	await b.vault.write("note.md", "the same on both\n");

	const report = await b.engine.pullAll();
	assert.equal(report.kept, 0, JSON.stringify(report));
	assert.deepEqual(await vaultPaths(b), ["note.md"]);
	assert.equal(b.index.get("note.md")?.dirty ?? false, false);
});

test("download everything keeps a differing file aside, on this device only", async (t) => {
	const { server, a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "the server's version\n");
	await a.sync();
	await b.vault.write("note.md", "this device's version\n");

	const report = await b.engine.pullAll();
	assert.equal(report.kept, 1, JSON.stringify(report));
	assert.equal(await b.vault.read("note.md"), "the server's version\n");
	const backup = (await vaultPaths(b)).find((p) => p !== "note.md");
	assert.ok(backup, "the local version is kept aside");
	assert.equal(await b.vault.read(backup), "this device's version\n");

	await b.sync();
	await a.sync();
	assert.equal(await a.vault.exists(backup), false, "the backup must not be uploaded");
	const log = await server.rawChanges(server.tokens.a);
	assert.deepEqual(log.entries.map((e) => e.path), ["note.md"]);
	assert.equal(await b.vault.read(backup), "this device's version\n");
});

test("download everything leaves a deletion for the next sync instead of resurrecting the file", async (t) => {
	const { server, a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("gone.md", "deleted on the mac\n");
	await a.sync();
	await b.sync();
	await a.delete("gone.md");
	await a.sync();

	await b.engine.pullAll();
	assert.equal(await b.vault.read("gone.md"), "deleted on the mac\n", "a download never deletes");

	await b.sync();
	assert.equal(await b.vault.exists("gone.md"), false, "the next sync applies the deletion");
	await a.sync();
	assert.equal(await a.vault.exists("gone.md"), false, "and the file does not come back");
	const log = await server.rawChanges(server.tokens.a);
	assert.equal(log.entries.find((e) => e.path === "gone.md")?.deleted, true);
});

test("download everything fetches a large file in slices", async (t) => {
	const server = await startServer();
	const a = await makeDevice(server, "desktop", server.tokens.a);
	const b = await makeDevice(server, "phone", server.tokens.b, { chunkBytes: 64 * 1024 });
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	const big = new Uint8Array(300 * 1024);
	for (let i = 0; i < big.length; i++) big[i] = (i * 13) & 0xff;
	await a.vault.writeBinary("deck.pptx", big.buffer);
	await a.sync();

	await b.engine.pullAll();
	assert.ok(
		b.logs.some((l) => /fetching deck\.pptx in 5 slices/.test(l)),
		`expected a sliced fetch, got:\n${b.logs.join("\n")}`,
	);
	const got = new Uint8Array(await b.vault.readBinary("deck.pptx"));
	assert.ok(got.length === big.length && got.every((v, i) => v === big[i]));
});

test("download everything answers to the same barrier as a sync", async (t) => {
	const server = await startServer();
	const a = await makeDevice(server, "desktop", server.tokens.a);
	const b = await makeDevice(server, "phone", server.tokens.b, { guard: () => "the vault is locked" });
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	await a.edit("note.md", "hidden\n");
	await a.sync();

	const report = await b.engine.pullAll();
	assert.equal(report.barrier, "the vault is locked");
	assert.deepEqual(await vaultPaths(b), []);
});

/**
 * A device whose next pass stops inside its first request to the change log until
 * released. Everything else goes through untouched.
 */
async function deviceWithHeldPass(server, name, token) {
	let hold = null;
	let entered = () => {};
	const device = await makeDevice(server, name, token, {
		wrapClient: (c) =>
			Object.assign(Object.create(c), {
				async changes(...args) {
					const h = hold;
					if (h) {
						hold = null;
						entered();
						await h;
					}
					return c.changes(...args);
				},
			}),
	});
	return Object.assign(device, {
		/** Start a pass and resolve once it is parked inside its pull. */
		async startHeldPass() {
			let release;
			hold = new Promise((r) => (release = r));
			const inPull = new Promise((r) => (entered = r));
			const pass = device.sync();
			await inPull;
			return { pass, release };
		},
	});
}

test("restoring a file waits for a running pass instead of interleaving with it", async (t) => {
	const server = await startServer();
	const a = await makeDevice(server, "mac", server.tokens.a);
	const b = await deviceWithHeldPass(server, "iphone", server.tokens.b);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	await a.edit("gone.md", "bring me back\n");
	await a.sync();
	await b.sync();
	await a.delete("gone.md");
	await a.sync();
	await b.sync();
	const entry = (await b.engine.deletedFiles()).find((f) => f.path === "gone.md");
	assert.ok(entry);

	const { pass, release } = await b.startHeldPass();
	let restored = false;
	const restoring = b.engine.restore(entry.path, entry.rev, entry.content_rev).then(() => {
		restored = true;
	});
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(restored, false, "the restore must wait for the pass");
	assert.equal(await b.vault.exists("gone.md"), false, "nothing is written while the pass runs");

	release();
	await pass;
	await restoring;
	assert.equal(await b.vault.read("gone.md"), "bring me back\n");
	await a.sync();
	assert.equal(await a.vault.read("gone.md"), "bring me back\n");
});

test("resolving a conflict waits for a running pass instead of interleaving with it", async (t) => {
	const server = await startServer();
	const a = await makeDevice(server, "mac", server.tokens.a);
	const b = await deviceWithHeldPass(server, "iphone", server.tokens.b);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	await a.edit("note.md", "shared\n");
	await a.sync();
	await b.sync();
	await a.edit("note.md", "from the mac\n");
	await b.edit("note.md", "from the phone\n");
	await a.sync();
	await b.sync();
	const copy = b.index.conflicts[0]?.copy;
	assert.ok(copy, "a conflict to resolve");

	const { pass, release } = await b.startHeldPass();
	let resolved = false;
	const resolving = b.engine.resolveConflict("note.md", "mine").then(() => {
		resolved = true;
	});
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(resolved, false, "the decision must wait for the pass");
	assert.equal(b.index.conflicts.length, 1, "the conflict is still pending while the pass runs");
	assert.equal(await b.vault.read("note.md"), "from the mac\n");

	release();
	await pass;
	await resolving;
	assert.equal(b.index.conflicts.length, 0);
	assert.equal(await b.vault.read("note.md"), "from the phone\n");
	assert.equal(await b.vault.exists(copy), false);
	await a.sync();
	assert.equal(await a.vault.read("note.md"), "from the phone\n");
});

test("download everything waits for a running pass instead of interleaving with it", async (t) => {
	const server = await startServer();
	const a = await makeDevice(server, "mac", server.tokens.a);
	const b = await deviceWithHeldPass(server, "iphone", server.tokens.b);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	await a.edit("note.md", "from the server\n");
	await a.sync();

	const { pass, release } = await b.startHeldPass();
	let pulled = false;
	const pulling = b.engine.pullAll().then(() => {
		pulled = true;
	});
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(pulled, false, "the download must wait for the pass");

	release();
	await pass;
	await pulling;
	assert.equal(await b.vault.read("note.md"), "from the server\n");
});

// "Sync now" pressed while the engine is busy is not dropped: the request is
// remembered, and the plugin schedules a pass once the holder is done.
test("a sync asked for during a pass is remembered once, and the next pass runs", async (t) => {
	const server = await startServer();
	const a = await makeDevice(server, "mac", server.tokens.a);
	const b = await deviceWithHeldPass(server, "iphone", server.tokens.b);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	const { pass, release } = await b.startHeldPass();
	const asked = await b.engine.sync(true);
	assert.deepEqual(asked.errors, []);
	assert.equal(asked.downloaded, 0, "the request does not run alongside the pass");
	await a.edit("late.md", "written during the pass\n");
	await a.sync();

	release();
	await pass;
	assert.equal(b.engine.takeQueued(), true);
	assert.equal(b.engine.takeQueued(), false, "taken once");
	await b.sync();
	assert.equal(await b.vault.read("late.md"), "written during the pass\n");
});

test("a sync asked for while something else holds the engine is remembered", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);
	await a.edit("note.md", "text\n");
	await a.sync();

	const pulling = b.engine.pullAll();
	await b.engine.sync(true);
	await pulling;
	assert.equal(b.engine.takeQueued(), true);
});
