# MiixKey Pro Connector

A small Firefox WebExtension that connects the browser to a
[MiixKey Pro](https://htu.miixpro.com/guide/miixkey-quick-start) hardware
password manager using the legacy **KeePassHTTP** protocol (the protocol of
the original [KeePassHttp](https://github.com/pfn/keepasshttp) plugin, as also
used by [KeePassHttp-Connector](https://github.com/smorks/keepasshttp-connector)).

## Features

- One-time **association** with the MiixKey (confirm on the device screen).
- **Find logins**: opening the popup automatically searches the MiixKey for
  logins matching the current page; click an entry to fill it into the login
  form. (Unless **Trust Browser** is enabled on the device, this means a
  confirmation prompt on the device every time the popup opens.)
- **Fill best match** via keyboard shortcut (`Ctrl+Shift+L`, `Cmd+Shift+L` on
  macOS — same as Bitwarden; press it again to cycle through multiple
  matching logins) or the right-click menu ("Fill login with MiixKey").
- **Auto-submit**: after filling, the login form is submitted automatically —
  when you pick an entry in the popup, or when the shortcut finds exactly one
  match. While cycling through multiple matches the form is left unsubmitted
  (press Enter to log in with the currently filled entry). Before submitting,
  a "remember me"-style checkbox on the form (name or id matching
  `autologin|remember|cookie`) is ticked if present.
- Configurable device address (defaults to the MiixKey USB network address
  `172.16.8.1`, port `19455`).

All credential fields on the wire are AES-256-CBC encrypted with a key that is
generated during association, exactly as the KeePassHTTP protocol specifies.
Credentials are only requested on an explicit user action, so the MiixKey's
per-request confirmation prompt is not triggered by ordinary browsing.

## Installation (temporary add-on)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this
   directory.

For a permanent install the extension must be signed (e.g. as an unlisted
add-on via addons.mozilla.org) or loaded in Firefox Developer Edition with
`xpinstall.signatures.required` set to `false`.

## Connecting to the MiixKey

1. Prepare the device as described in the
   [quick-start guide](https://htu.miixpro.com/guide/miixkey-quick-start):
   load your `.kdbx` file, reload the database, and connect the device via
   USB (unlocked, USB mode disabled so it acts as a network device).
2. If your MiixKey does not use the default `172.16.8.1:19455`, set the
   address in the extension's preferences.
3. Click the MiixKey toolbar icon and press **Connect to MiixKey**.
4. Confirm the connection request on the device screen.

The MiixKey stores the association (up to 5 browsers); it reconnects
automatically from then on. Enable **Trust Browser** in the MiixKey settings
if you don't want to confirm every credential request on the device.

## Troubleshooting

**"Could not reach MiixKey … (NetworkError when attempting to fetch
resource.)"** means Firefox never got a connection to the device. First check
whether your computer can reach it at all:

```
curl -s -X POST -H "Content-Type: application/json" \
	-d '{"RequestType":"test-associate","TriggerUnlock":false,"Nonce":"","Verifier":""}' \
	http://172.16.8.1:19455/
```

Any JSON reply — even with `"Success":false` — means the device is fine and
Firefox itself is being blocked. Check, in order:

1. **macOS Local Network permission** (macOS 15 Sequoia and later): System
   Settings → Privacy & Security → **Local Network** → enable **Firefox**.
   When this is off, macOS silently blocks all connections to the MiixKey's
   address and Firefox only reports the generic NetworkError.
2. **HTTPS-Only Mode**: Firefox Settings → Privacy & Security → HTTPS-Only
   Mode. If enabled, Firefox upgrades the extension's `http://` request to
   `https://`, which the MiixKey does not serve. Add an exception for
   `http://172.16.8.1` (Manage Exceptions…) or turn the mode off.
3. **Proxy**: Firefox Settings → General → Network Settings. A system or
   corporate proxy cannot reach a USB device; add `172.16.8.1` to
   "No proxy for".

If the curl probe also fails to connect, the problem is on the device side:

- The MiixKey must be **unlocked** (it does not bring up the USB connection
  while locked).
- **USB mode** (mass storage) must be **disabled** again after copying your
  kdbx file — the network interface only appears outside USB mode.
- The database must be loaded: run **Reload Database** in the device settings
  after changing the kdbx or `MiixkeyConfig.txt`.
- Verify the USB network interface exists: `ifconfig` should show an
  interface with IP `172.16.8.2` (the device is `172.16.8.1`).

## Layout

```
manifest.json               MV2 manifest (Firefox)
keepasshttp.js              KeePassHTTP protocol client (WebCrypto AES-256-CBC)
background.js               Message hub, keyboard shortcut, context menu
content.js                  Login form detection and filling
popup.html / popup.js       Toolbar popup: status, connect, entry picker
options.html / options.js   Preferences: device address, association management
icons/                      Extension icon
test/protocol-test.js       Protocol round-trip test against a mock device (Node)
```

## Testing

`node test/protocol-test.js` runs the real protocol client against an
in-process mock KeePassHTTP server and checks association, verifier handling
and entry decryption. No dependencies are required.

## Not implemented

- `set-login` (saving new credentials back to the device).
- `generate-password` — the MiixKey firmware (1.8.4.2) does not support the
  request; it answers with `Success: false`.
- Filling login forms inside iframes.
