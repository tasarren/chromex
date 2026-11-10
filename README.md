<p align="center">
  <img src="docs/assets/chromex-logo.svg" width="96" height="96" alt="Chromex logo: a browser window with a bridge arc">
</p>

<h1 align="center">Chromex</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@tasarren/chromex"><img src="https://img.shields.io/npm/v/@tasarren/chromex" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@tasarren/chromex"><img src="https://img.shields.io/npm/dm/@tasarren/chromex" alt="npm downloads per month"></a>
  <a href="https://github.com/tasarren/chromex/actions/workflows/ci.yml"><img src="https://github.com/tasarren/chromex/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status on main"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@tasarren/chromex" alt="License: MIT"></a>
  <img src="https://img.shields.io/node/v/@tasarren/chromex" alt="Supported Node.js versions">
  <img src="https://img.shields.io/badge/platform-linux-informational" alt="Platform: Linux">
</p>

**Let your coding agent use a real browser.** Chromex (short for Chromium Executor) connects Claude Code,
Codex, OpenCode, Grok and Cursor to Chromium on your Linux machine.

## What your agent can do

- Open any page, including your local dev server, and read it: text, screenshots, console and network.
- Click, type, scroll and drag with a visible cursor, so you can watch what it is doing.
- Work in its own Chromium window with its own profile, without taking over your desktop or your tabs.
- Hand a live tab to another agent. The page stays exactly as it was.
- Work in your own browser too, but only on tabs you switch on yourself.

## Install

```bash
npx @tasarren/chromex setup
```

Setup asks whether to install for this project or for every project, finds your browsers and
agents, and registers Chromex with each one. Then it prints what it did, step by step. Start a new
agent session afterwards. To run from a checkout instead, see
[install from source](docs/installation.md#install).

You need Linux with a graphical session, Node.js 24.11 or newer, and Chromium. The full list, every
setup option, and what setup writes are in [Installation](docs/installation.md).

## Try it

Ask your agent:

> Open http://localhost:3000, click through the sign-up form, and tell me what breaks.

The first browser call starts Chromium for you. Ask it to take a screenshot, or to hand the tab to
another agent, whenever you like.

## Works with

| Agents | Browsers |
| --- | --- |
| Claude Code, Codex, OpenCode, Grok, Cursor | Chromium for the agent's own window (Managed). Chromium, Chrome, Chrome Beta and Dev, Brave, Edge and Vivaldi for your own browser (Observe). |

Linux only. Google Chrome cannot be the agent's own browser, because it blocks the extension Chromex
loads there; use Chromium for that and any browser above for Observe.

## Your own browser

Agents never see your tabs until you say so. Load the Chromex extension once: open
`chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick
`~/plugins/chromex/dist/extension` (setup prints this folder). Then open a tab, click the Chromex icon
and switch on **Allow agents on this tab**. Switch it off, or choose **Release all tabs**, to take
access back. There is no Chrome Web Store listing yet; one may come later. Details are in
[Installation](docs/installation.md#install-the-observe-extension).

## Privacy

Chromex runs on your machine and opens no network port, but what an agent reads from a page goes to
that agent's client, which may send it to its model provider. Agents can open any address with the
profile's logged-in sessions, so use a temporary profile for sites you do not trust. See
[Security](docs/security.md).

## Update and remove

- Update: [Installation, Update](docs/installation.md#update).
- Remove: there is no uninstall command yet; [Manual removal](docs/installation.md#manual-removal)
  lists each item and how to check it is yours before you delete it.

## Documentation

- [Documentation index](docs/index.md)
- [Installation](docs/installation.md): requirements, options, what setup writes, update, removal
- [Browser tools](docs/browser-tools.md): every tool an agent can call
- [Security](docs/security.md) and [Troubleshooting](docs/troubleshooting.md)
- [How it works](docs/tech/processes.md): diagrams of the processes, a tool call, setup and releases
- Skills for agents: [`skills/chromex`](skills/chromex), and [`skills/chromex-development`](skills/chromex-development) for work on this repository
- [Contributing](CONTRIBUTING.md) and [Changelog](CHANGELOG.md)

## License

MIT. See [`LICENSE`](LICENSE). Report vulnerabilities as described in [`SECURITY.md`](SECURITY.md).
