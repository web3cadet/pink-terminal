# Polyester Terminal Guide website

Static, dependency-free independent community guide for self-hosting a Telegram trading terminal for Polyester testnet.

## Structure

- `dist/index.html` — content and semantic structure
- `dist/styles.css` — responsive visual system
- `dist/app.js` — navigation, copy buttons and reading progress
- `dist/assets/` — Polyester brand assets

## Local preview

Run this from the `website` folder in the VS Code terminal:

```bash
node preview-server.cjs
```

Then open `http://localhost:4173`.

## Deploy to Vercel

Import the repository and set the project root to `website`. The included `vercel.json` serves `dist` as a static site.

## Deploy to Netlify

Import the repository and set the base directory to `website`. The included `netlify.toml` publishes `dist`.

## Before public release

1. Replace both `OWNER/REPOSITORY` placeholders in `dist/index.html` with the published GitHub repository.
2. Finalize the first-party method for finding the user's numeric Telegram ID.
3. Recheck the recommended Polyester API policy against the current testnet UI.
4. Test the one-command installer on a clean supported Ubuntu VPS.
5. Replace “coming soon” repository text with the real link.

Do not add real API keys, Telegram tokens or server credentials to this folder.
