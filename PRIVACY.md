# Privacy Policy: AntiGem Browser Bridge

_Effective date: November 10, 2026_

AntiGem Browser Bridge ("the extension") is a Chrome extension that lets the coding agents you run in **AntiGem for
VS Code** (Antigravity, Claude Code, Codex, OpenCode) use your browser at your request. This policy explains what
data the extension handles, where that data goes, and what control you have.

**In short:**
- The extension has no servers and makes no network requests of its own.
- It has no analytics and no tracking.
- It sends data only to the AntiGem app on your own computer.

## What the extension accesses

The extension acts only when the AntiGem app on your computer sends it a command, which happens when an agent uses
its browser tools. It acts only in tabs of the **"AntiGem" tab group**, or in tabs you approved. While it does, it
may access:

- **Tab information:** the address (URL) and title of those tabs.
- **Website content:** the text and structure of the page, form fields, and **screenshots** of the visible page.
- **Developer information for those tabs:** console messages and network request details (addresses, methods,
  status codes).
- **Files you or the agent choose to upload** to a page through the extension.

The extension does **not** access tabs outside the AntiGem group without your approval, sites on your blocklist,
browser pages (`chrome://…`), your browsing history, bookmarks, passwords or cookies.

## Where the data goes

- **Only to the AntiGem app on your own computer.** Data goes through Chrome native messaging and a private local
  connection that only your user account can open. The extension sends nothing to the developer or any other server,
  and it has no analytics, telemetry or advertising.
- **AntiGem passes it to the coding agent you chose.** That agent may send it to its AI provider as part of your
  conversation: Anthropic for Claude Code, OpenAI for Codex, Google for Antigravity, or the provider you configured
  in OpenCode. That provider's own privacy policy then applies. Use the agent only with pages you are comfortable
  sharing with it.

## What the extension stores

All of this stays on your computer:
- **Kept until you change it** (in Chrome's local extension storage): your site blocklist and whether the connection
  is paused.
- **Cleared when the browser closes** (session storage): which tabs belong to the AntiGem group, which tabs you
  shared or locked.
- **Kept only in memory:** console and network logs of the agent's tabs, up to 1,000 entries each per tab. They are
  gone when the tab closes or the browser restarts.

## Your control

- **Tab group:** agents can only use tabs in the "AntiGem" tab group. Drag a tab out of the group to take it back.
  Any other tab needs your explicit **Allow** first.
- **Blocklist:** the extension never opens, reads or controls sites on your blocklist. Banking, payment,
  password-manager and crypto sites and local files are blocked by default. You can edit the list in the
  extension's popup.
- **Stop at any time:** use **Release all tabs** or **Disconnect** in the popup, **Unlock** on a locked tab, or remove
  the extension in `chrome://extensions`.

## Data sharing and sale

The developer does not collect, sell, rent or share your data, and does not use it for advertising, creditworthiness
or any purpose other than the extension's single purpose described above.

The use of information received by this extension complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## Children

The extension is a developer tool and is not directed at children.

## Changes to this policy

If this policy changes, the new version will be published at this address with a new effective date.

## Contact

Questions or concerns: open an issue at
<https://github.com/Santoshkurmi/antigem-browser-extension/issues>.
