"use strict";

/*
 * Runs in every page. Stays passive until the background page or popup asks
 * it to fill a login form; it never fetches credentials itself.
 */

(() => {
	if (window.miixKeyContentLoaded) {
		return;
	}
	window.miixKeyContentLoaded = true;

	function isFillable(input) {
		if (input.disabled || input.readOnly) {
			return false;
		}
		const rect = input.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	}

	// Heuristic: take the first visible password field, then the closest
	// visible text/email input that precedes it (searching its form first).
	function findLoginFields() {
		const passwordField = [...document.querySelectorAll("input[type=password]")].find(isFillable) || null;
		const scope = (passwordField && passwordField.form) || document;
		const candidates = [...scope.querySelectorAll("input[type=text], input[type=email], input:not([type])")].filter(isFillable);
		let usernameField = null;
		if (passwordField) {
			for (const candidate of candidates) {
				const position = passwordField.compareDocumentPosition(candidate);
				if (position & Node.DOCUMENT_POSITION_PRECEDING) {
					usernameField = candidate;
				}
			}
		} else {
			// Username-only step of a two-page login.
			usernameField = candidates[0] || null;
		}
		return { usernameField, passwordField };
	}

	function setValue(input, value) {
		input.focus();
		input.value = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
		input.blur();
	}

	function fillCredentials(login, password, submit) {
		const { usernameField, passwordField } = findLoginFields();
		let filled = false;
		if (usernameField && login) {
			setValue(usernameField, login);
			filled = true;
		}
		let submitted = false;
		if (passwordField && password) {
			setValue(passwordField, password);
			filled = true;
			if (submit) {
				submitted = scheduleSubmit(passwordField);
			}
		}
		if (!filled) {
			showToast("MiixKey: no login form found on this page.");
		}
		return { filled, submitted };
	}

	// Best-effort submit after a fill. Prefers clicking the form's own submit
	// button so the site's click handlers run, then requestSubmit() (fires the
	// submit event and constraint validation), then a bare submit(). Delayed a
	// moment so page scripts can process the fill's input events first; only
	// forms are submitted, never button-only (formless) logins.
	function scheduleSubmit(passwordField) {
		const form = passwordField.form;
		if (!form) {
			return false;
		}
		setTimeout(() => {
			// Tick a "remember me"-style checkbox first, so the login sticks.
			// click() (not .checked = true) so the site sees a change event,
			// and works even when the real input is hidden behind a styled
			// label, as custom checkboxes usually are.
			const remember = [...form.querySelectorAll("input[type=checkbox]")]
				.find((box) => /autologin|remember|cookie/i.test(`${box.name} ${box.id}`));
			if (remember && !remember.checked && !remember.disabled) {
				remember.click();
			}
			const button = [...form.querySelectorAll(
				"button[type=submit], input[type=submit], button:not([type])"
			)].find(isFillable);
			if (button) {
				button.click();
			} else if (typeof form.requestSubmit === "function") {
				form.requestSubmit();
			} else {
				form.submit();
			}
		}, 250);
		return true;
	}

	function showToast(text) {
		const existing = document.getElementById("miixkey-toast");
		if (existing) {
			existing.remove();
		}
		const toast = document.createElement("div");
		toast.id = "miixkey-toast";
		toast.textContent = text;
		toast.style.cssText = [
			"position: fixed",
			"top: 16px",
			"right: 16px",
			"z-index: 2147483647",
			"max-width: 320px",
			"padding: 10px 14px",
			"background: #1c2333",
			"color: #f0f3fa",
			"font: 13px/1.4 system-ui, sans-serif",
			"border-radius: 8px",
			"box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35)"
		].join(";");
		document.documentElement.appendChild(toast);
		setTimeout(() => toast.remove(), 4000);
	}

	browser.runtime.onMessage.addListener((message) => {
		if (message.action === "fill-credentials") {
			return Promise.resolve(fillCredentials(message.login, message.password, message.submit === true));
		}
		if (message.action === "show-toast") {
			showToast(message.text);
			return Promise.resolve({});
		}
		return undefined;
	});
})();
