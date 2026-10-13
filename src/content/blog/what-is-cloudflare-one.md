---
title: What is Cloudflare One? A practical guide to the Zero Trust platform
description: >-
  Understand Cloudflare One's SASE approach, its core access and traffic
  controls, and a measured way to introduce it in an organization.
pubDate: 2026-10-12
category: cloudflare
format: How-to
heroImage: /images/covers/what-is-cloudflare-one/heroImage.png
seoTitle: What Is Cloudflare One? A Practical Guide
seoDescription: >-
  Learn what Cloudflare One brings together, how it relates to Zero Trust, and
  how to plan a small first rollout.
ogImage: /images/og/what-is-cloudflare-one/ogImage.png
featured: false
draft: false
---
Cloudflare One is Cloudflare's platform for connecting and securing users, devices, applications, and networks. Cloudflare describes it as an agile Secure Access Service Edge (SASE) platform. In practical terms, it brings together network connectivity and security services that can apply policies as traffic moves through Cloudflare's network.

Cloudflare One is not the same product as Cloudflare's website CDN, though the services use the same broader network. It is also not a single “Zero Trust” feature. It is a platform of components that an organization can use to build a Zero Trust design. For the underlying principles, see [Zero Trust explained](/blog/zero-trust-explained-cloudflare/).

## The core pieces

Names and packaging can evolve, but the key components include:

* **Cloudflare Access:** an identity-aware proxy for web applications. It checks requests against policies using identity-provider information, groups, device posture, and other selectors.
* **Cloudflare Gateway:** controls for DNS, web, and network traffic, such as filtering or applying organization policies to user traffic.
* **Cloudflare One Client:** the current name for the endpoint client formerly known as WARP. It can create encrypted connections from devices to Cloudflare, route internet or private traffic, and provide device posture information for policy decisions.
* **Cloudflare Tunnel and network connectivity options:** ways to connect private applications or networks to Cloudflare without exposing every service through a traditional public inbound path.

Together these can let an organization protect SaaS and self-hosted applications, inspect or filter traffic, and connect users to private resources. Which controls are available depends on the selected products, plan, and configuration. “Cloudflare One” does not mean every feature is automatically enabled or included.

## How a request can be evaluated

Consider an employee opening an internal application. The application can be registered with Access, and a policy can specify the required identity and group. If device posture matters, a device check can be added. The user's request is evaluated before the application is reached. For a private network resource that is not exposed as a public web hostname, the user's traffic must use a supported route through Gateway, such as the Cloudflare One Client.

That is different from simply joining a VPN and trusting everything reachable on the network. The policy can be specific to an application or destination, and security controls can be applied from the network. The precise flow depends on how the application is published and connected.

## How it relates to Zero Trust and SASE

**Zero Trust** is the security model: verify access based on identity and context, grant the minimum required, and avoid treating network location as proof of trust.

**SASE** (Secure Access Service Edge) is an architecture that brings networking and security services together, often delivered from the cloud. Cloudflare One is Cloudflare's SASE platform offering. Those labels describe different things: one is a security approach, and the other is a way to deliver connected network and security capabilities.

For a wider explanation of Cloudflare's network and website proxy, start with [what Cloudflare is](/blog/what-is-cloudflare-how-it-works/). For website caching specifically, see [the CDN guide](/blog/what-is-a-cdn-cloudflare/).

## A sensible first rollout

1. Pick one internal web application with a clear business owner and a small pilot group.
2. Connect the existing identity provider and define a group-based policy.
3. Test sign-in, session behavior, support access, and logging with real users.
4. Add device posture or Gateway traffic policies only where they solve a defined requirement.
5. For private resources, choose and validate the connection method before removing existing routes.
6. Expand in stages, review denied requests, and document break-glass access.

Avoid enabling every control at once. Each new rule can affect user workflows, service integrations, and incident response. A successful rollout is one where access gets narrower and easier to observe without introducing untested bypasses or blocking legitimate business activity.

## Questions to answer before buying or deploying

* Which applications and protocols are in scope?
* Do users need browser-only access, full private network connectivity, or both?
* Which identity provider and device-management tools are already in use?
* Which logs must be retained, and who will review them?
* What product features and limits are included in the chosen plan?
* How will administrators recover access during an identity or network outage?

Cloudflare One can provide useful building blocks, but the outcome still depends on architecture, policy quality, and operations. Start with a specific access problem, prove the design with a small group, and expand only after the controls and support process work as intended.

## Further reading

* [Cloudflare One overview](https://www.cloudflare.com/sase/)
* [Cloudflare One documentation](https://developers.cloudflare.com/cloudflare-one/)
* [Cloudflare Access: add web applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
* [Cloudflare One Client](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/)
