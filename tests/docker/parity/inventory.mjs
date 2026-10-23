import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { command, redactHostPaths } from '../image-target.mjs';

async function docker(args) {
	const result = await command(args);
	assert.equal(result.code, 0, redactHostPaths(result.stderr.toString()));
	return result.stdout.toString().trim();
}

const defaultDockerfile = await readFile(new URL('../../../Docker/Dockerfile', import.meta.url), 'utf8');
const rootlessDockerfile = await readFile(new URL('../../../Docker/Dockerfile-Rootless', import.meta.url), 'utf8');
const base = defaultDockerfile.match(/^FROM\s+(\S+)/m)?.[1];
assert.ok(base, 'Default Dockerfile must declare a base image');
assert.equal(rootlessDockerfile.match(/^FROM\s+(\S+)/m)?.[1], base, 'Rootless and default bases must match');
const report = { sourceDockerfile: 'Docker/Dockerfile', images: [] };
const references = [base];
for (const reference of references) {
	const manifest = JSON.parse(await docker(['buildx', 'imagetools', 'inspect', reference, '--raw']));
	const description = await docker(['buildx', 'imagetools', 'inspect', reference]);
	const digest = description.match(/^Digest:\s+(sha256:[a-f0-9]+)$/m)?.[1];
	assert.ok(digest);
	const pinnedReference = `${reference.split('@')[0]}@${digest}`;
	await docker(['pull', pinnedReference]);
	const [metadata] = JSON.parse(await docker(['image', 'inspect', pinnedReference]));
	const inspect = { id: metadata.Id, sizeBytes: metadata.Size, architecture: metadata.Architecture,
		user: metadata.Config.User ?? '', entrypoint: metadata.Config.Entrypoint ?? null,
		command: metadata.Config.Cmd ?? null,
		revision: metadata.Config.Labels?.['org.opencontainers.image.revision'] ?? '' };
	const probe = await docker(['run', '--rm', '--read-only', '--entrypoint', '/bin/sh', pinnedReference, '-c',
		'printf "uid=%s\\ngid=%s\\n" "$(id -u)" "$(id -g)"; for tool in sh bash apt-get dpkg php apache2 cron su; do tool_path=$(command -v "$tool" || true); printf "%s=%s\\n" "$tool" "$tool_path"; done; if [ -f /usr/share/zoneinfo/UTC ]; then printf "utcZoneinfo=yes\\n"; else printf "utcZoneinfo=no\\n"; fi']);
	report.images.push({ reference, pinnedReference, inspect,
		platforms: manifest.manifests.filter(item => item.platform.os === 'linux' && item.platform.architecture !== 'unknown')
			.map(item => ({ ...item.platform, digest: item.digest })), annotations: manifest.annotations, probe });
}
report.references = [];
for (const [image, applicationUser, apache] of [
	['freshrss:scope-parity-debian', 'www-data', 'apache2'],
	['freshrss:scope-parity-alpine', 'apache', 'httpd'],
]) {
	const [metadata] = JSON.parse(await docker(['image', 'inspect', image]));
	const tools = await docker(['run', '--rm', '--entrypoint', '/bin/sh', image, '-c',
		'for tool in sh bash php apache2 httpd cron crond su; do tool_path=$(command -v "$tool" || true); printf "%s=%s\\n" "$tool" "$tool_path"; done']);
	const identity = await docker(['run', '--rm', '--entrypoint', 'id', image, applicationUser]);
	const apacheVersion = await docker(['run', '--rm', '--entrypoint', apache, image, '-v']);
	const php = JSON.parse(await docker(['run', '--rm', '--entrypoint', 'php', image, '-r',
		"require 'constants.php'; echo json_encode(['version'=>PHP_VERSION,'binary'=>PHP_BINARY,'freshRss'=>FRESHRSS_VERSION,'ini'=>php_ini_loaded_file(),'scan'=>php_ini_scanned_files()]);"]));
	report.references.push({ image, id: metadata.Id, tools, applicationUser, identity, apacheVersion, php });
}
report.completed = true;
await writeFile(new URL('../reports/parity-base-inventory.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
