// SPDX-License-Identifier: MIT
//
// The guard's decision when the server cannot be asked whether the vault has a key.
// The guard itself lives in the plugin, which the tests cannot load; the decision is
// kept apart so that it can be checked here.
import test from "node:test";
import assert from "node:assert/strict";
import { mayPassWithoutKeyAnswer } from "./_sync-engine.mjs";

test("a device that has never heard whether the vault has a key does not sync", () => {
	// The vault may hide its names. A pass without the key would write ciphertext
	// names to disk and send readable ones up, where no device with the key sees them.
	assert.equal(mayPassWithoutKeyAnswer(null), false);
});

test("a device told this session that the vault has no key syncs through a hiccup", () => {
	assert.equal(mayPassWithoutKeyAnswer(false), true);
});

test("a device told that the vault has a key does not sync without one", () => {
	assert.equal(mayPassWithoutKeyAnswer(true), false);
});
