# Page views

Each post shows a view count in its byline ("· 1,234 views"). The browser counts one view per post per day
by calling `/api/views` (`src/pages/api/views.ts`), which stores counts in Cloudflare D1. Bots that don't run
JavaScript aren't counted. Only slugs that are real posts are stored.

Until the database is connected the route returns `{ "views": null }` and no count is shown.

## One-time setup

1. Cloudflare → Storage & Databases → D1 → **Create database**, name `blog-db`. Copy its **Database ID**.
2. Add the binding to `wrangler.json`:

   ```json
   "d1_databases": [{ "binding": "DB", "database_name": "blog-db", "database_id": "<the id>" }]
   ```

3. Push. The `views` table is created automatically on first use.

To see all counts: D1 → blog-db → Console → `SELECT * FROM views ORDER BY count DESC;`
