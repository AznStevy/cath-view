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

1. Create a GitHub repo and push this project (see below).
2. In the repo: **Settings → Pages → Source → GitHub Actions**.
3. Push to `main`. The workflow in `.github/workflows/deploy.yml` builds and publishes `dist/`.

Site URL will be `https://<user>.github.io/<repo>/`.
