import importlib.util
from pathlib import Path
import unittest
SPEC = importlib.util.spec_from_file_location('audit', Path(__file__).parents[1] / 'audit-ubuntu-docker.py')
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)

class AuditTests(unittest.TestCase):
    def good(self):
        return {'ubuntu':'24.04', 'pid1':'systemd', 'cgroupFs':'cgroup2fs',
                'controllers':['cpu','memory','pids'], 'docker':{'serverVersion':'28.0.4','cgroupVersion':'2','cgroupDriver':'systemd','securityOptions':['name=rootless','name=seccomp,profile=builtin']}, 'daemonDelegate':'yes'}
    def test_even_complete_host_facts_never_certify_nested_runtime(self):
        r=audit.assess(self.good())
        self.assertEqual(r['status'],'unsupported')
        self.assertFalse(r['execution_available'])
        self.assertFalse(r['container_probe_run'])
        self.assertEqual(r['unverified'],['container_cgroup_delegation','container_uid_gid_mapping','nested_systemd_unit','runtime_isolation'])
    def test_missing_each_prerequisite_is_explicit(self):
        for key in self.good():
            f=self.good(); del f[key]
            self.assertTrue(audit.assess(f)['missing'],key)
    def test_rootful_unmapped_and_missing_controllers_reject(self):
        f=self.good();f['docker']['securityOptions']=['name=seccomp,profile=builtin'];f['controllers']=['memory']
        self.assertIn('docker_user_namespace',audit.assess(f)['missing'])
        self.assertIn('cpu_memory_pids',audit.assess(f)['missing'])
    def test_wrong_or_malformed_docker_facts_reject(self):
        for value in [None,[],{},'not-json',{'cgroupVersion':'1','cgroupDriver':'cgroupfs','securityOptions':None}]:
            f=self.good();f['docker']=value
            self.assertIn('docker_server',audit.assess(f)['missing'])


class CollectorTests(unittest.TestCase):
    def assert_artifact_whitelist(self, report):
        self.assertEqual(set(report), {'scope','status','host_prerequisites_observed',
            'checks','missing','unverified','container_probe_run','execution_available',
            'unavailable_observations','observed_controllers'})
        expected = set(audit.assess({})['checks'])
        self.assertEqual(set(report['checks']), expected)
        self.assertTrue(all(type(v) is bool for v in report['checks'].values()))
        self.assertTrue(set(report['missing']) <= expected)
        self.assertTrue(set(report['unavailable_observations']) <=
                        {'ubuntu','pid1','controllers','cgroupFs','daemonDelegate','docker'})
        self.assertTrue(set(report['observed_controllers']) <= {'cpu','memory','pids','io','cpuset'})
        self.assertEqual(report['unverified'], audit.assess({})['unverified'])
        self.assertFalse(report['execution_available'])
        self.assertFalse(report['container_probe_run'])
        self.assertEqual(report['status'], 'unsupported')

    def test_malicious_daemon_json_cannot_add_artifact_fields(self):
        import json, stat
        from types import SimpleNamespace
        from unittest.mock import patch
        marker = 'DO_NOT_PUBLISH_PRIVATE_VALUE'
        payload = {'serverVersion':marker, 'cgroupVersion':{'secret':marker},
                   'cgroupDriver':[marker], 'securityOptions':[marker, {'secret':marker},
                   'name=rootless','name=seccomp,profile=builtin'],
                   'execution_available':True, 'status':'passed', 'secret':marker}
        reads = {'/etc/os-release':'ID=ubuntu\nVERSION_ID="24.04"\n',
                 '/proc/1/comm':'systemd\n',
                 '/sys/fs/cgroup/cgroup.controllers':'cpu memory pids '+marker}
        def cmd(argv):
            if argv == audit.COMMANDS['docker']: return json.dumps(payload)
            return 'yes' if argv == audit.COMMANDS['daemonDelegate'] else 'cgroup2fs'
        with patch.object(audit,'bounded_read',side_effect=lambda p: reads[p]), \
             patch.object(audit,'command',side_effect=cmd), \
             patch.object(audit.os,'lstat',return_value=SimpleNamespace(st_mode=stat.S_IFSOCK)):
            report = audit.collect()
        self.assert_artifact_whitelist(report)
        self.assertNotIn(marker, json.dumps(report))
        self.assertFalse(report['host_prerequisites_observed'])
        self.assertFalse(report['checks']['docker_server'])

    def test_read_and_command_failures_do_not_leak_error_content(self):
        import json
        from unittest.mock import patch
        marker = 'DO_NOT_PUBLISH_PRIVATE_PATH_OR_CREDENTIAL'
        with patch.object(audit,'bounded_read',side_effect=PermissionError(marker)), \
             patch.object(audit,'command',side_effect=OSError(marker)), \
             patch.object(audit.os,'lstat',side_effect=PermissionError(marker)):
            report = audit.collect()
        self.assert_artifact_whitelist(report)
        self.assertNotIn(marker, json.dumps(report))
        self.assertEqual(set(report['unavailable_observations']),
                         {'ubuntu','pid1','controllers','cgroupFs','daemonDelegate','docker'})
        self.assertTrue(all(not ok for ok in report['checks'].values()))

    def test_command_bounds_output_and_time(self):
        import sys
        with self.assertRaises(ValueError):
            audit.command([sys.executable,'-c','print("x"*100)'],limit=16)
        with self.assertRaises(TimeoutError):
            audit.command([sys.executable,'-c','import time; time.sleep(2)'],timeout=0.02)
        self.assertEqual(audit.command([sys.executable,'-c','print("ok")']),'ok')
    def test_subprocess_does_not_inherit_docker_override_or_secret(self):
        import os,sys
        from unittest.mock import patch
        with patch.dict(os.environ, {'DOCKER_HOST':'tcp://example.invalid:2375','AUDIT_SECRET':'should-not-leak'}):
            text=audit.command([sys.executable,'-c','import os; print(os.getenv("DOCKER_HOST"),os.getenv("AUDIT_SECRET"))'])
        self.assertEqual(text,'None None')
    def test_only_fixed_read_commands_exist(self):
        self.assertEqual(set(audit.COMMANDS),{'docker','daemonDelegate','cgroupFs'})
        self.assertEqual(audit.COMMANDS['docker'][:5],['docker','--host','unix:///var/run/docker.sock','info','--format'])
        for argv in audit.COMMANDS.values():
            self.assertFalse(set(argv)&{'sudo','run','create','start','restart','mount','unshare','pull','build'})
    def test_workflow_is_manual_pinned_and_never_masks_unsupported(self):
        import re
        text=(Path(__file__).parents[3]/'.github/workflows/dyoffice-ubuntu-docker-audit.yml').read_text()
        self.assertIn('workflow_dispatch:',text)
        self.assertIn('runs-on: ubuntu-24.04',text)
        self.assertIn('persist-credentials: false',text)
        self.assertIn("github.ref == 'refs/heads/feat/dyoffice-web'",text)
        self.assertEqual(len(re.findall(r'uses: [\w/-]+@[a-f0-9]{40}\b',text)),2)
        for forbidden in ['pull_request:', 'secrets.', 'continue-on-error', '--privileged','security-opt','sudo ', 'docker run', 'docker pull', 'DOCKER_HOST']:
            self.assertNotIn(forbidden,text)
    def test_cli_returns_unsupported_and_never_success(self):
        import tempfile,json
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'report.json'
            with patch.object(audit,'collect',return_value=audit.assess(AuditTests().good())):
                self.assertEqual(audit.main([str(path)]),2)
            self.assertFalse(json.loads(path.read_text())['execution_available'])

if __name__=='__main__': unittest.main()
