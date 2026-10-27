#!/usr/bin/env python3
"""Fail-closed secret scan of git history with pinned, verified scanners (T5).

Used by two workflows, always from a trusted copy of this file:
  * secret-history-scan.yml        `full-history`: every ref of the checked-out repo
  * secret-scan-contract-protected `pr-head`: the history of a pull request head that
    the BASE-branch workflow fetched into a separate repository as data. This file
    then comes from the base checkout, so the verdict is computed end to end by
    base-controlled code; nothing from the pull request is executed.

Integrity rules (each violation is an execution error, exit 2):
  * scanners are downloaded from exact release URLs, the tarball SHA-256 is checked,
    and the extracted binary's SHA-256 is checked again immediately before EVERY
    invocation; binaries are run by absolute path with a minimal environment (no PATH
    lookup, no GITLEAKS_*/GIT_* variables, no BASH_ENV);
  * gitleaks runs with a controlled config (built-in default ruleset), ignores inline
    gitleaks:allow; TruffleHog ignores trufflehog:ignore and keeps --only-verified;
  * reports are written to a private temporary directory created here, must exist,
    parse, and agree with the exit code; findings must belong to the scanned history;
  * the number of commits gitleaks reports must EQUAL an independent count computed
    here with a different git command; TruffleHog's log must be consistent;
  * repository gitleaks configuration (.gitleaks*, *gitleaks*.toml) is refused.
Exit codes: 0 clean, 1 findings, 2 execution/integrity error.
Standard library only.
"""
import argparse
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from collections import Counter

GIT = '/usr/bin/git'
SCANNERS = {
    'gitleaks': {
        'version': '8.30.1',
        'url': 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz',
        'tar_sha256': '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
        'bin_sha256': '88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509',
    },
    'trufflehog': {
        'version': '3.99.2',
        'url': 'https://github.com/trufflesecurity/trufflehog/releases/download/v3.99.2/trufflehog_3.99.2_linux_amd64.tar.gz',
        'tar_sha256': '3c7b0d1dc4278294269bfdd7594bca8bb28c78da0a4a06ad202ded37b48deca4',
        'bin_sha256': 'aba71aa8cee0ef87f4adddafbcd778a112b740bfba4a81a2de299d1a8e15f074',
    },
}
CONTROLLED_CONFIG = 'title = "zevanory-controlled-default"\n[extend]\nuseDefault = true\n'


class IntegrityError(Exception):
    pass


# Network/TLS settings are the only variables passed through from the runner; tokens,
# GIT_* overrides, GITLEAKS_* config, BASH_ENV, LD_* and PATH changes never reach a tool.
PASSTHROUGH = ('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
               'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO')


def clean_env(home):
    env = {k: os.environ[k] for k in PASSTHROUGH if k in os.environ}
    env.update({'PATH': '/usr/bin:/bin', 'HOME': str(home), 'LANG': 'C.UTF-8', 'TMPDIR': str(home)})
    return env


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def git(env, repo, *args):
    return subprocess.run([GIT, '-C', str(repo), *args], env=env, check=True, capture_output=True, text=True).stdout


def install(work, offline_dir=None):
    """Download, verify (tarball + binary) and extract both scanners into work/bin."""
    bindir = work / 'bin'
    bindir.mkdir(mode=0o700)
    paths = {}
    for name, spec in SCANNERS.items():
        if offline_dir:  # test harness only; the tarball digest is still enforced
            data = (pathlib.Path(offline_dir) / f'{name}.tar.gz').read_bytes()
        else:
            with urllib.request.urlopen(spec['url'], timeout=120) as resp:
                data = resp.read()
        if hashlib.sha256(data).hexdigest() != spec['tar_sha256']:
            raise IntegrityError(f'{name}: tarball SHA-256 mismatch')
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
            member = tar.getmember(name)
            if not member.isfile():
                raise IntegrityError(f'{name}: tarball member is not a regular file')
            target = bindir / name
            with tar.extractfile(member) as src, open(target, 'wb') as dst:
                shutil.copyfileobj(src, dst)
        target.chmod(0o500)
        paths[name] = target.resolve()
        verify_binary(name, paths[name])
    return paths


def verify_binary(name, path):
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise IntegrityError(f'{name}: binary path must be an absolute regular file')
    if sha256_file(path) != SCANNERS[name]['bin_sha256']:
        raise IntegrityError(f'{name}: binary SHA-256 mismatch (substituted tool)')


def run_scanner(name, path, args, env, cwd, stdout):
    verify_binary(name, path)  # immediately before invocation
    with open(stdout, 'wb') as out:
        proc = subprocess.run([str(path), *args], env=env, cwd=str(cwd), stdout=out, stderr=subprocess.PIPE)
    return proc.returncode, proc.stderr.decode('utf-8', 'replace')


def refuse_config(names):
    bad = sorted(n for n in names
                 if (pathlib.PurePosixPath(n).name.startswith('.gitleaks') and n != '.gitleaksignore')
                 or ('gitleaks' in pathlib.PurePosixPath(n).name.lower() and n.lower().endswith('.toml')))
    if bad:
        raise IntegrityError(f'REPO_GITLEAKS_CONFIG_REFUSED {bad[:20]}')


def expected_patch_commits(env, repo, rev_args):
    """Commits gitleaks must read a text patch for: >=1 non-binary, non-deleted file
    with changed lines (rename detection on). Different git command from gitleaks'."""
    raw = git(env, repo, 'log', *rev_args, '--raw', '--numstat', '--format=@%H')
    count = 0
    for block in raw.split('\n@'):
        lines = [l for l in block.split('\n') if l]
        if not lines:
            continue
        entries = [l for l in lines[1:] if l.startswith(':')]
        stats = [l for l in lines[1:] if not l.startswith(':') and l.count('\t') >= 2]
        if len(entries) != len(stats):
            raise IntegrityError(f'EXPECTED_COUNT_PARSE_ERROR {lines[0][:12]}')
        for entry, stat in zip(entries, stats):
            status = entry.split('\t', 1)[0].split()[-1][0]
            added, deleted = stat.split('\t')[:2]
            if added != '-' and status != 'D' and int(added) + int(deleted) > 0:
                count += 1
                break
    return count


def gitleaks_pass(kind, paths, env, work, repo, gl_log_opts, count_args, ignore, history):
    cfg = work / 'gitleaks.toml'
    cfg.write_text(CONTROLLED_CONFIG)
    report = work / f'gitleaks-{kind}.json'
    expected = expected_patch_commits(env, repo, count_args)
    args = ['git', '--config', str(cfg), '--log-opts', ' '.join(gl_log_opts), '--redact', '--ignore-gitleaks-allow',
            '--no-banner', '--no-color', '--gitleaks-ignore-path', str(ignore), '--report-format', 'json',
            '--report-path', str(report), str(repo)]
    code, log = run_scanner('gitleaks', paths['gitleaks'], args, env, work, work / f'gitleaks-{kind}.stdout')
    log = re.sub(r'\x1b\[[0-9;]*m', '', log)
    print(log, end='' if log.endswith('\n') else '\n')
    hits = re.findall(r'\b(\d+) commits scanned', log)
    scanned = int(hits[0]) if len(hits) == 1 else -1
    problems, rows = [], []
    if not report.is_file():
        problems.append('GITLEAKS_REPORT_MISSING')
    else:
        rows = json.loads(report.read_text())
        if not isinstance(rows, list):
            problems.append('GITLEAKS_REPORT_NOT_A_LIST')
            rows = []
    if code not in (0, 1):
        problems.append(f'GITLEAKS_EXIT={code}')
    if code == 1 and not rows:
        problems.append('GITLEAKS_EXIT_1_WITHOUT_FINDINGS')
    if code == 0 and rows:
        problems.append('GITLEAKS_EXIT_0_WITH_FINDINGS')
    errs = [l for l in log.splitlines() if re.search(r'\bERR\b|\bFTL\b|fatal:', l)]
    if errs:
        problems.append(f'GITLEAKS_ERROR_LINES={len(errs)}')
    if scanned != expected:
        problems.append(f'SCANNED_COMMITS={scanned} expected exactly {expected}')
    foreign = sorted({str(r.get('Commit')) for r in rows if str(r.get('Commit')) not in history})
    if foreign:
        problems.append(f'GITLEAKS_FINDINGS_OUTSIDE_SCANNED_HISTORY={len(foreign)}')
    rules = Counter(str(r.get('RuleID') or 'unknown') for r in rows)
    locations = sorted({(str(r.get('RuleID') or 'unknown'), str(r.get('File') or ''), int(r.get('StartLine') or 0),
                         str(r.get('Commit') or '')[:12], str(r.get('Fingerprint') or '')) for r in rows})
    print(f'::notice title=GITLEAKS_SCANNED_{kind.upper()}::scanned_commits={scanned} expected={expected} findings={len(rows)} exit={code}')
    return {'scanner': 'gitleaks', 'kind': kind, 'redacted': True, 'findings': len(rows),
            'rule_counts': dict(sorted(rules.items())),
            'locations': [dict(zip(('rule', 'file', 'line', 'commit', 'fingerprint'), l)) for l in locations],
            'exit_code': code, 'scanned_commits': scanned, 'expected_commits': expected,
            'execution_problems': problems, 'pass': code == 0 and not rows and not problems}


def trufflehog_pass(paths, env, work, repo):
    out = work / 'trufflehog.jsonl'
    args = ['git', f'file://{repo}', '--only-verified', '--no-ignore-tag', '--json', '--no-update']
    code, err = run_scanner('trufflehog', paths['trufflehog'], args, env, work, out)
    results = verified = 0
    for line in out.read_text(errors='ignore').splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and 'DetectorName' in row:
            results += 1
            verified += row.get('Verified') is True
    finished = []
    for line in err.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and row.get('msg') == 'finished scanning':
            finished.append(row)
    problems = []
    if code != 0:
        problems.append(f'TRUFFLEHOG_EXIT={code}')
    if len(finished) != 1:
        problems.append(f'TRUFFLEHOG_FINISHED_LINES={len(finished)}')
    chunks = int(finished[0].get('chunks') or 0) if len(finished) == 1 else -1
    nbytes = int(finished[0].get('bytes') or 0) if len(finished) == 1 else -1
    logged = int(finished[0].get('verified_secrets') or 0) if len(finished) == 1 else -1
    if chunks <= 0 or nbytes <= 0 or chunks > nbytes:
        problems.append(f'TRUFFLEHOG_CHUNKS={chunks} BYTES={nbytes}')
    if len(finished) == 1 and logged != verified:
        problems.append(f'TRUFFLEHOG_VERIFIED_MISMATCH log={logged} json={verified}')
    if results != verified:
        problems.append(f'TRUFFLEHOG_UNVERIFIED_RESULTS={results - verified}')
    if problems:
        print('\n'.join(err.splitlines()[-60:]))  # logs only; finding JSON went to the private file
    print(f'::notice title=TRUFFLEHOG_SCANNED::chunks={chunks} bytes={nbytes} verified={verified} exit={code}')
    return {'scanner': 'trufflehog', 'verified_only': True, 'verified_findings': verified, 'exit_code': code,
            'chunks_scanned': chunks, 'bytes_scanned': nbytes, 'execution_problems': problems,
            'pass': verified == 0 and not problems}


def history_coverage(env, repo):
    """full-history: every origin branch head must be present (late heads fetched once)."""
    if git(env, repo, 'rev-parse', '--is-shallow-repository').strip() != 'false':
        raise IntegrityError('HISTORY_INCOMPLETE shallow clone')

    def remote_heads():
        out = git(env, repo, 'ls-remote', '--heads', 'origin').split('\n')
        return {ref: sha for sha, ref in (l.split('\t') for l in out if l.strip())}

    def missing(heads):
        return sorted(r for r, sha in heads.items()
                      if subprocess.run([GIT, '-C', str(repo), 'cat-file', '-e', sha + '^{commit}'], env=env,
                                        capture_output=True).returncode != 0)
    heads = remote_heads()
    miss = missing(heads)
    if miss:
        git(env, repo, 'fetch', '--no-tags', 'origin', *[f'+{r}:refs/remotes/origin/{r[len("refs/heads/"):]}' for r in miss])
        now = remote_heads()
        miss = missing({r: now[r] for r in miss if r in now})
    total = int(git(env, repo, 'rev-list', '--all', '--count'))
    non_merge = int(git(env, repo, 'rev-list', '--all', '--no-merges', '--count'))
    summary = {'remote_heads': len(heads), 'missing_heads': miss, 'commits_all_refs': total,
               'non_merge_commits': non_merge, 'pass': not miss and len(heads) > 0 and total > 1}
    print(f'::notice title=HISTORY_COVERAGE::remote_heads={len(heads)} missing={len(miss)} commits_all_refs={total} non_merge={non_merge}')
    if not summary['pass']:
        raise IntegrityError(f'HISTORY_INCOMPLETE missing_heads={miss[:20]} remote_heads={len(heads)}')
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['full-history', 'pr-head'])
    ap.add_argument('--repo', required=True)
    ap.add_argument('--rev', help='pr-head: the pull request head SHA')
    ap.add_argument('--ignore', required=True, help='.gitleaksignore to apply (trusted copy)')
    ap.add_argument('--out', required=True, help='directory for sanitized *summary.json')
    ap.add_argument('--offline-tarballs', help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    repo = pathlib.Path(a.repo).resolve()
    ignore = pathlib.Path(a.ignore).resolve()
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    work = pathlib.Path(tempfile.mkdtemp(prefix='secret-scan-'))
    env = clean_env(work)
    parts = {}
    try:
        if a.mode == 'pr-head':
            if not a.rev or not re.fullmatch(r'[0-9a-f]{40}', a.rev):
                raise IntegrityError('pr-head needs --rev <40-hex sha>')
            if git(env, repo, 'rev-parse', a.rev + '^{commit}').strip() != a.rev:
                raise IntegrityError('pr-head commit missing')
            refuse_config(git(env, repo, 'ls-tree', '-r', '--name-only', a.rev).splitlines())
            history = set(git(env, repo, 'rev-list', a.rev).split())
            commits_opts, count_commits = [a.rev], [a.rev, '--no-merges']
            merges_opts = [a.rev, '--merges', '--remerge-diff']
            parts['history'] = {'pr_head': a.rev, 'commits': len(history), 'pass': len(history) > 0}
        else:
            parts['history'] = history_coverage(env, repo)
            names = []
            for dirpath, dirnames, filenames in os.walk(repo, followlinks=False):
                dirnames[:] = [d for d in dirnames if d != '.git']
                names += [(pathlib.Path(dirpath) / n).relative_to(repo).as_posix() for n in filenames + dirnames]
            refuse_config(names + git(env, repo, 'ls-tree', '-r', '--name-only', 'HEAD').splitlines())
            history = set(git(env, repo, 'rev-list', '--all').split())
            commits_opts, count_commits = ['--all'], ['--all', '--no-merges']
            merges_opts = ['--all', '--merges', '--remerge-diff']
        paths = install(work, a.offline_tarballs)
        parts['gitleaks-commits'] = gitleaks_pass('commits', paths, env, work, repo, commits_opts, count_commits, ignore, history)
        parts['gitleaks-merges'] = gitleaks_pass('merges', paths, env, work, repo, merges_opts, merges_opts, ignore, history)
        parts['trufflehog'] = trufflehog_pass(paths, env, work, repo)
    except (IntegrityError, subprocess.CalledProcessError, OSError, ValueError, KeyError, tarfile.TarError) as e:
        msg = getattr(e, 'stderr', None) or str(e)
        print(f'::error title=SECRET_SCAN_EXECUTION_ERROR::{type(e).__name__}: {str(msg)[:400]}')
        (out / 'summary.json').write_text(json.dumps({'mode': a.mode, 'error': type(e).__name__, 'pass': False}, indent=2))
        return 2
    finally:
        shutil.rmtree(work, ignore_errors=True)
    for name, part in parts.items():
        (out / f'{name}-summary.json').write_text(json.dumps(part, indent=2))
    ok = all(p['pass'] is True for p in parts.values())
    (out / 'summary.json').write_text(json.dumps({'repository': 'arbmsistone-lab/zevanory-public-mirror', 'mode': a.mode, **parts, 'pass': ok}, indent=2))
    if ok:
        print(f'SECRET_SCAN=PASS mode={a.mode}')
        return 0
    g, m, t = parts['gitleaks-commits'], parts['gitleaks-merges'], parts['trufflehog']
    print(f"::error title=SECRET_SCAN_FAILED::mode={a.mode} gitleaks findings={g['findings']} rules={g['rule_counts']} "
          f"files={sorted(set(l['file'] for l in g['locations']))[:10]} problems={g['execution_problems']}; "
          f"merges findings={m['findings']} problems={m['execution_problems']}; "
          f"trufflehog verified={t['verified_findings']} problems={t['execution_problems']}")
    executed_badly = any(p.get('execution_problems') for p in (g, m, t))
    return 2 if executed_badly else 1


if __name__ == '__main__':
    sys.exit(main())
