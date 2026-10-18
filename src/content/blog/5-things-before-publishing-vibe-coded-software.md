---
title: "5 things to know before publishing software built with vibe coding"
description: "AI agents like Claude and ChatGPT can get you to a working app in a weekend. Here are five checks to make before real users, real data, or real money touch it."
pubDate: 2026-10-18
heroImage: "/images/covers/5-things-before-publishing-vibe-coded-software.jpg"
category: ai
format: "Checklist"
seoTitle: "5 Things to Know Before Publishing a Vibe-Coded Product"
seoDescription: "Before you ship software built with Claude, ChatGPT, or another AI coding agent, check secrets, security, dependencies, tests, and operations."
featured: false
draft: false
---

Vibe coding, where you describe what you want and an AI agent writes, runs, and fixes the code, has changed who can build software. Claude, ChatGPT, and similar agents can take an idea to a working demo in hours.

A working demo is not a publishable product. The agent optimizes for "it runs and does what you asked". It does not own what happens when a stranger sends bad input, a key leaks, or a dependency breaks at 2 a.m. That ownership is yours. These five checks close most of the gap.

## 1. You are still the author of record

When the app mishandles someone's data, nobody will care that an agent wrote the code. You are the publisher, and you are accountable.

Practically, that means you should be able to explain, in plain language:

- what data the product collects and where it is stored
- who can log in and what each kind of user can see
- which third-party services it calls, and what it sends them

If you cannot answer these, ask the agent to explain the code back to you, then verify the answers by reading the relevant files yourself. Treat the agent like a fast junior developer: productive, confident, and occasionally wrong without knowing it.

Also check the rules that apply to you. If you collect personal data, privacy law (GDPR, CCPA, and others) applies whether or not the code was generated. A privacy policy and a way to delete user data are part of shipping.

## 2. Secrets: assume the agent got them wrong

Agents regularly take shortcuts that are fine in a demo and dangerous in production:

- API keys pasted directly into source files
- `.env` files committed to git
- database credentials reused across development and production
- keys placed in front-end code, where every visitor can read them

Before publishing:

1. Search the whole repository, including git history, for keys and tokens. A tool like `gitleaks` or `trufflehog` does this in minutes.
2. Move every secret into your host's secret store or environment variables, and confirm `.env` is in `.gitignore`.
3. **Rotate anything that was ever exposed.** Deleting a key from the latest commit does not make it safe if it was in history or in a chat transcript.
4. Give each key the minimum permissions it needs, and set spending limits on any paid API.

That last point matters more than it looks. A leaked LLM or cloud key with no cap is a bill waiting to happen.

## 3. Security holes hide in code that "works"

Generated code tends to handle the happy path well. Attackers use the other paths. The usual gaps:

- **Missing authorization.** The login works, but changing an ID in the URL shows another user's data. Test this directly with two accounts.
- **Unvalidated input.** Forms and API endpoints that trust whatever they receive invite injection and abuse. Validate on the server, never only in the browser.
- **Open endpoints.** Admin routes, debug routes, and test endpoints that the agent added along the way and forgot.
- **No rate limiting.** Login, signup, and any endpoint that costs you money (email, SMS, AI calls) need limits.
- **Permissive defaults.** Wide-open CORS, public storage buckets, and databases reachable from the whole internet.

A practical routine: ask a *fresh* agent session to review the code as a security auditor and list the highest-risk findings, then fix them and re-test yourself. Running the OWASP Top 10 as a checklist against your app is a good second pass. For anything handling payments, health, or children's data, pay for a human review.

## 4. Dependencies and tests: verify what the agent installed

Agents add packages freely. Some of what they add may be abandoned, vulnerable, or, occasionally, a package name the model invented that an attacker has since registered.

- Read your dependency list. Remove anything you do not recognize or need.
- Check that each package is real, maintained, and the one you intended.
- Run `npm audit`, `pip-audit`, or your ecosystem's equivalent, and pin versions with a lockfile.
- Turn on automated dependency alerts (Dependabot or similar).

Then tests. An agent will happily write tests that pass because they test nothing. Look at what the tests actually assert. At minimum, have a handful of end-to-end checks for the paths that matter most: sign up, log in, pay, and delete my data. Run them against a staging copy, not production, and re-run them after every agent-made change. Agents can break working code while fixing something else, and the only defense is a test that fails when they do.

## 5. Plan for day two: operations, cost, and rollback

Publishing is the start of the work, not the end. Before you go live, make sure you can:

- **See what is happening.** Logs and error alerts, so you hear about failures before your users tell you.
- **Undo a bad release.** Keep everything in version control, deploy from a known commit, and know the one command or click that rolls back.
- **Recover your data.** Automated backups, and one real test of restoring from them. An untested backup is a hope, not a backup.
- **Cap your costs.** Budgets and alerts on your cloud account, usage limits on AI APIs, and a plan for a traffic spike.
- **Maintain it.** Someone needs to read the code well enough to fix it. If the only path to a fix is "ask the agent and hope", you have a maintenance risk. Keep the repository tidy, add a short README describing how to run and deploy it, and ask the agent to document decisions as it works.

Start small. Release to a limited group first, with a clear way for them to report problems, and widen access as the monitoring proves quiet.

## The short version

Vibe coding makes building cheap. It does not make shipping cheap. Before you publish:

1. Know what your product does with data, and own it.
2. Keep secrets out of code, and rotate any that leaked.
3. Test for security failures, not just features.
4. Audit dependencies and make sure the tests mean something.
5. Be ready to monitor, roll back, restore, and pay the bill.

The agent can help with every one of these, from scanning for secrets to drafting a security review. Just remember that it is a collaborator, and the decision to publish is yours.
