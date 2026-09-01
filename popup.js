"use strict";

const ui = {};
for (const id of ["status-dot", "status-text", "connect", "find-logins", "entries", "message", "open-options"]) {
	ui[id] = document.getElementById(id);
}

async function callBackground(message) {
	const response = await browser.runtime.sendMessage(message);
	if (!response.ok) {
		throw new Error(response.error);
	}
	return response.data;
}

function setMessage(text, isError) {
	ui.message.textContent = text || "";
	ui.message.classList.toggle("error", Boolean(isError));
}

async function activeTab() {
	const tabs = await browser.tabs.query({ active: true, currentWindow: true });
	return tabs[0] || null;
}

async function refreshStatus() {
	const status = await callBackground({ action: "get-status" });
	const connected = Boolean(status.associationId);
	ui["status-dot"].classList.toggle("connected", connected);
	ui["status-text"].textContent = connected
		? `Connected as "${status.associationId}"`
		: "Not connected";
	ui.connect.hidden = connected;
	ui["find-logins"].hidden = !connected;
	return connected;
}

ui["open-options"].addEventListener("click", () => {
	browser.runtime.openOptionsPage();
	window.close();
});

ui.connect.addEventListener("click", async () => {
	ui.connect.disabled = true;
	setMessage("Waiting for confirmation on the MiixKey…");
	try {
		const id = await callBackground({ action: "associate" });
		setMessage(`Connected as "${id}".`);
		await refreshStatus();
	} catch (error) {
		setMessage(error.message, true);
	} finally {
		ui.connect.disabled = false;
	}
});

// Search the MiixKey for logins matching the active tab and list them.
// Runs automatically when the popup opens (auto = true: non-fillable pages
// are skipped silently instead of showing an error) and on the button.
async function findLogins(auto) {
	const tab = await activeTab();
	if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
		if (!auto) {
			setMessage("This page cannot be filled.", true);
		}
		return;
	}
	ui["find-logins"].disabled = true;
	ui.entries.textContent = "";
	setMessage("Asking MiixKey… approve the request on the device if prompted.");
	try {
		const entries = await callBackground({ action: "get-logins", url: tab.url });
		setMessage(entries.length === 0 ? "No logins found for this site." : "");
		for (const entry of entries) {
			const button = document.createElement("button");
			button.className = "action";
			button.append(entry.name || entry.login || "(unnamed entry)");
			const login = document.createElement("span");
			login.className = "entry-login";
			login.textContent = entry.login;
			button.append(login);
			button.addEventListener("click", async () => {
				try {
					await browser.tabs.sendMessage(tab.id, {
						action: "fill-credentials",
						login: entry.login,
						password: entry.password,
						submit: true
					});
					window.close();
				} catch (error) {
					setMessage(`Could not fill the page: ${error.message}`, true);
				}
			});
			ui.entries.append(button);
		}
	} catch (error) {
		setMessage(error.message, true);
	} finally {
		ui["find-logins"].disabled = false;
	}
}

ui["find-logins"].addEventListener("click", () => findLogins(false));

refreshStatus()
	.then((connected) => (connected ? findLogins(true) : undefined))
	.catch((error) => setMessage(error.message, true));
