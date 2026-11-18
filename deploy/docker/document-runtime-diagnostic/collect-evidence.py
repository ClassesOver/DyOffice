#!/usr/bin/env python3
"""Read-only diagnostic evidence, never runtime admission or cleanup."""
import argparse
import hashlib
import json
import re
import selectors
import subprocess
import time

HEX64 = r'[0-9a-f]{64}'
MARKER = {'scope': 'benign-container-manager-diagnostic',
          'fixed_sleep_timeout_observed': True, 'execution_available': False,
          'isolation_certified': False}
PROPERTIES = 'Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,InvocationID,MainPID,ControlGroup'

class Incomplete(Exception):
    pass


def read_command(args):
    # Kill only this read-only CLI on timeout/overflow, never a container/unit.
    with subprocess.Popen(['docker', *args], stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL) as child:
        with selectors.DefaultSelector() as ready:
            ready.register(child.stdout, selectors.EVENT_READ)
            output = bytearray()
            deadline = time.monotonic() + 8
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise Incomplete('read_timeout')
                    if not ready.select(remaining):
                        raise Incomplete('read_timeout')
                    chunk = child.stdout.read1(4096)
                    if not chunk:
                        break
                    output.extend(chunk)
                    if len(output) > 131072:
                        raise Incomplete('read_limit')
                if child.wait(timeout=max(.01, deadline - time.monotonic())) != 0:
                    raise Incomplete('read_failed')
                return output.decode('utf-8', errors='strict')
            except BaseException:
                child.kill()
                child.wait()
                raise


def properties(text):
    result = {}
    for line in text.splitlines():
        key, sep, value = line.partition('=')
        if not sep or key in result:
            raise Incomplete('invalid_unit_evidence')
        result[key] = value
    if set(result) != set(PROPERTIES.split(',')):
        raise Incomplete('missing_unit_evidence')
    return result


def one_json(text):
    value = json.loads(text)
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise Incomplete('invalid_identity_evidence')
    return value[0]


def collect(container, image, commit, run=read_command):
    report = {'schema': 1, 'container_id': container, 'image_id': image,
              'source_commit': commit, 'outcome': 'unknown',
              'execution_available': False, 'isolation_certified': False,
              'reason': 'incomplete_evidence'}
    try:
        if not (re.fullmatch(HEX64, container) and re.fullmatch('sha256:' + HEX64, image)
                and re.fullmatch(r'[0-9a-f]{40}', commit)):
            raise Incomplete('invalid_expected_identity')
        first = one_json(run(['container', 'inspect', container]))
        if first.get('Id') != container or first.get('Image') != image:
            raise Incomplete('container_identity_mismatch')
        artifact = one_json(run(['image', 'inspect', image]))
        if artifact.get('Id') != image or artifact.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') != commit:
            raise Incomplete('image_revision_mismatch')
        if first.get('State', {}).get('Running') is not True:
            raise Incomplete('container_not_running')
        def unit(name):
            return properties(run(['exec', container, 'systemctl', 'show', name,
                                   '--no-pager', '--property=' + PROPERTIES]))
        before = unit('dyoffice-probe.service')
        invocation = before['InvocationID']
        if not re.fullmatch(r'[0-9a-f]{32}', invocation) or invocation == '0'*32:
            raise Incomplete('missing_invocation')
        journal = run(['exec', container, 'journalctl', '--no-pager', '--quiet',
                       '--output=cat', '_SYSTEMD_INVOCATION_ID=' + invocation])
        after = unit('dyoffice-probe.service')
        last = one_json(run(['container', 'inspect', container]))
        # No unit/container restart may join evidence from different attempts.
        if before != after or any(first.get(k) != last.get(k) for k in ('Id', 'Image', 'State', 'RestartCount')):
            raise Incomplete('observation_changed')
        report['invocation_id'] = invocation
        report['journal_sha256'] = hashlib.sha256(journal.encode()).hexdigest()
        if before['Id'] != 'dyoffice-probe.service' or before['LoadState'] != 'loaded':
            raise Incomplete('wrong_probe_unit')
        # A failure is not proof that no submission happened; never auto-retry.
        if before['ActiveState'] == 'failed' and before['Result'] != 'success':
            report.update(outcome='failed', reason='probe_failed_submission_may_have_occurred')
            return report
        if not (before['ActiveState'] == 'active' and before['SubState'] == 'exited'
                and before['Result'] == 'success' and before['ExecMainCode'] == '1'
                and before['ExecMainStatus'] == '0' and before['MainPID'] == '0'):
            raise Incomplete('probe_not_successfully_finished')
        prefix = 'test systemd_driver::container_diagnostic::fixed_sleep_unit_times_out ... '
        lines = [line.removeprefix(prefix) for line in journal.splitlines()]
        markers = [line for line in lines if line.startswith('{')]
        if len(markers) != 1 or json.loads(markers[0]) != MARKER:
            raise Incomplete('missing_or_conflicting_probe_marker')
        if 'test result: ok. 1 passed; 0 failed; 0 ignored;' not in journal:
            raise Incomplete('missing_test_completion')
        sleep = unit('dyoffice-container-probe.service')
        # Confirm no new attempt started while reading the fixed sleep unit.
        if (unit('dyoffice-probe.service') != before
                or one_json(run(['container', 'inspect', container])) != last):
            raise Incomplete('observation_changed')
        if not (sleep['Id'] == 'dyoffice-container-probe.service' and sleep['LoadState'] == 'loaded'
                and sleep['Result'] == 'timeout' and sleep['MainPID'] == '0'
                and sleep['ActiveState'] == 'failed'):
            raise Incomplete('sleep_timeout_not_observed')
        report.update(outcome='fixed_probe_passed', reason='fixed_sleep_timeout_only')
        # ControlGroup is an observation, never proof all descendants were reaped.
        report['control_group_observed'] = bool(sleep['ControlGroup'])
        return report
    except (Incomplete, OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired) as error:
        report['reason'] = str(error) if isinstance(error, Incomplete) else 'invalid_or_unavailable_evidence'
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container-id', required=True)
    parser.add_argument('--image-id', required=True, help='Final local image content ID sha256:..., not a mutable tag')
    parser.add_argument('--source-commit', required=True)
    args = parser.parse_args()
    report = collect(args.container_id, args.image_id, args.source_commit)
    print(json.dumps(report, sort_keys=True))
    return 0 if report['outcome'] == 'fixed_probe_passed' else 2

if __name__ == '__main__':
    raise SystemExit(main())
