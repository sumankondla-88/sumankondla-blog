# Admin editor (`/keystatic`) and AI writing desk (`/admin/ai`) behind Cloudflare Access

The admin is [Keystatic](https://keystatic.com) in GitHub mode. Saving a post commits to this repo's
default branch, and Workers Builds deploys it. **Cloudflare Access** (Zero Trust) controls who can reach
`/keystatic` at all. The Worker also verifies the Access login itself (`src/middleware.ts`) and returns
403 for the admin routes if Access is not configured, so the admin is closed until you finish this setup.

## 1. Create the GitHub App (one time, on your machine)

1. In `.env` set `PUBLIC_KEYSTATIC_STORAGE=github`, then run `npm run dev`.
2. Open <http://127.0.0.1:4321/keystatic> and follow "Create GitHub App". Sign in as the repo owner
   (`sumankondla-88`). Keystatic writes the four values below into `.env`.
3. In GitHub → Settings → Developer settings → GitHub Apps → your app:
   - Add the callback URL `https://sumankondla.com/api/keystatic/github/oauth/callback`.
   - Install the app on `sumankondla-blog` only.
4. Remove `PUBLIC_KEYSTATIC_STORAGE` from `.env` to go back to local file editing.

## 2. Worker configuration (Cloudflare dashboard)

Workers & Pages → your Worker → Settings:

| Where | Name | Value |
|---|---|---|
| Variables and Secrets (secret) | `KEYSTATIC_GITHUB_CLIENT_SECRET` | from `.env` |
| Variables and Secrets (secret) | `KEYSTATIC_SECRET` | from `.env` |
| Variables and Secrets (text) | `KEYSTATIC_GITHUB_CLIENT_ID` | from `.env` |
| Variables and Secrets (text) | `CF_ACCESS_TEAM_DOMAIN` | `<your-team>.cloudflareaccess.com` |
| Variables and Secrets (text) | `CF_ACCESS_AUD` | AUD tag from step 3 |
| Builds → Variables and secrets | `PUBLIC_KEYSTATIC_GITHUB_APP_SLUG` | the app's slug (inlined at build time) |
| Variables and Secrets (secret) | `ANTHROPIC_API_KEY` | Anthropic API key for draft and SEO assistance |
| Variables and Secrets (secret) | `OPENAI_API_KEY` | OpenAI API key for cover image generation |
| Variables and Secrets (text, optional) | `ANTHROPIC_MODEL` | Model override; defaults to `claude-sonnet-5-5` |
| Variables and Secrets (text, optional) | `OPENAI_IMAGE_MODEL` | Model override; defaults to `gpt-image-2.5-flare` |

## 3. Cloudflare Access (Zero Trust dashboard)

1. **Settings → Authentication → Login methods**: add one (One-time PIN needs no identity provider;
   Google or GitHub also work).
2. **Access → Applications → Add an application → Self-hosted**:
   - Session duration: 24 hours.
   - Destinations (same app): `sumankondla.com` with paths `keystatic*`, `api/keystatic*`,
     `admin/ai*`, and `api/admin*`. Optionally add `plan*` to protect the internal editorial plan.
     Add the same paths on your `*.workers.dev` hostname as well.
   - Policy: **Allow** → Include → **Emails** → your address only.
3. Open the application's overview and copy the **Application Audience (AUD) Tag** into `CF_ACCESS_AUD`.
   Your team domain is shown under Settings → Custom pages (or the Zero Trust URL).
4. Redeploy, then visit `https://sumankondla.com/keystatic` or `https://sumankondla.com/admin/ai`.
   You should get the Access login, then Keystatic's own GitHub sign-in the first time.

## AI writing desk

The private writing desk at `/admin/ai` uses Anthropic for article drafts and SEO metadata suggestions,
and OpenAI Images for cover artwork. Add `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` as Worker secrets
before using those tools. For local development, set the same values in `.env`.

Generated article text is returned for review and copying into Keystatic. Generated images can be
previewed and downloaded, then uploaded through the post's Cover image field. The tool does not save,
commit, or publish generated content automatically. Verify technical details, edit the result, and
check the provider's billing and usage limits before generating.

## Notes

- Posts stay `.md`. The editor parses the body as MDX, so avoid raw HTML tags and `import` lines in posts.
- `patches/@keystatic+core+*.patch` (applied on `npm install`) stops Keystatic from truncating code-fence
  titles that contain spaces, such as `title="wp-config.php (step 1)"`. Keep it when upgrading Keystatic.
- Cover images upload to `public/images/covers/`. A post with no cover set falls back to
  `/images/covers/<slug>.jpg` if that file exists.
