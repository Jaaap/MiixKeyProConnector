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

	// querySelectorAll that also descends into shadow roots, so login forms
	// built from web components (reddit's faceplate-text-input and the like)
	// are found. openOrClosedShadowRoot is Firefox's content-script-only
	// accessor that pierces closed roots too. Matches come back in tree
	// order, with each host's shadow content right after the host itself.
	function queryDeep(root, selector, out = []) {
		for (const element of root.querySelectorAll("*")) {
			if (element.matches(selector)) {
				out.push(element);
			}
			const shadow = element.openOrClosedShadowRoot || element.shadowRoot;
			if (shadow) {
				queryDeep(shadow, selector, out);
			}
		}
		return out;
	}

	// input.form is null when the input sits in a shadow root below the
	// form, so walk up, hopping shadow boundaries via the host element.
	function containingForm(input) {
		let node = input;
		while (node) {
			const form = node.closest("form");
			if (form) {
				return form;
			}
			const root = node.getRootNode();
			node = root instanceof ShadowRoot ? root.host : null;
		}
		return null;
	}

	// contains() for the composed tree: true when node is a descendant of
	// ancestor through any number of shadow roots.
	function composedContains(ancestor, node) {
		let current = node;
		while (current) {
			if (ancestor.contains(current)) {
				return true;
			}
			const root = current.getRootNode();
			current = root instanceof ShadowRoot ? root.host : null;
		}
		return false;
	}

	// Heuristic: take the first visible password field, then the closest
	// visible text/email input that precedes it (scoped to its form when
	// there is one). Ordering comes from queryDeep's traversal order, since
	// compareDocumentPosition reports "disconnected" across shadow trees.
	function findLoginFields() {
		const isUsernameType = (input) => input.type === "text" || input.type === "email";
		const inputs = queryDeep(document, "input[type=password], input[type=text], input[type=email], input:not([type])")
			.filter(isFillable);
		const passwordField = inputs.find((input) => input.type === "password") || null;
		let usernameField = null;
		if (passwordField) {
			const scope = containingForm(passwordField);
			for (const input of inputs) {
				if (input === passwordField) {
					break;
				}
				if (isUsernameType(input) && (!scope || composedContains(scope, input))) {
					usernameField = input;
				}
			}
		} else {
			// Username-only step of a two-page login.
			usernameField = inputs.find(isUsernameType) || null;
		}
		return { usernameField, passwordField };
	}

	function setValue(input, value) {
		input.focus();
		input.value = value;
		// composed: true so the events escape shadow roots; real keyboard
		// input is composed too, and pages listen above the shadow boundary.
		input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
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
		const form = containingForm(passwordField);
		if (!form) {
			return false;
		}
		setTimeout(() => {
			// Tick a "remember me"-style checkbox first, so the login sticks.
			// click() (not .checked = true) so the site sees a change event,
			// and works even when the real input is hidden behind a styled
			// label, as custom checkboxes usually are.
			const remember = queryDeep(form, "input[type=checkbox]")
				.find((box) => /autologin|remember|cookie/i.test(`${box.name} ${box.id}`));
			if (remember && !remember.checked && !remember.disabled) {
				remember.click();
			}
			const button = queryDeep(
				form,
				"button[type=submit], input[type=submit], button:not([type])"
			).find(isFillable);
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
