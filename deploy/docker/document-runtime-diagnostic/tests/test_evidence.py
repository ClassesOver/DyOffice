import importlib.util
from pathlib import Path
import unittest
import json

PATH = Path(__file__).parents[1] / 'collect-evidence.py'
spec = importlib.util.spec_from_file_location('evidence', PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
C, I, S = 'a'*64, 'sha256:'+'b'*64, 'c'*40

def unit(name='dyoffice-probe.service'):
    return dict(Id=name, LoadState='loaded', ActiveState='active', SubState='exited',
                Result='success', ExecMainCode='1', ExecMainStatus='0', InvocationID='d'*32,
                MainPID='0', ControlGroup='/system.slice/'+name)

class Fixture:
    def __init__(self):
        self.container = dict(Id=C, Image=I, State=dict(Running=True, StartedAt='fixed'), RestartCount=0)
        self.artifact = dict(Id=I, Config=dict(Labels={'org.opencontainers.image.revision':S}))
        self.probe = unit()
        self.sleep = unit('dyoffice-container-probe.service')
        self.sleep.update(Result='timeout', ActiveState='failed', SubState='failed')
        self.log = json.dumps(m.MARKER)+'\ntest result: ok. 1 passed; 0 failed; 0 ignored; 99 filtered out; finished in 2s\n'
        self.calls = []
        self.change = False
    def run(self, args):
        self.calls.append(args)
        if args[:2] == ['container','inspect']:
            v = dict(self.container)
            if self.change and len(self.calls)>1: v['RestartCount']=1
            return json.dumps([v])
        if args[:2] == ['image','inspect']: return json.dumps([self.artifact])
        if args[2] == 'journalctl': return self.log
        if args[2:4] == ['systemctl','show']:
            v = self.probe if args[4]=='dyoffice-probe.service' else self.sleep
            return '\n'.join(k+'='+v for k,v in v.items())
        raise AssertionError(args)
    def collect(self): return m.collect(C,I,S,self.run)

class Evidence(unittest.TestCase):
    def test_complete_fixed_probe_only(self):
        f=Fixture(); r=f.collect()
        self.assertEqual(r['outcome'],'fixed_probe_passed')
        self.assertIs(r['execution_available'],False)
        self.assertIs(r['isolation_certified'],False)
        self.assertNotIn('journal',r)
        self.assertTrue(all(c[0] in ('container','image','exec') for c in f.calls))
        self.assertTrue(all(c[2] in ('systemctl','journalctl') for c in f.calls if c[0]=='exec'))
    def test_libtest_single_thread_prefix(self):
        f=Fixture(); f.log='running 1 test\ntest systemd_driver::container_diagnostic::fixed_sleep_unit_times_out ... '+f.log
        self.assertEqual(f.collect()['outcome'],'fixed_probe_passed')
    def test_invalid_identity_no_command(self):
        f=Fixture(); r=m.collect('name',I,S,f.run)
        self.assertEqual(r['outcome'],'unknown'); self.assertEqual(f.calls,[])
    def test_identity_mismatches(self):
        for kind in ('container','image','revision'):
            with self.subTest(kind=kind):
                f=Fixture()
                if kind=='container': f.container['Id']='e'*64
                if kind=='image': f.artifact['Id']='sha256:'+'e'*64
                if kind=='revision': f.artifact['Config']['Labels']={}
                self.assertEqual(f.collect()['outcome'],'unknown')
    def test_incomplete_or_duplicate_evidence(self):
        for log in ('', json.dumps(m.MARKER), Fixture().log*2, Fixture().log.replace('1 passed','0 passed')):
            f=Fixture(); f.log=log
            self.assertEqual(f.collect()['outcome'],'unknown')
    def test_forged_enabled_marker_rejected(self):
        f=Fixture(); f.log=f.log.replace('"execution_available": false','"execution_available": true')
        self.assertEqual(f.collect()['outcome'],'unknown')
    def test_missing_unit_field(self):
        f=Fixture(); del f.probe['InvocationID']
        self.assertEqual(f.collect()['outcome'],'unknown')
    def test_live_or_restarted_container_not_pass(self):
        f=Fixture(); f.change=True
        self.assertEqual(f.collect()['reason'],'observation_changed')
        f=Fixture(); f.container['State']['Running']=False
        self.assertEqual(f.collect()['outcome'],'unknown')
    def test_running_probe_unknown(self):
        f=Fixture(); f.probe['SubState']='start'
        self.assertEqual(f.collect()['outcome'],'unknown')
    def test_failure_not_safe_to_retry(self):
        f=Fixture(); f.probe.update(ActiveState='failed',Result='exit-code',ExecMainStatus='101')
        r=f.collect(); self.assertEqual(r['outcome'],'failed')
        self.assertIn('may_have_occurred',r['reason'])
        self.assertFalse(any('dyoffice-container-probe.service' in c for c in f.calls))
    def test_sleep_alive_not_pass(self):
        f=Fixture(); f.sleep['MainPID']='42'
        self.assertEqual(f.collect()['outcome'],'unknown')
    def test_read_failure_sanitized(self):
        def fail(args): raise OSError('secret/password')
        r=m.collect(C,I,S,fail)
        self.assertEqual(r['outcome'],'unknown'); self.assertNotIn('secret',json.dumps(r))
    def test_real_pipe_overflow_and_failed_cli(self):
        import subprocess, sys
        from unittest.mock import patch
        original = subprocess.Popen
        for script, reason in [("print('x'*140000)", 'read_limit'), ("raise SystemExit(3)", 'read_failed')]:
            with patch.object(m.subprocess, 'Popen', side_effect=lambda args, **kw: original([sys.executable, '-c', script], **kw)):
                with self.assertRaisesRegex(m.Incomplete, reason):
                    m.read_command(['unused'])
    def test_build_revision_binding_is_required(self):
        root=PATH.parent
        self.assertIn('org.opencontainers.image.revision', (root/'Dockerfile').read_text())
        self.assertIn('DIAGNOSTIC_SOURCE_COMMIT:?', (root/'compose.yaml').read_text())
    def test_current_invocation_only(self):
        f=Fixture(); f.collect()
        journal=next(c for c in f.calls if 'journalctl' in c)
        self.assertIn('_SYSTEMD_INVOCATION_ID='+'d'*32,journal)

if __name__=='__main__': unittest.main()
