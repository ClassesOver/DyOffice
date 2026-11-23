import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('preflight',Path(__file__).parents[1]/'container-preflight.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_safe_shape_is_not_certification(self):
  r=m.assess({'services':{'web':{'image':'example/web@sha256:'+'a'*64}}})
  self.assertEqual(r['status'],'unsupported');self.assertFalse(r['execution_available'])
 def pinned(self):
  return {'image':'example/web@sha256:'+'a'*64}
 def test_privilege_mutations_reject(self):
  cases=[({'privileged':True},'privileged'),
   *[({k:'host'},'host_namespace') for k in ['pid','ipc','network_mode','cgroup','userns_mode']],
   ({'cap_add':['SYS_ADMIN']},'unreviewed_cap_add'),
   ({'security_opt':['seccomp=unconfined']},'unreviewed_security_options'),
   ({'devices':['/dev/kvm']},'unreviewed_devices'),
   ({'device_cgroup_rules':['a *:* rwm']},'unreviewed_device_cgroup_rules'),
   ({'volumes_from':['other']},'unreviewed_volumes_from'),
   ({'volumes':[{'type':'bind','source':'/var/run/docker.sock','target':'/socket'}]},'bind_or_unknown_mount'),
   ({'volumes':['/run/dbus:/bus:ro']},'bind_or_unknown_mount')]
  self.assertEqual(m.assess({'services':{'x':self.pinned()}})['findings'],[])
  for patch,code in cases:
   with self.subTest(patch=patch):
    r=m.assess({'services':{'x':self.pinned()|patch}})
    self.assertEqual(r['status'],'rejected')
    self.assertEqual(r['findings'],[{'service_index':0,'codes':[code]}])
 def test_named_volume_host_driver_is_rejected(self):
  for volume in [{'driver_opts':{'device':'/','type':'none','o':'bind'}},{'external':True},{'driver':'thirdparty'}]:
   r=m.assess({'services':{'x':self.pinned()},'volumes':{'x':volume}})
   self.assertEqual(r['findings'],[{'service_index':None,'codes':['unreviewed_volume_driver_or_external_volume']}])
 def test_mutable_image_and_build_not_certified(self):
  r=m.assess({'services':{'x':{'image':'ubuntu:24.04'}}})
  self.assertEqual(r['findings'],[{'service_index':0,'codes':['image_not_digest_pinned']}])
  r=m.assess({'services':{'x':self.pinned()|{'build':{'context':'.'}}}})
  self.assertEqual(r['findings'],[{'service_index':0,'codes':['build_provenance_unverified']}])
 def test_bad_shape_rejected(self):
  for x in [None,[],{}, {'services':[]},{'services':{'x':None}}]:self.assertEqual(m.assess(x)['status'],'rejected')
 def test_no_config_values_leak(self):
  import json
  marker='PRIVATE_TOKEN_VALUE'
  r=m.assess({'services':{marker:{'image':marker,'environment':{'SECRET':marker},'volumes':[marker]}}})
  self.assertNotIn(marker,json.dumps(r));self.assertEqual(set(r),{'scope','status','execution_available','isolation_certified','findings','unverified'})
if __name__=='__main__':unittest.main()
