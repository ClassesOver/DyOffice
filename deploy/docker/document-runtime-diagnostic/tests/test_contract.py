import importlib.util,json,pathlib,unittest,yaml,subprocess
ROOT=pathlib.Path(__file__).parents[1]
spec=importlib.util.spec_from_file_location('select_binary',ROOT/'select-test-binary.py')
select_binary=importlib.util.module_from_spec(spec);spec.loader.exec_module(select_binary)
class DiagnosticContracts(unittest.TestCase):
    def service(self):
        data=yaml.safe_load((ROOT/'compose.yaml').read_text())
        self.assertEqual(set(data['services']),{'document-runtime-diagnostic'})
        return data['services']['document-runtime-diagnostic']
    def test_explicit_private_no_document_no_host_authority_profile(self):
        s=self.service()
        self.assertEqual(s['profiles'],['document-runtime-diagnostic'])
        self.assertEqual(s['entrypoint'],['/sbin/init'])
        self.assertEqual(s['command'],['--unit=dyoffice-diagnostic.target'])
        self.assertEqual(s['network_mode'],'none');self.assertEqual(s['cgroup'],'private')
        self.assertTrue(s['read_only']);self.assertEqual(s['restart'],'no')
        self.assertEqual(s['security_opt'],['no-new-privileges:true'])
        for key in ['privileged','volumes','ports','cap_add','pid','userns_mode','devices','init','healthcheck']:
            self.assertNotIn(key,s,key)
        self.assertTrue(all(v.startswith(('/run:','/tmp:')) for v in s['tmpfs']))
    def test_build_is_offline_locked_after_reviewed_inputs_and_uses_ubuntu_mirror(self):
        s=(ROOT/'Dockerfile').read_text()
        self.assertIn('--network=none',s);self.assertIn('--offline --locked',s)
        self.assertIn('RUSTUP_TOOLCHAIN=1.93.0',s)
        self.assertIn('https://repo.huaweicloud.com/ubuntu/',s)
        self.assertNotIn('rustup install',s)
        self.assertNotIn('COPY . ',s)
        self.assertIn('libssl3t64',s)
        apt=(ROOT/'configure-apt.sh').read_text()
        self.assertIn('@sha256:[a-f0-9]{64}',(ROOT/'validate-inputs.sh').read_text())
        self.assertIn('sh /opt/validate-inputs.sh',apt)
        self.assertIn('"$VERSION_ID" = 24.04',apt)
        self.assertIn('ubuntu-archive-keyring.gpg',apt)
        self.assertNotIn('trusted=yes',apt)
    def test_only_exact_fixed_probe_and_empty_external_environment(self):
        s=(ROOT/'run-probe.sh').read_text()
        self.assertIn('[ "$#" -eq 0 ]',s)
        self.assertIn('exec env -i ',s)
        self.assertIn('sha256sum -c probe.sha256',s)
        self.assertIn(select_binary.FILTER+' --exact --ignored --nocapture',s)
        self.assertNotIn('DBUS_SYSTEM_BUS_ADDRESS',s)
        unit=(ROOT/'dyoffice-probe.service').read_text()
        self.assertIn('Requires=dbus.service',unit);self.assertIn('TimeoutStartSec=40',unit)
        self.assertIn('Restart=no',unit);self.assertNotIn('ExecStartPost',unit)
    def artifact(self,**extra):
        return dict(reason='compiler-artifact',target={'name':'dyoffice_document_broker','kind':['lib']},profile={'test':True},executable='/build/services/document-broker/target/debug/deps/probe',**extra)
    def test_apt_validator_rejects_entire_multiline_values_before_mutation(self):
        image='swr.example.invalid/team/ubuntu@sha256:'+'a'*64
        mirror='https://repo.huaweicloud.com/ubuntu/'
        def run(i,m):
            return subprocess.run(['sh',str(ROOT/'validate-inputs.sh'),i,m],capture_output=True).returncode
        self.assertEqual(run(image,mirror),0)
        self.assertEqual(run(image,'https://mirror.example:443/ubuntu/'),0)
        for bad in [
            mirror+'\nTrusted: yes',mirror+'\r\nTrusted: yes',
            mirror+'\nURIs: https://attacker.example/ubuntu/',
            mirror+'\nhttps://attacker.example/ubuntu/',
            'https://attacker.example/\n'+mirror,
            mirror+'\n', '\n'+mirror, mirror+'\r',
            mirror+'\nSigned-By: /tmp/attacker.gpg',
            mirror+'\n\nTypes: deb\nTrusted: yes',
            mirror+' https://attacker.example/',mirror+'\t',
            'http://repo.huaweicloud.com/ubuntu/',
            'https://user:password@mirror.example/ubuntu/',
            mirror+'?x=1',mirror+'#fragment',
            mirror+';touch /tmp/injected',mirror+'$(id)',
        ]:
            self.assertEqual(run(image,bad),78,repr(bad))
        for bad_image in [image+'\nanything',image+'\r', 'anything\n'+image, 'ubuntu:24.04']:
            self.assertEqual(run(bad_image,mirror),78,repr(bad_image))
        script=(ROOT/'configure-apt.sh').read_text()
        self.assertLess(script.index('sh /opt/validate-inputs.sh'),script.index('. /etc/os-release'))
        self.assertLess(script.index('sh /opt/validate-inputs.sh'),script.index('rm -f'))
    def test_exact_cargo_artifact_selection(self):
        item=self.artifact();self.assertEqual(str(select_binary.select([json.dumps(item)])),item['executable'])
        for records in [[],[item,item],[dict(item,target={'name':'other','kind':['lib']})],[dict(item,profile={'test':False})],[dict(item,target={'name':'dyoffice_document_broker','kind':['bin']})]]:
            with self.assertRaises(ValueError):select_binary.select([json.dumps(x) for x in records])
        with self.assertRaises(ValueError):select_binary.select(['not-json'])
    def test_no_fake_markers_or_admission_success(self):
        code='\n'.join((ROOT/n).read_text() for n in ['Dockerfile','run-probe.sh','compose.yaml'])
        for forbidden in ['touch /.dockerenv','/var/run/docker.sock','/run/dbus:/run/dbus','/sys/fs/cgroup:/sys/fs/cgroup','seccomp=unconfined','apparmor=unconfined','--privileged','execution_available=true']:
            self.assertNotIn(forbidden,code)
    def test_template_not_ignored_by_local_rule(self):
        self.assertIn('!.env.example',(ROOT/'.gitignore').read_text())
        self.assertTrue((ROOT/'.env.example').is_file())
if __name__=='__main__':unittest.main()
