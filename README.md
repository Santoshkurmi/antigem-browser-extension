# AntiGem Browser Bridge (Chrome extension)

Lets the coding agents you use in **AntiGem for VS Code** (Antigravity, Claude Code, Codex, OpenCode) work in your
real browser: open pages, read them, click and type, fill forms, take screenshots, run JavaScript, read console and
network logs, handle dialogs and upload files.

It is the browser half of AntiGem's built-in **Browser** MCP server. It also powers AntiGem plugins that use the
browser (for example Google Flow).

It works only together with the AntiGem VS Code extension. On its own it does nothing.

- Extension ID: `kbdjcdlfeoijcchepbldpldeaeijgibi`
- Works in: Chrome, Chromium, Brave and Edge (version 120 or newer), on Linux and macOS. Windows is not supported yet.

---

## Install

You need AntiGem for VS Code installed first. The VS Code extension carries these files and sets up the connection.

1. **Copy the extension.** In VS Code, open AntiGem → **Settings → Browser** → **Open the extension folder**. This
   copies the extension to `~/.antigem/chrome-extension` and opens that folder. The folder stays put when AntiGem
   updates, so Chrome keeps finding it.
2. **Load it in Chrome.**
   1. Open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`).
   2. Turn on **Developer mode** (top-right switch).
   3. Click **Load unpacked** and pick `~/.antigem/chrome-extension`. To reach a hidden folder in the file dialog,
      press `Ctrl+H`, or `Cmd+Shift+.` on macOS.
   4. Check that the card says **ID `kbdjcdlfeoijcchepbldpldeaeijgibi`**.
3. **Connect it to VS Code.** Back in AntiGem's **Settings → Browser**, press **Register with Chrome**. This writes
   the native messaging host for every Chromium-based browser it finds. Restart the browser if it was already open.
4. **Check the connection.** Click the AntiGem icon in Chrome's toolbar (pin it from the puzzle-piece menu). The popup
   should say it is **connected**. *Settings → Browser* in VS Code shows the same, and has a test button.
5. **Give your agents the tools.** On each agent's MCP page in AntiGem (*Settings → <agent> → MCP servers*), tap the
   **Browser** tile.

Now ask an agent something like *"open example.com and tell me what the page says"*.

### Updating

When a new AntiGem version brings a new browser extension:
1. Press **Open the extension folder** again.
2. Click **Reload** (↻) on the extension's card in `chrome://extensions`.
3. If *Settings → Browser* warns that the native host points to an old path, press **Register with Chrome** again.

### Uninstalling

1. Click **Remove** on the extension's card in `chrome://extensions`.
2. Optionally delete `~/.antigem/chrome-extension`.
3. To remove the native host too, delete `com.antigem.browser_bridge.json` from your browser's
   `NativeMessagingHosts` folder (for example `~/.config/google-chrome/NativeMessagingHosts/` on Linux), and
   `~/.antigem/chrome/antigem-native-host`.

---

## What agents can and cannot do

- **Only the "AntiGem" tab group.** Tabs an agent opens go into a tab group named *AntiGem*.
  - Agents only see and use tabs in that group, plus popups those tabs open.
  - Drag one of your tabs into the group to share it; drag it out to take it back.
- **Other tabs need your OK.** If an agent wants any other tab, a small window asks you to **Allow** or **Deny**.
  Closing it, or waiting 2 minutes, counts as Deny.
- **Blocklist.** Agents can never open, read or control blocked sites.
  - The defaults cover banking, payments, password managers, crypto and local files (`file://`).
  - Edit the list in the popup. A domain covers its subdomains.
  - On a blocked page the extension detaches and records nothing.
- **Browser pages** (`chrome://…`, the Web Store) are always off limits.
- **Locking.** While an agent works in a tab it can lock it. An overlay with the agent's cursor blocks your mouse and
  keyboard there so stray clicks don't interfere. Click **Unlock** to take the tab back at any time.
- **Debugger banner.** While an agent uses a tab, Chrome shows *"AntiGem started debugging this browser"*. That
  banner is Chrome's own and can't be hidden.
- **Private files.** File uploads never take files from `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.antigem_bridge` and
  similar folders.
- **Stopping everything.** The popup has **Release all tabs** and **Disconnect**.

## How it connects, and why it is safe

```
Chrome extension ⇄ Chrome native messaging ⇄ antigem-bridge --native-host ⇄ Unix socket (0600) ⇄ AntiGem in VS Code
```

- **No network port.** The extension talks to VS Code through **Chrome native messaging** and a per-user Unix socket
  at `$XDG_RUNTIME_DIR/antigem/browser.sock`, or `~/.antigem/run/browser.sock`. The folder is `0700` and the socket
  `0600`. Web pages and other programs on your computer cannot reach it, unlike a localhost WebSocket.
- **Only this extension can start the native host.** Chrome reads the host manifest, whose `allowed_origins` lists
  only this extension's ID. The ID is fixed by the public `key` in `manifest.json`. AntiGem also refuses a host
  started for another origin, and an extension that reports a different ID.
- **No web access to the extension.** It has no `externally_connectable`, so web pages and other extensions cannot
  message it.
- **Limited DevTools use.** The extension acts only on commands from AntiGem. Raw DevTools access from AntiGem is
  limited to input events.
- **Data stays local.** Nothing is sent anywhere except to AntiGem in VS Code on the same computer. See the
  [privacy policy](PRIVACY.md).

### Permissions it asks for

| Permission | Why |
|---|---|
| `nativeMessaging` | Talk to AntiGem in VS Code |
| `tabs`, `tabGroups` | Open, list, switch and close tabs; keep the agent's tabs in the *AntiGem* group |
| `scripting` | Read pages and find elements (`page-agent.js`), show the lock overlay |
| `debugger` | Real clicks and typing, screenshots, JavaScript, console and network logs, dialogs, file uploads |
| `storage` | Remember the blocklist and the tabs you shared |
| `alarms` | Keep the connection alive and reconnect |
| `<all_urls>` | Work on whatever site you ask the agent to use (blocklisted sites excepted) |

## Files

| File | What it does |
|---|---|
| `manifest.json` | Manifest V3; the `key` pins the extension ID |
| `background.js` | Service worker: wires the parts below together |
| `bg/native.js` | Native messaging connection, reconnects, large-message chunks |
| `bg/policy.js` | Tab group, blocklist, the Allow / Deny window |
| `bg/cdp.js` | DevTools protocol: input, screenshots, console / network logs, dialogs, view mode, file chooser |
| `bg/page.js` | Injects the page helper and the overlay |
| `bg/commands.js` | The commands AntiGem can send, including screenshot resizing |
| `bg/util.js` | Helpers |
| `page-agent.js` | Page helper from the AntiGem Android app (element tree, find, form input, page text) |
| `overlay.js` | Lock overlay, agent cursor, Unlock button |
| `popup.html` / `popup.js` | Toolbar popup: connection, tab group, blocklist |
| `confirm.html` / `confirm.js` | The Allow / Deny window for tabs outside the group |
| `ui.css`, `icons/` | Styles and icon |

There is no build step: the folder is the extension.

## Development

- **Code that talks to this extension:** `src/core/browser/` (socket server, native-host registration, the
  `/browser` MCP tools) and `bridge/pkg/nativehost/` (the native host), both in the
  [VS Code extension's repository](https://github.com/Santoshkurmi/antigem_vscode_extension).
- **Where it lives:** this repository (<https://github.com/Santoshkurmi/antigem-browser-extension>) is checked out
  next to the VS Code extension's, as `antiGem/antigem-chrome-extension`.
  The VS Code extension's build (`npm run build:host`) copies it into its `dist/chrome-extension`, which its VSIX
  ships. Its dev server and browser tests read this folder directly.
- **After editing files here:**
  - For quick testing, load this folder itself with *Load unpacked*, then click **Reload** on the extension's card in
    `chrome://extensions` after each change. It has the same ID.
  - To test the copy that ships, rebuild the VS Code extension, press **Open the extension folder** again, then click
    **Reload**.
- **Packing a `.crx` with the same ID** (the private key is not in this repository):

  ```sh
  google-chrome --pack-extension="$PWD" --pack-extension-key="$HOME/.antigem/chrome-extension.pem"
  ```

- **Chrome Web Store:** upload a ZIP of this folder. If the store assigns its own ID, remove `key` from
  `manifest.json`, then put the new ID in the VS Code extension's `src/core/browser/constants.ts`.

## License

GPL-3.0, like AntiGem for VS Code.
