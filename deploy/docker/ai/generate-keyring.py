#!/usr/bin/env python3
import os, secrets, json, base64
from pathlib import Path
os.umask(0o077)
p=Path(__file__).resolve().parents[1]/'secrets'
p.mkdir(mode=0o700, exist_ok=True)
f=p/'config_keyring'
if f.exists():
    raise SystemExit('Existing keyring preserved; do not rotate it implicitly.')
f.write_text(json.dumps({'activeKeyId':'v1','keys':{'v1':base64.b64encode(secrets.token_bytes(32)).decode()}})+'\n')
f.chmod(0o444)
print('Keyring generated. Back it up securely; losing it loses access to encrypted credentials.')
