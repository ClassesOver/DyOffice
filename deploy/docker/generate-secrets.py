#!/usr/bin/env python3
from pathlib import Path
import secrets, uuid, os
os.umask(0o077)
p = Path(__file__).resolve().parent
(p / 'secrets').mkdir(mode=0o700, exist_ok=True)
for name in ('postgres_password', 'owner_password', 'auth_password', 'business_password', 'csrf_key'):
    target = p / 'secrets' / name
    if not target.exists():
        target.write_text(secrets.token_hex(32) + '\n')
        # Local Compose bind-mounted secrets retain host permissions. Container node
        # needs read access; parent directory 0700 prevents host traversal.
        target.chmod(0o444)
f = p / '.env'
if not f.exists():
    f.write_text((p / '.env.example').read_text().replace('DYOFFICE_DEPLOYMENT_ID=\n', 'DYOFFICE_DEPLOYMENT_ID=' + str(uuid.uuid4()) + '\n'))
print('Created missing secrets and .env only. Existing values preserved. Fill your mirrored image addresses. HTTP is fixed to localhost:3080.')
