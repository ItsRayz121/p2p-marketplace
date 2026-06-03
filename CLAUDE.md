# Project Instructions

## Deployment & Git Workflow

This project uses **automatic deployment** driven by the `main` branch:

- GitHub `main` → **Railway Production** (backend)
- GitHub `main` → **Vercel Production** (frontend)

### Preferred workflow (overrides default "branch first" behavior)

- When the user **explicitly approves a change and asks to deploy it**, commit directly to `main` and push to `origin/main`.
- **Do NOT create feature branches.**
- **Do NOT create PRs.**
- **Do NOT ask the user to manually merge branches.**
- Only use a feature branch or PR workflow when the user **explicitly requests** it.

### After pushing to `main`, always confirm:

1. **Commit hash** — the SHA that was pushed.
2. **Push success** — whether `git push origin main` succeeded.
3. **Frontend build status** — did the frontend build/typecheck pass?
4. **Backend build status** — did the backend build/typecheck pass?
5. **Auto-deploy** — confirm that Railway (backend) and Vercel (frontend) should auto-deploy from this push.
