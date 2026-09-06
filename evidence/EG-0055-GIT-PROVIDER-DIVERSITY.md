# EG-0055 — Git provider diversity

Status: APPROVED WITH RESTRICTIONS.
Date: 2026-09-05.
Scope: repository/CI provider diversification only. No production cutover and no commercial gate changes.

## Evidence A — GitLab hosted runners
Source: GitLab official documentation.
URL: https://docs.gitlab.com/ci/runners/hosted_runners/
Finding: GitLab.com provides managed hosted runners; each job receives a newly provisioned VM. GitLab publishes an SLO target for job start/error rate.
Classification: A — primary technical documentation.

## Evidence A — Cloudflare GitLab integration
Source: Cloudflare official documentation.
URL: https://developers.cloudflare.com/pages/configuration/git-integration/gitlab-integration/
Finding: Cloudflare Pages supports GitLab repositories, branch previews and automatic deployments.
Classification: A — primary technical documentation.

## Evidence A — Vercel Git provider compatibility
Source: Vercel official Git integration documentation.
URL: https://vercel.com/docs/git
Finding: Vercel supports Git-based project integration, including GitLab, so repository authority can change without coupling application code to GitHub Actions.
Classification: A — primary technical documentation.

## Decision
Adopt GitLab.com as the intended primary repository/CI provider only after remote account authorization and a successful independent pipeline.
Keep GitHub as a temporary mirror/fallback until GitLab clone, CI, preview and rollback parity are proven.
Do not run self-managed runners on the operator laptop; heavy CI must remain cloud-hosted.
Do not enable sales, checkout or financial events as part of this migration.
