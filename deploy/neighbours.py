"""Neighbour snapshots for deploys on the shared hub, taken from OUTSIDE (this machine) plus the
server-side files written by snapshot-server.sh, and a diff between two snapshots.

  python deploy/neighbours.py snap <dir>
      server snapshot over SSH (containers, start times, restart counts, vhosts, listening sockets,
      networks, nginx-proxy's generated config) + the HTTP status and body sha256 of every vhost
  python deploy/neighbours.py diff <before> <after> [--allow sog-web,sog-api] [--stable <b1>,<b2>]
                                   [--network-prefix sog] [--offline]

The HTTP part requests every vhost found in the live `docker ps` (not a list from notes) with a
cache-busting query and records status + sha256 of the body. Bodies of dynamic pages change on
every request, so a body hash is compared only where it was identical in every --stable snapshot
(extra BEFORE snapshots). Allowed differences: the containers named in --allow (ours) and added
networks whose name starts with --network-prefix (ours). The diff also reads the nginx-proxy log
between the two snapshot times (docker logs --since/--until over SSH, read-only) and counts
[emerg]/[crit] lines; --offline skips that (replaying old snapshots) and says so in the output.
Anything else in the diff = STOP and roll back.

Hub settings come from deploy/hub.env (gitignored, SOG_* keys, see hub.env.example), then from
SOG_* environment variables. tools/reports/pull.py imports HUB, SSH and require_hub() from here.
Python 3.9+, standard library only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import shlex
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def _hub_env() -> dict:
    """deploy/hub.env as a dict (the same rules as deploy/lib.sh), SOG_* environment on top."""
    env: dict[str, str] = {}
    path = os.environ.get('SOG_HUB_ENV') or os.path.join(HERE, 'hub.env')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith('#'):
                    continue
                m = re.match(r'^(SOG_[A-Z0-9_]+)=(.*)$', line)
                if not m:
                    continue
                val = m.group(2).strip()
                if len(val) >= 2 and val[0] == val[-1] and val[0] in '"\'':
                    val = val[1:-1]
                env[m.group(1)] = val
    env.update({k: v for k, v in os.environ.items() if k.startswith('SOG_') and k != 'SOG_HUB_ENV'})
    return env


def _key_path(key: str) -> str:
    key = os.path.expanduser(key)
    # a Git Bash style path (/c/Users/...) for Windows' own ssh.exe
    m = re.match(r'^/([a-zA-Z])/(.*)$', key)
    if os.name == 'nt' and m:
        key = f'{m.group(1).upper()}:/{m.group(2)}'
    return key


HUB = _hub_env()
SSH = ['ssh', '-p', HUB.get('SOG_PORT', '22'), '-i', _key_path(HUB.get('SOG_KEY', '~/.ssh/id_ed25519')),
       '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', HUB.get('SOG_HOST', '')]


def require_hub(*keys: str) -> None:
    """Exit with a clear message when hub.env lacks a key the caller needs."""
    missing = [k for k in ('SOG_HOST',) + keys if not HUB.get(k)]
    if missing:
        sys.exit(f'deploy/hub.env lacks {", ".join(missing)} (copy deploy/hub.env.example and fill it in)')


def ssh(cmd: str, timeout: int = 180) -> str:
    res = subprocess.run(SSH + [cmd], capture_output=True, timeout=timeout)
    if res.returncode != 0:
        raise SystemExit(f'ssh failed ({res.returncode}): {res.stderr.decode("utf-8", "replace").strip()}')
    return res.stdout.decode('utf-8', 'replace')


def fetch(url: str) -> tuple[int, str]:
    ctx = ssl.create_default_context()
    sep = '&' if '?' in url else '?'
    req = urllib.request.Request(f'{url}{sep}cb={random.randrange(1 << 30)}', headers={'User-Agent': 'sog-neighbour-check/1'})
    try:
        with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
            return r.status, hashlib.sha256(r.read()).hexdigest()
    except urllib.error.HTTPError as e:
        return e.code, hashlib.sha256(e.read() or b'').hexdigest()
    except Exception as e:  # noqa: BLE001  any failure is a recorded state, not a crash
        return -1, type(e).__name__


def snap(out: str) -> None:
    require_hub('SOG_BACKUPS')
    os.makedirs(out, exist_ok=True)
    name = os.path.basename(os.path.abspath(out))
    if not re.fullmatch(r'[A-Za-z0-9._-]+', name):
        sys.exit(f'snapshot directory name {name!r}: use letters, digits, ".", "_" or "-" only')
    remote = f"{HUB['SOG_BACKUPS'].rstrip('/')}/sog-neighbours/{name}"
    # the script may have CRLF endings in a Windows checkout; bash on the server needs LF
    with open(os.path.join(HERE, 'snapshot-server.sh'), encoding='utf-8') as fh:
        script = fh.read().replace('\r', '')
    # bytes, not text: text mode on Windows would turn every \n into \r\n on the way to bash
    res = subprocess.run(SSH + [f'bash -s {shlex.quote(remote)}'], input=script.encode('utf-8'), capture_output=True, timeout=300)
    stdout = res.stdout.decode('utf-8', 'replace')
    if res.returncode != 0 or 'OK' not in stdout:
        raise SystemExit(f'server snapshot failed: {stdout} {res.stderr.decode("utf-8", "replace")}')
    files = {}
    for f in ['containers.txt', 'started.txt', 'vhosts.txt', 'listening.txt', 'df.txt', 'networks.txt', 'taken_at.txt', 'SHA256SUMS']:
        files[f] = ssh(f'cat {shlex.quote(remote + "/" + f)}')
    conf = ssh(f'cat {shlex.quote(remote + "/nginx-proxy-default.conf")}')
    files['nginx-proxy-default.conf.sha256'] = hashlib.sha256(conf.encode()).hexdigest()
    hosts = sorted({line.split('|', 1)[1].strip() for line in files['vhosts.txt'].splitlines() if '|' in line})
    http = {}
    for h in hosts:
        code, digest = fetch(f'https://{h}/')
        http[h] = {'code': code, 'sha256': digest}
    data = {'taken_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'remote_dir': remote, 'server': files, 'http': http}
    with open(os.path.join(out, 'snapshot.json'), 'w', encoding='utf-8') as fh:
        json.dump(data, fh, indent=1)
    print(json.dumps({'dir': out, 'containers': len(files['containers.txt'].splitlines()), 'vhosts': len(hosts)}))


def load(d: str) -> dict:
    with open(os.path.join(d, 'snapshot.json'), encoding='utf-8') as fh:
        return json.load(fh)


def rows(text: str) -> dict:
    out: dict[str, list[str]] = {}
    for line in text.splitlines():
        if '|' in line:
            k, v = line.split('|', 1)
            out.setdefault(k, []).append(v)
    return out


def diff(a_dir: str, b_dir: str, allow: set, stable_dirs: list, network_prefix: str, offline: bool = False) -> int:
    a, b = load(a_dir), load(b_dir)
    stables = [load(d) for d in stable_dirs]
    problems = []
    ca, cb = rows(a['server']['containers.txt']), rows(b['server']['containers.txt'])
    for k in sorted(set(ca) | set(cb)):
        if k in allow:
            continue
        if k not in cb:
            problems.append(f'container gone: {k}')
        elif k not in ca:
            problems.append(f'container added: {k}')
        elif [s.split('|')[0] for s in ca[k]] != [s.split('|')[0] for s in cb[k]]:
            problems.append(f'image changed: {k}')
    sa, sb = rows(a['server']['started.txt']), rows(b['server']['started.txt'])
    for k in sorted(set(sa) & set(sb)):
        if k in allow:
            continue
        pa, pb = sa[k][0].split('|'), sb[k][0].split('|')
        if pa[0] != pb[0]:
            problems.append(f'restarted: {k} ({pa[0]} -> {pb[0]})')
        ra, rb = (pa[1] if len(pa) > 1 else '?'), (pb[1] if len(pb) > 1 else '?')
        if ra != rb:
            problems.append(f'restart count: {k} ({ra} -> {rb})')
    la, lb = set(a['server']['listening.txt'].split()), set(b['server']['listening.txt'].split())
    for p in sorted(lb - la):
        problems.append(f'new listening socket: {p}')
    for p in sorted(la - lb):
        problems.append(f'listening socket gone: {p}')
    for h, v in a['http'].items():
        w = b['http'].get(h)
        if w is None:
            problems.append(f'vhost missing after: {h}')
            continue
        if v['code'] != w['code']:
            problems.append(f'http code changed: {h} {v["code"]} -> {w["code"]}')
        if stables and all(st['http'].get(h, {}).get('sha256') == v['sha256'] for st in stables) and v['sha256'] != w['sha256']:
            problems.append(f'body changed on a static page: {h}')
    added_hosts = sorted(set(b['http']) - set(a['http']))
    # networks: only ours (the prefix, or an allowed name) may appear; none may vanish or change driver
    na, nb = rows(a['server'].get('networks.txt', '')), rows(b['server'].get('networks.txt', ''))
    added_networks = sorted(set(nb) - set(na))
    for k in sorted(set(na) | set(nb)):
        if k not in nb:
            problems.append(f'network gone: {k}')
        elif k not in na:
            if not (k.startswith(network_prefix) or k in allow):
                problems.append(f'network added: {k}')
        elif na[k] != nb[k]:
            problems.append(f'network driver changed: {k}')
    if not na:
        problems.append('networks.txt missing in the BEFORE snapshot')
    if a['server'].get('nginx-proxy-default.conf.sha256') and not b['server'].get('nginx-proxy-default.conf.sha256'):
        problems.append('nginx-proxy config unreadable after')
    log = {'checked': False, 'reason': '--offline'} if offline else proxy_log(window(a), window(b))
    if not log['checked'] and not offline:
        problems.append(f'nginx-proxy log not checked: {log["reason"]}')
    elif log['checked'] and log['emerg_crit']:
        problems.append(f'nginx-proxy log: {log["emerg_crit"]} [emerg]/[crit] lines in the deploy window')
    out = {'before': a_dir, 'after': b_dir, 'allowed': sorted(allow), 'network_prefix': network_prefix,
           'problems': problems, 'added_vhosts': added_hosts, 'added_networks': added_networks,
           'nginx_proxy_log': log, 'complete': log['checked'], 'equal': not problems}
    print(json.dumps(out, indent=1))
    return 0 if not problems else 1


STAMP = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')


def window(s: dict) -> str:
    # the server clock (taken_at.txt) bounds docker logs; the local clock is only a fallback
    t = s['server'].get('taken_at.txt', '').strip() or s.get('taken_at', '')
    return t if STAMP.match(t) else ''


def proxy_log(since: str, until: str) -> dict:
    """Count nginx [emerg]/[crit] lines that nginx-proxy logged between the two snapshots.

    Read-only (docker logs over SSH). Only nginx's own [emerg]/[crit] levels count as problems: a
    bare substring also hits access-log URLs of neighbour sites, so that looser count is reported
    for information only. Sample lines have IPv4 addresses masked (the proxy logs every site's
    visitors)."""
    if not since or not until or since > until:
        return {'checked': False, 'reason': f'bad snapshot times {since!r}..{until!r}'}
    cmd = (f'out=$(docker logs --since {since} --until {until} nginx-proxy 2>&1); rc=$?; '
           'echo "rc=$rc lines=$(printf "%s\\n" "$out" | grep -c .)"; '
           'printf "%s\\n" "$out" | grep -iE "emerg|crit" | head -n 200')
    try:
        res = ssh(cmd).splitlines()
    except SystemExit as e:
        return {'checked': False, 'reason': str(e)}
    head = res[0] if res else ''
    m = re.match(r'^rc=(\d+) lines=(\d+)$', head)
    if not m or m.group(1) != '0':
        return {'checked': False, 'reason': f'docker logs failed: {head or "no output"}'}
    loose = res[1:]
    strict = [x for x in loose if re.search(r'\[(emerg|crit)\]', x)]

    def mask(x: str) -> str:
        return re.sub(r'\b\d{1,3}(\.\d{1,3}){3}\b', 'x.x.x.x', x)[:300]

    return {'checked': True, 'since': since, 'until': until, 'lines_in_window': int(m.group(2)),
            'emerg_crit': len(strict), 'emerg_crit_substring': len(loose), 'samples': [mask(x) for x in strict[:3]]}


def main(argv: list) -> int:
    p = argparse.ArgumentParser(description='Neighbour snapshots and diffs for deploys on the shared hub.')
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('snap', help='take a snapshot into <dir>')
    s.add_argument('dir')
    d = sub.add_parser('diff', help='compare two snapshots; exit 1 on any problem')
    d.add_argument('before')
    d.add_argument('after')
    d.add_argument('--allow', default='sog-web,sog-api', help='our containers (comma list), ignored in the diff')
    d.add_argument('--stable', default='', help='extra BEFORE snapshots (comma list) that mark static bodies')
    d.add_argument('--network-prefix', default='sog', help='networks we may add')
    d.add_argument('--offline', action='store_true', help='skip the nginx-proxy log (replaying old snapshots)')
    a = p.parse_args(argv)
    if a.cmd == 'snap':
        snap(a.dir)
        return 0
    allow = {x.strip() for x in a.allow.split(',') if x.strip()}
    stable = [x.strip() for x in a.stable.split(',') if x.strip()]
    if not a.offline:
        require_hub()
    return diff(a.before, a.after, allow, stable, a.network_prefix, a.offline)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
