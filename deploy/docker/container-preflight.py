#!/usr/bin/env python3
"""Offline configuration triage only. Never authorizes Docker/document execution."""
import json
from pathlib import Path
import re
import sys

UNVERIFIED = ['ubuntu_host', 'real_container_namespaces', 'uid_gid_mapping',
 'delegated_cgroup_subtree', 'private_systemd_dbus', 'runtime_image_provenance',
 'broker_worker_integration', 'cleanup_and_resource_limits', 'four_format_save_reopen',
 'browser_authentication']

def assess(config):
 findings=[]
 def add(index, codes):
  if codes: findings.append({'service_index':index,'codes':sorted(set(codes))})
 if not isinstance(config,dict) or not isinstance(config.get('services'),dict) or not config['services']:
  add(None,['invalid_compose_services'])
 else:
  volumes=config.get('volumes',{})
  if not isinstance(volumes,dict):add(None,['invalid_volume_definitions'])
  else:
   for volume in volumes.values():
    if isinstance(volume,dict) and (volume.get('driver_opts') or volume.get('external') or volume.get('driver') not in (None,'local')):
     add(None,['unreviewed_volume_driver_or_external_volume'])
  for index,service in enumerate(config['services'].values()):
   if not isinstance(service,dict):
    add(index,['invalid_service']);continue
   codes=[]
   for key in ['pid','ipc','network_mode','cgroup','userns_mode']:
    if service.get(key)=='host':codes.append('host_namespace')
   if service.get('privileged'):codes.append('privileged')
   for key in ['cap_add','devices','device_cgroup_rules','volumes_from']:
    if service.get(key):codes.append('unreviewed_'+key)
   opts=service.get('security_opt',[])
   if not isinstance(opts,list) or any(not isinstance(x,str) or 'unconfined' in x or x not in ['no-new-privileges:true','no-new-privileges=true'] for x in opts):
    codes.append('unreviewed_security_options')
   mounts=service.get('volumes',[])
   if not isinstance(mounts,list):codes.append('invalid_mounts')
   else:
    for mount in mounts:
     # Normalized Compose JSON uses long syntax. Short/unknown mounts require review.
     if not isinstance(mount,dict) or mount.get('type') not in ('volume','tmpfs'):
      codes.append('bind_or_unknown_mount')
   image=service.get('image')
   if not isinstance(image,str) or not re.fullmatch(r'[^\s@]+@sha256:[a-f0-9]{64}',image):
    codes.append('image_not_digest_pinned')
   if service.get('build'):codes.append('build_provenance_unverified')
   add(index,codes)
 return {'scope':'offline-compose-config-triage','status':'rejected' if findings else 'unsupported',
  'execution_available':False,'isolation_certified':False,'findings':findings,'unverified':UNVERIFIED}

def main(args):
 try:
  if len(args)!=1:raise ValueError()
  with Path(args[0]).open('rb') as f: data=f.read(1024*1024+1)
  if len(data)>1024*1024:raise ValueError()
  result=assess(json.loads(data))
 except (OSError,ValueError,UnicodeError,RecursionError):
  result=assess(None)
 print(json.dumps(result,sort_keys=True))
 return 2
if __name__=='__main__':sys.exit(main(sys.argv[1:]))
