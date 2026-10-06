# Contributing

Thanks for helping. Bug fixes and server improvements are welcome.

## Before you start

For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Setup

You need Node 24 or newer.

```sh
git clone https://github.com/jpo-oss/claude-games-server
cd claude-games-server
npm ci
npm test
```

[AGENTS.md](AGENTS.md) covers commands and the rules the code follows.

## Pull requests

- One change per PR. Keep it small enough to review in one sitting.
- Add or update tests. CI runs the type check and the tests, and must pass.
- Use Conventional Commit style for the PR title, e.g. `fix: reject oversized request bodies`.
- Never add details about any particular deployment, including the maintainers' own. That means hostnames, providers, regions and deploy targets. This repo stays generic so anyone can self-host it.

## AI-assisted contributions

Using AI tools is fine. We use them too. The rules:

- Say so in the PR description.
- You are the author. You need to understand every line and be able to answer questions about it.
- Run it yourself before opening the PR.
- Large PRs that look unreviewed get closed without detailed feedback.
- Security reports need a working reproduction.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
