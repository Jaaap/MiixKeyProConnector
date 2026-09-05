"use strict";

/*
 * Manual device probe: how does the MiixKey firmware match a `get-logins`
 * Url against its stored entries? Sends one or more `get-logins` requests
 * with attacker-style partial URLs (".com", empty string, ...) and reports
 * how many entries come back for each.
 *
 * This is NOT part of the automated suite (that is protocol-test.js). It
 * talks to the real device, so run it yourself against a connected, unlocked
 * MiixKey — the Claude Code sandbox cannot reach 172.16.8.1:
 *
 *     node test/probe-url-match.js
 *     node test/probe-url-match.js .com EMPTY https://example.com/
 *
 * Each probe is a real credential request: unless "Trust Browser" is on, the
 * device shows a confirmation you must approve, once per probe.
 *
 * Association: it reuses the existing "MiixKey-02" association rather than
 * creating a new one. The 256-bit key is read, in order, from:
 *   1. env MIIX_KEY (base64) + MIIX_ID (default "MiixKey-02")
 *   2. test/.miix-association.json  ({ "associationId": ..., "associationKey": ... })
 *   3. the Firefox profile's storage for miixkey-pro-connector@local
 * If none yields a key, it prints how to grab it and exits.
 *
 * Dependency-free: only Node built-ins (node:crypto/fs/path/os), so there is
 * no third-party package to vet. Uses node:crypto for AES as an independent
 * implementation, exactly like the mock server in protocol-test.js.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

const EXTENSION_ID = "miixkey-pro-connector@local";
const DEFAULT_ID = "MiixKey-03";
const HOST = process.env.MIIX_HOST || "172.16.8.1";
const PORT = process.env.MIIX_PORT || "19455";
const ENDPOINT = `http://${HOST}:${PORT}/`;
const REVEAL = process.argv.includes("--reveal");

// URLs to probe. `EMPTY` on the command line means the empty string.
const rawArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const PROBES = (rawArgs.length ? rawArgs : [".com", "EMPTY"]).map((a) => (a === "EMPTY" ? "" : a));

// --- AES-256-CBC, matching the extension's crypto (node:crypto side) ---

function encrypt(keyBuf, ivBuf, text) {
	const cipher = nodeCrypto.createCipheriv("aes-256-cbc", keyBuf, ivBuf);
	return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

function decrypt(keyBuf, ivBuf, base64) {
	const decipher = nodeCrypto.createDecipheriv("aes-256-cbc", keyBuf, ivBuf);
	return Buffer.concat([decipher.update(Buffer.from(base64, "base64")), decipher.final()]).toString("utf8");
}

function makeNonce(keyBuf) {
	const iv = nodeCrypto.randomBytes(16);
	const nonce = iv.toString("base64");
	return { iv, nonce, verifier: encrypt(keyBuf, iv, nonce) };
}

// --- Locate the "MiixKey-02" association key ---

function fromEnv() {
	if (!process.env.MIIX_KEY) {
		return null;
	}
	return { associationId: process.env.MIIX_ID || DEFAULT_ID, associationKey: process.env.MIIX_KEY, source: "env MIIX_KEY" };
}

function fromOverrideFile() {
	const file = path.join(__dirname, ".miix-association.json");
	if (!fs.existsSync(file)) {
		return null;
	}
	const data = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!data.associationKey) {
		return null;
	}
	return {
		associationId: data.associationId || DEFAULT_ID,
		associationKey: data.associationKey,
		source: path.relative(process.cwd(), file)
	};
}

// Firefox stores WebExtension storage.local either as a JSON file
// (browser-extension-data/<id>/storage.js) or, when the IndexedDB backend is
// enabled, inside storage/default/moz-extension+++<uuid>/idb/*.sqlite. Scan
// the profiles for both, keeping only an association whose id we want.
function firefoxProfiles() {
	const roots = [
		path.join(os.homedir(), "Library", "Application Support", "Firefox", "Profiles"),
		path.join(os.homedir(), ".mozilla", "firefox")
	];
	const profiles = [];
	for (const root of roots) {
		if (!fs.existsSync(root)) {
			continue;
		}
		for (const name of fs.readdirSync(root)) {
			profiles.push(path.join(root, name));
		}
	}
	return profiles;
}

function fromFirefoxJson(wantId) {
	for (const profile of firefoxProfiles()) {
		const file = path.join(profile, "browser-extension-data", EXTENSION_ID, "storage.js");
		if (!fs.existsSync(file)) {
			continue;
		}
		let data;
		try {
			data = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		if (data.associationKey && data.associationId === wantId) {
			return { associationId: data.associationId, associationKey: data.associationKey, source: file };
		}
	}
	return null;
}

// Best-effort read of the IndexedDB backend: the structured-clone blob in the
// .sqlite file stores the values as plain UTF-8 strings. A 256-bit key is 44
// base64 chars ending in "="; accept one only from a blob that also contains
// the wanted association id, so we do not grab an unrelated string.
function fromFirefoxIdb(wantId) {
	const idRe = Buffer.from(wantId, "utf8");
	const keyRe = /[A-Za-z0-9+/]{43}=/g;
	for (const profile of firefoxProfiles()) {
		const base = path.join(profile, "storage", "default");
		if (!fs.existsSync(base)) {
			continue;
		}
		for (const dir of fs.readdirSync(base)) {
			if (!dir.startsWith("moz-extension+++")) {
				continue;
			}
			const idbDir = path.join(base, dir, "idb");
			if (!fs.existsSync(idbDir)) {
				continue;
			}
			for (const f of fs.readdirSync(idbDir)) {
				if (!f.endsWith(".sqlite")) {
					continue;
				}
				const buf = fs.readFileSync(path.join(idbDir, f));
				if (buf.indexOf(idRe) === -1 || buf.indexOf(Buffer.from("associationKey")) === -1) {
					continue;
				}
				const candidates = [...buf.toString("latin1").matchAll(keyRe)].map((m) => m[0]);
				const keys = [...new Set(candidates)].filter((k) => Buffer.from(k, "base64").length === 32);
				if (keys.length === 1) {
					return { associationId: wantId, associationKey: keys[0], source: path.join(idbDir, f) };
				}
			}
		}
	}
	return null;
}

function loadAssociation() {
	const wantId = process.env.MIIX_ID || DEFAULT_ID;
	const found = fromEnv() || fromOverrideFile() || fromFirefoxJson(wantId) || fromFirefoxIdb(wantId);
	if (!found) {
		console.error(`Could not find the "${wantId}" association key.`);
		console.error("");
		console.error("Get it from the extension: about:debugging#/runtime/this-firefox →");
		console.error("Inspect the MiixKey background page → in the console run");
		console.error('    await browser.storage.local.get(["associationId", "associationKey"])');
		console.error("then re-run with, e.g.:");
		console.error(`    MIIX_KEY='<associationKey>' node test/probe-url-match.js`);
		process.exit(1);
	}
	const keyBuf = Buffer.from(found.associationKey, "base64");
	if (keyBuf.length !== 32) {
		console.error(`Association key is ${keyBuf.length} bytes, expected 32 (256-bit). Source: ${found.source}`);
		process.exit(1);
	}
	return { id: found.associationId, keyBuf, source: found.source };
}

// --- One probe ---

async function probe(assoc, url) {
	const { iv, nonce, verifier } = makeNonce(assoc.keyBuf);
	const request = {
		RequestType: "get-logins",
		TriggerUnlock: false,
		Id: assoc.id,
		Nonce: nonce,
		Verifier: verifier,
		Url: encrypt(assoc.keyBuf, iv, url),
		SubmitUrl: encrypt(assoc.keyBuf, iv, url)
	};

	let response;
	try {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request)
		});
		if (!res.ok) {
			console.log(`  HTTP ${res.status} from device.`);
			return;
		}
		response = await res.json();
	} catch (error) {
		console.log(`  Could not reach ${ENDPOINT}: ${error.message}`);
		return;
	}

	if (!response.Success) {
		const detail = typeof response.Error === "string" && response.Error.trim();
		console.log(`  Success: false${detail ? ` — device: ${detail}` : ""}`);
		return;
	}

	// Entries are encrypted under the response's own Nonce/IV; verify it too.
	let responseIv;
	if (response.Nonce && response.Verifier) {
		responseIv = Buffer.from(response.Nonce, "base64");
		const ok = decrypt(assoc.keyBuf, responseIv, response.Verifier) === response.Nonce;
		if (!ok) {
			console.log("  Response verifier FAILED — not decrypting entries.");
			return;
		}
	} else {
		console.log("  (response carried no verifier)");
	}

	const entries = response.Entries || [];
	const declared = typeof response.Count === "number" ? ` (Count field: ${response.Count})` : "";
	console.log(`  Success: true — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${declared}`);
	for (const entry of entries) {
		const name = entry.Name ? decrypt(assoc.keyBuf, responseIv, entry.Name) : "";
		const login = entry.Login ? decrypt(assoc.keyBuf, responseIv, entry.Login) : "";
		const pw = entry.Password ? decrypt(assoc.keyBuf, responseIv, entry.Password) : "";
		const shown = REVEAL ? pw : "*".repeat(Math.min(pw.length, 8));
		console.log(`    - ${name}  [login: ${login}]  [password: ${shown}]`);
	}
}

// --- Run ---

(async () => {
	const assoc = loadAssociation();
	console.log(`Using association "${assoc.id}" (key from ${assoc.source})`);
	console.log(`Device: ${ENDPOINT}`);
	console.log(`Passwords are ${REVEAL ? "REVEALED (--reveal)" : "masked; pass --reveal to show them"}.`);
	console.log("Each probe may need approval on the device screen.\n");

	for (const url of PROBES) {
		console.log(`Probe Url = ${JSON.stringify(url)}`);
		await probe(assoc, url);
		console.log("");
	}
})().catch((error) => {
	console.error("Probe failed:", error);
	process.exit(1);
});
