"use strict";

const hostInput = document.getElementById("host");
const portInput = document.getElementById("port");
const associationInfo = document.getElementById("association-info");
const statusOutput = document.getElementById("status");

async function callBackground(message) {
	const response = await browser.runtime.sendMessage(message);
	if (!response.ok) {
		throw new Error(response.error);
	}
	return response.data;
}

function setStatus(text, isError) {
	statusOutput.textContent = text || "";
	statusOutput.classList.toggle("error", Boolean(isError));
}

async function refresh() {
	const status = await callBackground({ action: "get-status" });
	hostInput.value = status.host;
	portInput.value = status.port;
	associationInfo.textContent = status.associationId
		? `Connected as "${status.associationId}".`
		: "Not connected to a MiixKey yet.";
}

document.getElementById("settings-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	try {
		await callBackground({
			action: "save-settings",
			host: hostInput.value.trim(),
			port: Number(portInput.value)
		});
		setStatus("Settings saved.");
	} catch (error) {
		setStatus(error.message, true);
	}
});

document.getElementById("test").addEventListener("click", async () => {
	setStatus("Testing…");
	try {
		const associated = await callBackground({ action: "test-associate" });
		setStatus(associated
			? "Success: the MiixKey recognises this browser."
			: "The MiixKey is reachable but does not recognise this browser. Connect again.", !associated);
	} catch (error) {
		setStatus(error.message, true);
	}
});

document.getElementById("associate").addEventListener("click", async () => {
	setStatus("Waiting for confirmation on the MiixKey…");
	try {
		const id = await callBackground({ action: "associate" });
		setStatus(`Connected as "${id}".`);
		await refresh();
	} catch (error) {
		setStatus(error.message, true);
	}
});

document.getElementById("forget").addEventListener("click", async () => {
	try {
		await callBackground({ action: "forget-association" });
		setStatus("Association removed. You can also delete this browser entry on the MiixKey itself.");
		await refresh();
	} catch (error) {
		setStatus(error.message, true);
	}
});

refresh().catch((error) => setStatus(error.message, true));
