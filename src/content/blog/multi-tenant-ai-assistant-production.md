---
title: "Building a multi-tenant AI assistant on Azure: what broke in production"
description: "Tenant isolation, token budgets, and retrieval quality looked solved in the pilot. Here is what failed once real tenants arrived, and what we changed."
pubDate: 2026-10-19
category: field
format: "War story"
seoTitle: ""
seoDescription: ""
featured: false
draft: true
---

## The architecture we shipped

TODO

## Failure 1: one tenant’s traffic starving the rest

TODO

## Failure 2: retrieval leaking across tenant boundaries in testing

TODO

## Failure 3: cost per tenant we couldn’t explain

TODO

## What the architecture looks like now

TODO
