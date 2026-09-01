"use strict";

/*
 * Message hub. The popup, options page and content scripts all talk to the
 * MiixKey through here, so the association key never leaves the background
 * page. Every message is answered with { ok, data } or { ok, error }.
 */

async function handleMessage(message) {
	switch (message.action) {
		case "get-status": {
			const config = await KeePassHttp.getConfig();
			return {
				host: config.host,
				port: config.port,
				associationId: config.associationId
			};
		}
		case "save-settings":
			return browser.storage.local.set({
				host: message.host,
				port: message.port
			});
		case "associate":
			return KeePassHttp.associate();
		case "test-associate":
			return KeePassHttp.testAssociate();
		case "forget-association":
			return KeePassHttp.forgetAssociation();
		case "get-logins":
			return KeePassHttp.getLogins(message.url, message.submitUrl);
		default:
			throw new Error(`Unknown action: ${message.action}`);
	}
}

browser.runtime.onMessage.addListener((message) => {
	return handleMessage(message).then(
		(data) => ({ ok: true, data }),
		(error) => ({ ok: false, error: error.message })
	);
});

async function activeTab() {
	const tabs = await browser.tabs.query({ active: true, currentWindow: true });
	return tabs[0] || null;
}

function notifyTab(tab, text) {
	return browser.tabs.sendMessage(tab.id, { action: "show-toast", text }).catch(() => {});
}

// Used by the keyboard shortcut and the context menu: fetch logins for the
// current page and fill the first match; invoking it again cycles through
// the other matches (Bitwarden-style). The fetched entries are cached per
// tab for a short while so cycling does not trigger a new device
// confirmation on every press; the cache is dropped on navigation (URL
// mismatch), tab close, or expiry.
const CYCLE_TTL_MS = 60000;
const cycleCache = new Map(); // tabId -> { url, entries, index, lastUsed }

browser.tabs.onRemoved.addListener((tabId) => cycleCache.delete(tabId));

async function fillBestMatch(tab) {
	if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
		return;
	}
	try {
		let cached = cycleCache.get(tab.id);
		if (!cached || cached.url !== tab.url || Date.now() - cached.lastUsed > CYCLE_TTL_MS) {
			const entries = await KeePassHttp.getLogins(tab.url);
			if (entries.length === 0) {
				cycleCache.delete(tab.id);
				await notifyTab(tab, "MiixKey: no logins found for this site.");
				return;
			}
			cached = { url: tab.url, entries, index: 0 };
		} else {
			cached.index = (cached.index + 1) % cached.entries.length;
		}
		cached.lastUsed = Date.now();
		cycleCache.set(tab.id, cached);
		const entry = cached.entries[cached.index];
		await browser.tabs.sendMessage(tab.id, {
			action: "fill-credentials",
			login: entry.login,
			password: entry.password,
			// Auto-submit only when there is nothing to cycle through;
			// submitting the first of several matches would cut cycling short.
			submit: cached.entries.length === 1
		});
		if (cached.entries.length > 1) {
			await notifyTab(tab, `MiixKey: filled "${entry.login || entry.name}" `
				+ `(${cached.index + 1}/${cached.entries.length}) — press again for the next login, Enter to submit.`);
		}
	} catch (error) {
		await notifyTab(tab, `MiixKey: ${error.message}`);
	}
}

browser.commands.onCommand.addListener(async (command) => {
	if (command === "fill-credentials") {
		await fillBestMatch(await activeTab());
	}
});

browser.contextMenus.create({
	id: "miixkey-fill",
	title: "Fill login with MiixKey",
	contexts: ["page", "editable"]
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
	if (info.menuItemId === "miixkey-fill") {
		await fillBestMatch(tab);
	}
});
