# Gitee mirror contract

Provider: Gitee
Repository: private
Canonical branch: main
Expected environment variable: ZEVANORY_GITEE_REPO_URL
Purpose: independent non-GitHub repository authority

The Gitee mirror must contain the exact canonical SHA before it can count toward quorum.
GitHub remains optional and cannot satisfy the non-GitHub quorum by itself.
No paid service or local heavy runner is permitted.