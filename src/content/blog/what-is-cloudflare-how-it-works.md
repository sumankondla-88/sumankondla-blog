---
title: "What is Cloudflare, and how does it work?"
description: "A practical introduction to Cloudflare: DNS, the reverse proxy, its global network, and what happens when a visitor opens your website."
pubDate: 2026-10-07
category: cloudflare
format: "How-to"
heroImage: /images/covers/what-is-cloudflare-how-it-works/heroImage.png
seoTitle: "What Is Cloudflare? How It Works, Explained"
seoDescription: "Learn how Cloudflare connects DNS, reverse proxying, caching, and security when someone visits a website."
featured: false
draft: false
---

Cloudflare is a network and a set of services that sit between people using the internet and the websites, applications, or private resources they need. For a website, Cloudflare can answer DNS queries, proxy web requests, cache eligible content, and apply security rules before requests reach the server that hosts the site.

That description can sound like Cloudflare is simply a hosting company. It is not necessarily your application host: your site may still run on a cloud platform, a VPS, or your own servers. Cloudflare is often the layer in front of that origin.

## What happens when someone opens a website?

Imagine a visitor opens `www.example.com`. In a typical full DNS setup, the request takes this path:

1. The visitor's device looks up the domain through DNS.
2. Cloudflare's authoritative DNS answers with a Cloudflare address for a DNS record configured as **Proxied** (the orange-cloud setting), rather than disclosing the origin address in that DNS answer.
3. The browser connects to Cloudflare's network. Cloudflare can apply the configured TLS, security, and traffic rules.
4. If the requested content is cached and still valid, Cloudflare can return it from its network. Otherwise, Cloudflare forwards the request to the origin server.
5. The origin's response travels back through Cloudflare to the browser. Depending on the cache rules and response, Cloudflare may keep a copy for a later request.

Cloudflare uses anycast addresses: the same advertised address can be reached through different network locations. Internet routing directs a connection to a nearby Cloudflare data center, though “nearby” does not guarantee the shortest possible path or a cache hit.

## DNS is not the same thing as proxying

DNS translates names into information that helps clients find services. In a standard Cloudflare setup, Cloudflare hosts the domain's authoritative DNS records. That alone does not mean all traffic passes through Cloudflare.

For web records, the proxy setting determines whether HTTP and HTTPS traffic routes through Cloudflare. A **Proxied** record sends supported web traffic through Cloudflare. A **DNS-only** record returns the configured destination, so Cloudflare is not in the HTTP request path and cannot apply its web proxy protections or caching to that traffic. Mail and text records, for example, are not web proxy records.

This distinction is important when you are troubleshooting, publishing a service, or trying to protect an origin. A DNS change is not a substitute for checking which hostnames are proxied and whether the origin can still be reached directly.

## What Cloudflare can do in that path

The proxy gives Cloudflare a place to apply several services to supported traffic:

- **Content delivery:** cache eligible responses closer to visitors and reduce repeated work at the origin. See [how a CDN works](/blog/what-is-a-cdn-cloudflare/).
- **Security:** mitigate many DDoS attacks, evaluate web requests against WAF rules, and apply rate limits. These controls depend on traffic type, configuration, and plan.
- **TLS:** encrypt connections between the visitor and Cloudflare, and—when configured correctly—between Cloudflare and the origin.
- **Traffic management:** use rules to change how matching requests are handled, or direct requests among origins with products such as load balancing.
- **Application development:** use services such as Workers to run code at Cloudflare's network edge.

Not every product applies to every protocol or DNS record. For example, a proxied website hostname and a DNS-only mail hostname do not get the same HTTP proxy behavior.

## What Cloudflare does not automatically do

Putting a domain on Cloudflare does not automatically make an application secure, fast, or available. You still need to configure DNS correctly, use an appropriate TLS mode, select cache behavior that fits the content, and protect the origin so attackers cannot simply bypass the proxy.

It also does not replace application security. Authentication, authorization, secure coding, patching, backups, monitoring, and incident response remain your responsibility. Cloudflare can add useful controls in front of an application, but it cannot fix a vulnerable application or a leaked credential by itself.

## A simple way to think about it

Treat Cloudflare as a configurable network layer in front of services—not as a magic switch. DNS determines where clients are directed; proxy status determines whether supported traffic passes through Cloudflare; and product rules determine what Cloudflare does with that traffic.

That model makes it easier to understand the rest of this series: [what a CDN is](/blog/what-is-a-cdn-cloudflare/), [how Cloudflare can help secure a website](/blog/is-cloudflare-secure/), and how Cloudflare One applies Zero Trust ideas to workforce access.

## Further reading

- [How Cloudflare DNS works](https://developers.cloudflare.com/fundamentals/concepts/how-cloudflare-works/)
- [Cloudflare proxy status](https://developers.cloudflare.com/dns/proxy-status/)
- [Cloudflare Cache](https://developers.cloudflare.com/cache/)
