"use strict";

/*
 * Protocol round-trip test. Loads the real extension client
 * (keepasshttp.js) in Node and points it at an in-process mock
 * KeePassHTTP server that uses node:crypto as an independent AES-256-CBC
 * implementation. Run with: node test/protocol-test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const nodeCrypto = require("node:crypto");

// --- Stub the WebExtension environment ---

const storageData = {};
globalThis.browser = {
	storage: {
		local: {
			get: async (keys) => {
				const result = {};
				for (const key of keys) {
					if (key in storageData) {
						result[key] = storageData[key];
					}
				}
				return result;
			},
			set: async (items) => {
				Object.assign(storageData, items);
			},
			remove: async (keys) => {
				for (const key of keys) {
					delete storageData[key];
				}
			}
		}
	}
};

// --- Mock MiixKey (KeePassHTTP server) ---

const server = {
	key: null,
	id: "TestBrowser",
	tamperNextVerifier: false
};

function serverEncrypt(keyBuf, ivBuf, text) {
	const cipher = nodeCrypto.createCipheriv("aes-256-cbc", keyBuf, ivBuf);
	return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

function serverDecrypt(keyBuf, ivBuf, base64) {
	const decipher = nodeCrypto.createDecipheriv("aes-256-cbc", keyBuf, ivBuf);
	return Buffer.concat([decipher.update(Buffer.from(base64, "base64")), decipher.final()]).toString("utf8");
}

function verifierIsValid(request, keyBuf) {
	const iv = Buffer.from(request.Nonce, "base64");
	return serverDecrypt(keyBuf, iv, request.Verifier) === request.Nonce;
}

function respond(keyBuf, extraFields) {
	const iv = nodeCrypto.randomBytes(16);
	const nonce = iv.toString("base64");
	let verifier = serverEncrypt(keyBuf, iv, nonce);
	if (server.tamperNextVerifier) {
		verifier = serverEncrypt(keyBuf, iv, "not-the-nonce");
		server.tamperNextVerifier = false;
	}
	return {
		Success: true,
		Id: server.id,
		Nonce: nonce,
		Verifier: verifier,
		...(extraFields ? extraFields(iv) : {})
	};
}

function handleRequest(request) {
	switch (request.RequestType) {
		case "associate": {
			const keyBuf = Buffer.from(request.Key, "base64");
			assert.strictEqual(keyBuf.length, 32, "associate key must be 256 bits");
			assert.ok(verifierIsValid(request, keyBuf), "associate verifier must be valid");
			server.key = keyBuf;
			return respond(keyBuf);
		}
		case "test-associate":
			assert.strictEqual(request.Id, server.id);
			assert.ok(verifierIsValid(request, server.key), "test-associate verifier must be valid");
			if (server.tamperNextVerifier) {
				return respond(server.key);
			}
			// The real MiixKey firmware omits Nonce/Verifier on successful
			// test-associate replies; mimic that.
			return { Success: true, Id: server.id, Error: "" };
		case "get-logins": {
			assert.strictEqual(request.Id, server.id);
			assert.ok(verifierIsValid(request, server.key), "get-logins verifier must be valid");
			const requestIv = Buffer.from(request.Nonce, "base64");
			const url = serverDecrypt(server.key, requestIv, request.Url);
			assert.strictEqual(url, "https://example.com/login", "server must receive the page URL");
			return respond(server.key, (iv) => ({
				Count: 1,
				Entries: [{
					Name: serverEncrypt(server.key, iv, "Example"),
					Login: serverEncrypt(server.key, iv, "jaap"),
					Password: serverEncrypt(server.key, iv, "s3cret!"),
					Uuid: serverEncrypt(server.key, iv, "0123456789abcdef")
				}]
			}));
		}
		default:
			throw new Error(`Mock server got unknown RequestType: ${request.RequestType}`);
	}
}

globalThis.fetch = async (url, options) => {
	assert.strictEqual(url, "http://172.16.8.1:19455/", "client must POST to the configured endpoint");
	assert.strictEqual(options.method, "POST");
	const response = handleRequest(JSON.parse(options.body));
	return { ok: true, status: 200, json: async () => response };
};

// --- Load the real client and exercise it ---

const source = fs.readFileSync(path.join(__dirname, "..", "keepasshttp.js"), "utf8");
const KeePassHttp = new Function(`${source}; return KeePassHttp;`)();

(async () => {
	const id = await KeePassHttp.associate();
	assert.strictEqual(id, "TestBrowser");
	assert.ok(storageData.associationKey, "association key must be stored");
	assert.strictEqual(storageData.associationId, "TestBrowser");
	assert.strictEqual(
		Buffer.from(storageData.associationKey, "base64").toString("base64"),
		server.key.toString("base64"),
		"client and server must share the same key"
	);

	assert.strictEqual(await KeePassHttp.testAssociate(), true,
		"test-associate must succeed although the MiixKey omits the response verifier");

	server.tamperNextVerifier = true;
	await assert.rejects(
		KeePassHttp.testAssociate(),
		/verification/,
		"a test-associate response verifier must still be checked when present"
	);

	const entries = await KeePassHttp.getLogins("https://example.com/login");
	assert.strictEqual(entries.length, 1);
	assert.deepStrictEqual(entries[0], {
		name: "Example",
		login: "jaap",
		password: "s3cret!",
		uuid: "0123456789abcdef"
	});

	server.tamperNextVerifier = true;
	await assert.rejects(
		KeePassHttp.getLogins("https://example.com/login"),
		/verification/,
		"a tampered response verifier must be rejected"
	);

	await KeePassHttp.forgetAssociation();
	await assert.rejects(
		KeePassHttp.getLogins("https://example.com/login"),
		/Not connected/,
		"requests without an association must fail"
	);

	console.log("All protocol tests passed.");
})().catch((error) => {
	console.error("Test failed:", error);
	process.exit(1);
});
