"""Prove separate conventional/rootless engines and scheduler assumptions.

Run as an administrator in a disposable Linux test environment. Select the
rootless daemon account with FRESHRSS_TEST_USER (default: freshrss-test).
Reports omit host paths, account IDs, and daemon-specific metadata.
"""
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

sensitive_paths = []


def run(args, check=True):
    result = subprocess.run(args, text=True, capture_output=True, timeout=120)
    if check and result.returncode:
        raise RuntimeError(f"{args[0]} failed: {redact_host_paths(result.stderr)}")
    return result


def redact_host_paths(value):
    text = str(value)
    paths = [str(Path.home()), tempfile.gettempdir(), os.environ.get('HOME', ''),
             os.environ.get('TMPDIR', ''), str(Path(__file__).resolve().parents[3]), *sensitive_paths]
    for path in filter(None, set(paths)):
        for variant in {path, path.replace('\\', '/'), path.replace('/', '\\')}:
            text = text.replace(variant, '<host-path>')
    text = re.sub(r'([A-Za-z]:\\Users\\)[^\\/\s]+', r'\1<user>', text, flags=re.I)
    text = re.sub(r'(/Users/|/home/)[^/\s]+', r'\1<user>', text)
    text = re.sub(r'(/mnt/[A-Za-z]/Users/)[^/\\\s]+', r'\1<user>', text, flags=re.I)
    return text


source = Path(__file__).resolve().parents[1]
binary = source / '.parity/supercronic-linux-amd64'
digest = hashlib.sha256(binary.read_bytes()).hexdigest()
assert digest == '83dd8013fb3cd793a92c011ab0b79ee1af4736972672036ebe221d97d0b84775'
base = json.loads((source / 'reports/parity-base-inventory.json').read_text())['images'][0]
runtime_id = base['inspect']['id']
runtime_image = base['reference']
alpine = 'alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6'
test_user = os.environ.get('FRESHRSS_TEST_USER', 'freshrss-test')
test_account = pwd.getpwnam(test_user)
if test_account.pw_dir:
    sensitive_paths.append(test_account.pw_dir)
runtime_dir = f'/run/user/{test_account.pw_uid}'
sensitive_paths.append(runtime_dir)
rootless_endpoint = f'unix://{runtime_dir}/docker.sock'
report = {
    'scope': 'Parity environment and scheduler assumption probes',
    'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'baseImage': {'reference': runtime_image, 'pinnedReference': base['pinnedReference'], 'id': runtime_id},
    'scheduler': {'version': 'v0.2.43', 'sha256': digest, 'applicationUid': 33, 'applicationGid': 33, 'timezone': 'UTC'},
    'engines': [],
}

for kind, endpoint in [('rootful', 'unix:///var/run/docker.sock'), ('rootless', rootless_endpoint)]:
    prefix = [] if kind == 'rootful' else ['runuser', '-u', test_user, '--', 'env', f'HOME={test_account.pw_dir}', f'XDG_RUNTIME_DIR={runtime_dir}']

    def docker(args, check=True):
        return run(prefix + ['docker', '--host', endpoint] + args, check=check)

    info = json.loads(docker(['info', '--format', '{{json .}}']).stdout)
    assert ('name=rootless' in info['SecurityOptions']) == (kind == 'rootless')
    entry = {'kind': kind}
    report['engines'].append(entry)
    docker(['load', '--input', str(source / '.parity/base-runtime.tar')])
    assert json.loads(docker(['image', 'inspect', runtime_image]).stdout)[0]['Id'] == runtime_id
    docker(['pull', alpine])
    token = 'freshrss-parity-' + uuid.uuid4().hex[:10]
    network, volume, server, scheduler = [token + '-' + suffix for suffix in ['network', 'data', 'web', 'scheduler']]
    scratch = Path(tempfile.mkdtemp(prefix=token + '-'))
    sensitive_paths.append(str(scratch))
    scratch.chmod(0o755)
    binding = scratch / 'bind'
    binding.mkdir()
    if kind == 'rootless':
        os.chown(binding, test_account.pw_uid, test_account.pw_gid)
    try:
        docker(['network', 'create', network])
        docker(['volume', 'create', volume])
        mounts = ['--mount', f'type=volume,source={volume},target=/data', '--mount', f'type=bind,source={binding},target=/bind']
        # Explicit operator preparation in the engine namespace, separate from startup.
        docker(['run', '--rm', '--user', '0:0'] + mounts + [alpine, 'chown', '33:33', '/data', '/bind'])
        (scratch / 'http.sh').write_text("#!/bin/sh\nprintf 'HTTP/1.1 200 OK\\r\\nConnection: close\\r\\nContent-Length: 8\\r\\n\\r\\n'\ncat /data/marker\n")
        (scratch / 'http.sh').chmod(0o755)
        docker(['run', '--detach', '--name', server, '--network', network, '--network-alias', 'scope-web',
                '--user', '33:33', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=8m,mode=1777', '--publish', '127.0.0.1::8080',
                '--mount', f'type=bind,source={scratch},target=/probe,readonly'] + mounts + [
                    alpine, 'sh', '-c', 'set -eu; id; printf scope-ok >/data/marker; printf bind-ok >/bind/marker; exec nc -lk -p 8080 -e /probe/http.sh'])
        port = docker(['port', server, '8080/tcp']).stdout.strip().rsplit(':', 1)[-1]
        with urllib.request.urlopen('http://127.0.0.1:' + port, timeout=5) as response:
            assert response.read() == b'scope-ok'
        assert docker(['run', '--rm', '--network', network, '--user', '33:33', alpine, 'wget', '-qO-', 'http://scope-web:8080']).stdout == 'scope-ok'
        container_identity = docker(['logs', server]).stdout.strip()
        assert 'uid=33 gid=33' in container_identity
        assert (binding / 'marker').read_text() == 'bind-ok'
        entry['applicationIdentity'] = '33:33'
        entry['bindMountVisibleOnHost'] = True
        docker(['stop', '--time', '5', server])
        docker(['rm', server])
        assert docker(['run', '--rm', '--user', '33:33'] + mounts + [alpine, 'cat', '/data/marker']).stdout == 'scope-ok'
        entry['networkDnsPublishedHttpAndPersistence'] = 'passed'

        runtime_probe = docker(['run', '--rm', '--user', '33:33', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                                '--tmpfs', '/run/freshrss:rw,nosuid,nodev,noexec,size=8m,uid=33,gid=33,mode=0700',
                                '--entrypoint', '/bin/sh', runtime_image, '-c',
                                'set -eu; mkdir /run/freshrss/home /run/freshrss/php; printf ready >/run/freshrss/php/marker; stat -c "%u:%g:%a" /run/freshrss'])
        assert runtime_probe.stdout.strip() == '33:33:700'
        entry['privateRuntimeTmpfsOwnership'] = runtime_probe.stdout.strip()

        shutil.copyfile(binary, scratch / 'supercronic')
        (scratch / 'supercronic').chmod(0o755)
        for expression in ['13,43', '*/20', '*']:
            (scratch / 'crontab').write_text(expression + ' * * * * /bin/sh /probe/job.sh\n')
            docker(['run', '--rm', '--user', '33:33', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                    '--mount', f'type=bind,source={scratch},target=/probe,readonly', '--entrypoint', '/probe/supercronic', runtime_image, '-test', '/probe/crontab'])
        entry['validatedMinuteExpressions'] = ['13,43', '*/20', '*']
        (scratch / 'job.sh').write_text('set -eu\ndate "+%s %z %Z" >/tmp/scheduled-timezone\n'
                                      'printf "%s:%s:%s" "$(id -u)" "$(id -g)" "$CAP_SCOPE_SENTINEL" >/tmp/scheduled-marker\n')
        docker(['run', '--detach', '--name', scheduler, '--user', '33:33', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=8m,mode=1777', '--env', 'CAP_SCOPE_SENTINEL=scope-inherited', '--env', 'TZ=UTC',
                '--mount', f'type=bind,source={scratch},target=/probe,readonly', '--entrypoint', '/probe/supercronic', runtime_image, '/probe/crontab'])
        deadline = time.monotonic() + 75
        while time.monotonic() < deadline:
            marker = docker(['exec', '--user', '33:33', scheduler, 'cat', '/tmp/scheduled-marker'], check=False)
            if marker.returncode == 0:
                assert marker.stdout == '33:33:scope-inherited'
                entry['scheduledJobIdentityAndEnvironment'] = marker.stdout
                break
            time.sleep(1)
        else:
            raise RuntimeError('Nonroot scheduler did not run within 75 seconds')
        epoch, offset, abbreviation = docker(['exec', '--user', '33:33', scheduler, 'cat', '/tmp/scheduled-timezone']).stdout.split()
        local_time = datetime.fromtimestamp(int(epoch), timezone.utc)
        assert f'{offset} {abbreviation}' == local_time.strftime('%z %Z')
        entry['scheduledJobTimezone'] = 'UTC'
        status = docker(['exec', '--user', '33:33', scheduler, 'cat', '/proc/1/status']).stdout
        process = dict(line.split(':', 1) for line in status.splitlines() if ':' in line)
        assert process['Uid'].split() == ['33'] * 4
        assert process['Gid'].split() == ['33'] * 4
        assert int(process['CapEff'].strip(), 16) == 0
        assert process['NoNewPrivs'].strip() == '1'
        entry['schedulerProcess'] = {key: process[key].strip() for key in ['Uid', 'Gid', 'CapEff', 'NoNewPrivs']}
        configuration = json.loads(docker(['inspect', scheduler]).stdout)[0]
        assert configuration['Config']['User'] == '33:33'
        assert configuration['HostConfig']['ReadonlyRootfs'] is True
        entry['schedulerReadOnlyRootFilesystem'] = True
        before_stop = time.monotonic()
        docker(['stop', '--time', '10', scheduler])
        entry['schedulerStopMs'] = round((time.monotonic() - before_stop) * 1000)
        entry['schedulerExitCode'] = json.loads(docker(['inspect', scheduler]).stdout)[0]['State']['ExitCode']
        assert entry['schedulerExitCode'] == 0
        logs = docker(['logs', scheduler]).stderr
        assert 'job succeeded' in logs
        entry['schedulerJobSucceeded'] = True
        entry['schedulerIdentityEnvironmentReadonlyAndSignal'] = 'passed'
        print(kind + ': network, mapped volumes, UID 33 scheduler, inherited environment and graceful stop passed', flush=True)
    except Exception:
        for container in [server, scheduler]:
            logs = docker(['logs', container], check=False)
            print(redact_host_paths(logs.stdout + logs.stderr), file=sys.stderr)
        raise
    finally:
        for container in [server, scheduler]:
            if docker(['inspect', container], check=False).returncode == 0:
                docker(['rm', '--force', container])
        if docker(['volume', 'inspect', volume], check=False).returncode == 0:
            docker(['volume', 'rm', volume])
        if docker(['network', 'inspect', network], check=False).returncode == 0:
            docker(['network', 'rm', network])
        assert scratch.resolve().parent == Path(tempfile.gettempdir()).resolve()
        shutil.rmtree(scratch)

report['completed'] = True
report['cleanup'] = 'passed'
Path(sys.argv[1]).write_text(json.dumps(report, indent=2) + '\n')
