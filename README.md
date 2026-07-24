# Cath View

3D coronary anatomy viewer with RAO/LAO and cranial/caudal C-arm angles (Three.js).

Created by **Stevy**, an internal medicine resident interested in cardiology.

**Live site:** [https://aznstevy.github.io/cath-view/](https://aznstevy.github.io/cath-view/)

## Disclaimer

This is an **educational tool** only. It is not medical advice, not a diagnostic device, and not a substitute for clinical judgment, formal angiography training, or patient care. The coronary anatomy is a simplified teaching model and may not match real patient anatomy. The author assumes **no liability** for any decisions, outcomes, or damages arising from use of this tool.

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
