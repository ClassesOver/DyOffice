"""Exercise the real bootstrap CLI through a POSIX terminal, without echoing secrets."""
import os
import pty
import secrets
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
password = ('terminal lanterns over distant rivers ' + secrets.token_hex(8)).encode()
child = subprocess.Popen(
    [sys.argv[2], '--experimental-strip-types', sys.argv[1]],
    stdin=slave, stdout=slave, stderr=slave,
)
os.close(slave)
transcript = b''
prompts = [
    (b'Administrator username: ', b'Cli.Owner\r'),
    (b'Password (hidden, at least 15 characters): ', password + b'\r'),
    (b'Confirm password (hidden): ', password + b'\r'),
]
sent = 0
deadline = time.monotonic() + 8
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            transcript += chunk
            if sent < len(prompts) and prompts[sent][0] in transcript:
                os.write(master, prompts[sent][1])
                sent += 1
        # Drain the terminal through EOF even if the exit status is ready.
    if child.poll() is None:
        try:
            child.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise RuntimeError('Interactive bootstrap timed out after prompt ' + str(sent))
    if child.returncode != 0 or b'Administrator created.' not in transcript:
        raise RuntimeError('Interactive bootstrap failed')
    if password in transcript:
        raise RuntimeError('Interactive bootstrap echoed the password')
    print('Interactive bootstrap completed without echoing the password')
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
