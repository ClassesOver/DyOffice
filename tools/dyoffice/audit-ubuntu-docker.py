#!/usr/bin/env python3
"""Read-only hosted Ubuntu Docker audit. Never grants execution authority."""
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import time

LIMIT = 16384
DOCKER_FORMAT = '{"serverVersion":{{json .ServerVersion}},"cgroupVersion":{{json .CgroupVersion}},"cgroupDriver":{{json .CgroupDriver}},"securityOptions":{{json .SecurityOptions}}}'
COMMANDS = {
    'cgroupFs': ['stat', '-fc', '%T', '/sys/fs/cgroup'],
    'daemonDelegate': ['systemctl', 'show', 'docker.service', '--property=Delegate', '--value'],
    'docker': ['docker', '--host', 'unix:///var/run/docker.sock', 'info', '--format', DOCKER_FORMAT],
}

def assess(facts):
    docker = facts.get('docker')
    docker = docker if isinstance(docker, dict) else {}
    options = docker.get('securityOptions')
    options = options if isinstance(options, list) else []
    checks = {
        'ubuntu_24_04': facts.get('ubuntu') == '24.04',
        'systemd_pid1': facts.get('pid1') == 'systemd',
        'cgroup_v2': facts.get('cgroupFs') == 'cgroup2fs',
        'cpu_memory_pids': isinstance(facts.get('controllers'), list) and set(['cpu','memory','pids']).issubset(facts['controllers']),
        'docker_server': isinstance(docker.get('serverVersion'), str) and bool(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[+~.a-zA-Z0-9-]*)', docker['serverVersion'])),
        'docker_cgroup_v2': docker.get('cgroupVersion') == '2',
        'docker_systemd_driver': docker.get('cgroupDriver') == 'systemd',
        'docker_user_namespace': any(v in options for v in ['name=rootless', 'name=userns']),
        'docker_seccomp': 'name=seccomp,profile=builtin' in options,
        # Daemon metadata is only a prerequisite observation, not proof that a
        # particular container has an enforcing LSM profile. Unknown fails closed.
        'docker_lsm_observed': any(v in options for v in ['name=apparmor', 'name=selinux']),
        'daemon_delegation_observed': facts.get('daemonDelegate') == 'yes',
    }
    return {'scope':'read-only-hosted-ubuntu-docker-audit', 'status':'unsupported',
            'host_prerequisites_observed':all(checks.values()), 'checks':checks,
            'missing':[key for key, ok in checks.items() if not ok],
            'unverified':['container_cgroup_delegation','container_uid_gid_mapping','nested_systemd_unit','runtime_isolation'],
            'container_probe_run':False, 'execution_available':False}

def bounded_read(path):
    with open(path, 'rb') as f:
        data = f.read(LIMIT + 1)
    if len(data) > LIMIT: raise ValueError('oversize')
    return data.decode('utf-8', errors='strict')

def command(argv, timeout=5, limit=LIMIT):
    # No inherited DOCKER_HOST/CONTEXT/TLS_CONFIG or command supplied by workflow input.
    env = {'PATH':'/usr/local/bin:/usr/bin:/bin', 'LANG':'C', 'LC_ALL':'C'}
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env=env)
    try:
        data = bytearray(); deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as selected:
            selected.register(process.stdout, selectors.EVENT_READ)
            while True:
                left = deadline - time.monotonic()
                if left <= 0: raise TimeoutError('timeout')
                if not selected.select(left): raise TimeoutError('timeout')
                chunk = os.read(process.stdout.fileno(), min(4096, limit + 1 - len(data)))
                if not chunk: break
                data.extend(chunk)
                if len(data) > limit: raise ValueError('oversize')
        if process.wait(timeout=max(0.001, deadline-time.monotonic())) != 0:
            raise ValueError('command_failed')
        return data.decode('utf-8', errors='strict').strip()
    finally:
        if process.poll() is None: process.kill()
        process.wait()
        process.stdout.close()

def collect():
    facts = {}; unavailable = []
    def capture(name, fn):
        try: facts[name] = fn()
        except (OSError, ValueError, TimeoutError, subprocess.SubprocessError): unavailable.append(name)
    def ubuntu():
        fields = dict(line.split('=',1) for line in bounded_read('/etc/os-release').splitlines() if '=' in line)
        return fields.get('VERSION_ID','').strip('"') if fields.get('ID','').strip('"') == 'ubuntu' else 'not-ubuntu'
    capture('ubuntu', ubuntu)
    capture('pid1', lambda: bounded_read('/proc/1/comm').strip())
    capture('controllers', lambda: sorted(set(bounded_read('/sys/fs/cgroup/cgroup.controllers').split())))
    capture('cgroupFs', lambda: command(COMMANDS['cgroupFs']))
    capture('daemonDelegate', lambda: command(COMMANDS['daemonDelegate']))
    def docker():
        # A symlink/other object or denied lookup is not an authenticated local socket.
        if not stat.S_ISSOCK(os.lstat('/var/run/docker.sock').st_mode): raise ValueError('not_socket')
        value = json.loads(command(COMMANDS['docker']))
        if not isinstance(value,dict): raise ValueError('not_object')
        # Emit only a fixed set of nonsensitive metadata, never full docker info/env/errors.
        opts = value.get('securityOptions')
        if not isinstance(opts,list): raise ValueError('invalid_options')
        return {'serverVersion':value.get('serverVersion'), 'cgroupVersion':value.get('cgroupVersion'),
                'cgroupDriver':value.get('cgroupDriver'),
                'securityOptions':[v for v in opts if v in ['name=rootless','name=userns','name=seccomp,profile=builtin','name=apparmor','name=selinux']]}
    capture('docker', docker)
    report = assess(facts)
    report['unavailable_observations'] = unavailable
    # Only constrained facts; raw daemon metadata, mount paths and credentials are not written.
    report['observed_controllers'] = [x for x in facts.get('controllers',[]) if x in ['cpu','memory','pids','io','cpuset']]
    return report

def main(args):
    if len(args) != 1: raise SystemExit('usage: audit-ubuntu-docker.py OUTPUT_JSON')
    report = collect()
    Path(args[0]).write_text(json.dumps(report, indent=2, sort_keys=True)+'\n', encoding='utf-8')
    print('UNSUPPORTED: read-only audit collected; no container/systemd execution was attempted.')
    return 2

if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
