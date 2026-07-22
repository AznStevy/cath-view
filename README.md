# Cath View

3D coronary anatomy viewer with RAO/LAO and cranial/caudal C-arm angles (Three.js).

## Local

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

Output is in `dist/`.

## Deploy (GitHub Pages)

1. Push this repo to GitHub.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**  
   (Do **not** choose “Deploy from a branch” — that serves source files and shows a white screen.)
3. Push to `main` (or re-run the **Deploy** workflow under the Actions tab).

Site URL: `https://<user>.github.io/cath-view/`
