---
title: "WordPress Multisite vs single site: when to choose each"
description: "What Multisite actually shares, where it saves real work, where it creates risk, and a checklist for deciding before you build, since undoing the choice later is expensive."
pubDate: 2026-12-08
category: wordpress
format: "Opinion"
heroImage: /images/covers/wordpress-multisite-vs-single-site/heroImage.jpg
seoTitle: "WordPress Multisite vs Single Site Checklist"
seoDescription: "What WordPress Multisite shares, where it saves work and where it adds risk, plus a checklist for choosing Multisite or separate sites."
ogImage: /images/og/wordpress-multisite-vs-single-site/ogImage.png
featured: false
draft: false
---
WordPress Multisite lets one WordPress installation run many sites. It is built into core, it is free, and turning it on takes a few lines of configuration. That makes it tempting every time a second site comes up. The decision deserves more care than that, because Multisite changes how updates, plugins, users, security, and hosting work for every site on the network, and moving a site out of a network later is a manual migration.

The short version: choose Multisite when the sites have one owner, one team running them, and mostly the same plugins and theme. Choose separate single sites when they have different owners, different requirements, or need to fail, scale, and change independently.

## What Multisite shares and what it doesn’t

A network is one codebase and one database. Every site runs the same WordPress core version and the same PHP version, and draws from one shared pool of installed plugins and themes. Each site gets its own content tables in the database (`wp_2_posts`, `wp_2_options`, and so on), while users live in shared tables (`wp_users`, `wp_usermeta`) for the whole network.

- Shared: WordPress core, PHP runtime, installed plugins and themes, the user table, `wp-config.php`, and the server it all runs on.
- Per site: posts, pages, media, menus, widgets, settings, the active theme, and which plugins are switched on.
- Network-wide: the Super Admin role, which is the only role that can install plugins and themes or create sites.

Sites can use subdomains (`team.example.com`) or subdirectories (`example.com/team`), and each site can also be mapped to its own domain, which core has supported natively since WordPress 4.5. You choose subdomains or subdirectories when you set up the network, and changing it later is painful.

## Advantages of Multisite

1. One update covers every site. Core, plugin, and theme updates are applied once for the whole network instead of once per site.
2. Central control. Super Admins decide which plugins and themes exist, so site admins can’t add unreviewed code.
3. Fast provisioning. A new site takes a minute and arrives with the approved theme and plugins already in place.
4. Shared users. One account can be given roles on several sites without separate logins.
5. Lower overhead per site. One server, one database server, one backup job, and one set of monitoring for many sites.

## Disadvantages and risks

1. Shared blast radius. A broken plugin update, a PHP fatal error, or a compromised plugin can take down or expose every site at once.
2. Everyone moves together. You can’t keep one site on an older plugin version or PHP version while the others upgrade.
3. Noisy neighbours. One busy site shares CPU, memory, and database capacity with the rest, and you can’t scale it on its own.
4. Plugin compatibility. Most popular plugins support Multisite, but not all of them, and some behave differently when network-activated. Test each one.
5. Restricted site admins. On a network, only Super Admins get the `unfiltered_html` capability, so site admins can’t paste arbitrary scripts or iframes into content. That is often a security feature, but it surprises teams migrating from single sites.
6. Hard to leave. There is no built-in “extract this site” button. Splitting a site out means exporting content and media, moving users, and rewriting URLs and table prefixes.
7. Backup and restore granularity. Restoring one site without rolling back the others needs tooling that understands the per-site tables.

## When Multisite is the right choice

- A university or large organization with many department sites run by one central web team.
- Franchise, branch, or location sites that share a design and differ mainly in content.
- Regional or campaign microsites that are created and retired often.
- An internal platform where teams request a site and the platform team owns the code.
- A product that gives each customer a simple site from a fixed set of features, where the operator controls every plugin.

The common thread is one owner of the code and many owners of content.

## When separate single sites are better

- The sites belong to different clients or business units that each expect their own budget, release schedule, and access.
- One site is business critical, such as a WooCommerce store or a high-traffic publication, and should not share failures or capacity with anything else.
- Sites need different plugins, different PHP versions, or custom code that the others shouldn’t carry.
- Compliance or contracts require data and access to be separated per site.
- There are only two or three sites. The savings from Multisite rarely outweigh its constraints at that size.
- You need multiple languages of one site. A multilingual plugin on a single site is usually simpler than a site per language, unless each language is run by a separate team.

Separate sites don’t have to mean manual work. WP-CLI scripts, a shared deployment pipeline, and a management dashboard can update many independent sites from one place, which recovers much of the convenience of Multisite without the shared failure.

## Setting up a network

Back up the site and database first. Add one line to `wp-config.php` above the “That’s all, stop editing” comment, deactivate all plugins, then open Tools, then Network Setup in the dashboard.

```php title="wp-config.php (step 1)"
define( 'WP_ALLOW_MULTISITE', true );
```

Network Setup then generates the constants for `wp-config.php` and the rewrite rules for `.htaccess` (or your Nginx config). For a subdomain network they look like this:

```php title="wp-config.php (step 2)"
define( 'MULTISITE', true );
define( 'SUBDOMAIN_INSTALL', true );
define( 'DOMAIN_CURRENT_SITE', 'example.com' );
define( 'PATH_CURRENT_SITE', '/' );
define( 'SITE_ID_CURRENT_SITE', 1 );
define( 'BLOG_ID_CURRENT_SITE', 1 );
```

> **Note:** Subdomain networks need a wildcard DNS record (`*.example.com`) and a certificate that covers every subdomain. Subdirectory networks avoid both but can conflict with existing permalinks, which is why WordPress may not offer subdirectories on a site that already has published content.

## Day-to-day operations with WP-CLI

WP-CLI works on networks with a `--url` flag to target one site, and `--network` for network-wide actions.

```bash title="network.sh"
# Convert an existing single site into a subdomain network
wp core multisite-convert --subdomains

# Create a site
wp site create --slug=admissions --title="Admissions" --email=web@example.edu

# Network-activate a plugin for every site
wp plugin activate redis-cache --network

# Run a command against one site
wp --url=admissions.example.edu option get blogname

# Run a command against every site
for url in $(wp site list --field=url); do
  wp --url="$url" transient delete --expired
done
```

## Hosting a network on Azure

The same rules apply as for any WordPress on Azure, with a few Multisite details:

- Size the App Service plan and Azure Database for MySQL Flexible Server for the busiest sites combined, since the whole network shares them.
- App Service managed certificates don’t cover wildcard domains. For a subdomain network, bring a wildcard certificate through Key Vault, or terminate TLS at Azure Front Door.
- Put media on Azure Blob Storage behind a CDN so the shared web tier isn’t serving every upload for every site.
- Add a persistent object cache such as Azure Cache for Redis. It helps more on a network because many sites share one database.
- Test plugin and core updates on a staging copy of the whole network, then promote with a deployment slot swap, as described in the zero-downtime deployments post.

## Decision checklist

Multisite is a good fit if you can answer yes to most of these:

- One team owns the code, updates, and security for every site.
- The sites use the same theme, or a parent theme with small variations.
- The sites need the same set of plugins.
- It’s acceptable for all sites to be down together during an incident.
- No single site has traffic or uptime needs far above the others.
- No contract or regulation requires the sites to be isolated.
- You expect to add sites regularly.
- Every plugin you need is tested on Multisite.

If several answers are no, run separate single sites and automate their management instead. Both setups can be operated well. The expensive mistake is picking one and finding out a year later that you needed the other.
