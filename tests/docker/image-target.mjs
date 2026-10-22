import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

const { fetch, AbortSignal } = globalThis;

export async function command(args, { input, timeout = 120_000 } = {}) {
	return await new Promise((resolve, reject) => {
		const child = spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
		const stdout = [];
		const stderr = [];
		const timer = setTimeout(() => child.kill(), timeout);
		child.stdout.on('data', chunk => stdout.push(chunk));
		child.stderr.on('data', chunk => stderr.push(chunk));
		child.stdin.on('error', () => {});
		child.on('error', error => { clearTimeout(timer); reject(error); });
		child.on('close', code => {
			clearTimeout(timer);
			resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
		});
		child.stdin.end(input);
	});
}

async function docker(args) {
	const result = await command(args);
	if (result.code !== 0) {
		throw new Error(`Docker ${args[0]} failed: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString().trim();
}

export async function waitForHttp(url, timeout = 45_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
			await response.arrayBuffer();
			if (response.status < 500) return;
		} catch {}
		await delay(250);
	}
	throw new Error('HTTP service did not become ready within the timeout');
}

// Deployment adapters can provide the same methods without changing assertions.
export function createTarget(options) {
	const prefix = `freshrss-capabilities-${randomUUID().slice(0, 8)}`;
	const network = `${prefix}-network`;
	const fixture = `${prefix}-fixtures`;
	const web = `${prefix}-web`;
	const volumes = [`${prefix}-data`, `${prefix}-extensions`];
	const created = { network: false, fixture: false, web: false, volumes: [], services: [] };
	let hostPort;
	let fixtureUrl;
	let oidcEnabled = false;
	let oidcEnvironment = {};
	let rootlessImage = false;

	async function startWeb() {
		const dataPath = options.dataPath ?? '/var/www/FreshRSS/data';
		const listenPort = options.listenPort ?? (rootlessImage ? 8080 : 80);
		const args = ['create', '--name', web, '--network', network,
			'--network-alias', 'web',
			'--label', `org.freshrss.capabilities=${prefix}`,
			'--publish', `127.0.0.1:${hostPort ?? ''}:${listenPort}`,
			'--mount', `type=volume,source=${volumes[0]},target=${dataPath}`,
			'--mount', `type=volume,source=${volumes[1]},target=/var/www/FreshRSS/extensions`,
			'--env', 'INTERNAL_HOST_ALLOWLIST=fixtures:8080',
			'--env', 'CRON_MIN=', '--env', 'TZ=UTC', '--env', 'FRESHRSS_ENV=production',
			'--env', 'ENABLE_ACCESS_LOG=1'];
		if (rootlessImage) args.push('--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
			'--tmpfs', '/run/freshrss:rw,nosuid,nodev,noexec,size=64m,uid=33,gid=33,mode=0700');
		if (options.cpus) args.push('--cpus', String(options.cpus));
		if (options.memory) args.push('--memory', options.memory);
		for (const mount of options.mounts ?? []) args.push('--mount', mount);
		if (options.dataPath) args.push('--env', `DATA_PATH=${options.dataPath}`);
		for (const [name, value] of Object.entries(options.webEnv ?? {})) {
			args.push('--env', `${name}=${value}`);
		}
		if (oidcEnabled) {
			args.push('--env', 'OIDC_ENABLED=1',
				'--env', 'OIDC_PROVIDER_METADATA_URL=http://fixtures:8080/oidc/.well-known/openid-configuration',
				'--env', 'OIDC_CLIENT_ID=freshrss-capability',
				'--env', 'OIDC_CLIENT_SECRET=freshrss-capability-secret',
				'--env', 'OIDC_CLIENT_CRYPTO_KEY=freshrss-capability-oidc-crypto-key-0123456789abcdef',
				'--env', 'OIDC_REMOTE_USER_CLAIM=preferred_username');
			for (const [name, value] of Object.entries(oidcEnvironment)) {
				args.push('--env', `${name}=${value}`);
			}
		}
		args.push(options.image);
		await docker(args);
		created.web = true;
		const started = Date.now();
		await docker(['start', web]);
		const portResult = await command(['port', web, `${listenPort}/tcp`]);
		if (portResult.code !== 0 || !portResult.stdout.toString().trim()) {
			const logs = await command(['logs', web]);
			throw new Error(`FreshRSS container did not publish ${listenPort}/tcp after startup. Logs:\n${logs.stdout.toString()}${logs.stderr.toString()}`);
		}
		hostPort = portResult.stdout.toString().trim().split(':').at(-1);
		target.baseUrl = `http://127.0.0.1:${hostPort}/`;
		await waitForHttp(target.baseUrl);
		target.startupMs = Date.now() - started;
	}

	const target = {
		baseUrl: '',
		feedUrl: 'http://fixtures:8080',
		fixtureExternalUrl: '',
		async start() {
			const [image] = JSON.parse(await docker(['image', 'inspect', options.image]));
			rootlessImage = image.Config.User === '33:33' && image.Config.Env.includes('FRESHRSS_RUNTIME_DIR=/run/freshrss');
			await docker(['network', 'create', '--label', `org.freshrss.capabilities=${prefix}`, network]);
			created.network = true;
			for (const volume of volumes) {
				await docker(['volume', 'create', '--label', `org.freshrss.capabilities=${prefix}`, volume]);
				created.volumes.push(volume);
			}
			if (rootlessImage) {
				// Explicit operator preparation, separate from nonroot application startup.
				await docker(['run', '--rm', '--user', '0:0', '--entrypoint', '/usr/bin/chown',
					'--mount', `type=volume,source=${volumes[0]},target=/data`, options.image, '33:33', '/data']);
			}
			const fixturesPath = fileURLToPath(new URL('./fixtures', import.meta.url));
			await docker(['create', '--name', fixture, '--network', network,
				'--network-alias', 'fixtures', '--network-alias', 'blocked-fixtures',
				'--label', `org.freshrss.capabilities=${prefix}`,
				'--user', '65532:65532', '--read-only', '--tmpfs', '/tmp:rw,nosuid,noexec,size=4m',
				'--publish', '127.0.0.1::8080',
				'--mount', `type=bind,source=${fixturesPath},target=/fixtures,readonly`,
				'--entrypoint', 'php', options.fixtureImage ?? options.image,
				'-S', '0.0.0.0:8080', '/fixtures/router.php']);
			created.fixture = true;
			await docker(['start', fixture]);
			fixtureUrl = `http://${await docker(['port', fixture, '8080/tcp'])}/`;
			target.fixtureExternalUrl = fixtureUrl;
			await waitForHttp(`${fixtureUrl}health`);
			await startWeb();
		},
		async cli(args, commandOptions = {}) {
			return await command(['exec', '--interactive', ...(rootlessImage ? [] : ['--user', options.cliUser]),
				'--workdir', '/var/www/FreshRSS', web, 'php', ...args], commandOptions);
		},
		async startService({ image, alias, env = {}, readyCommand, timeout = 120_000 }) {
			const name = `${prefix}-${alias}`;
			const args = ['create', '--name', name, '--network', network, '--network-alias', alias,
				'--label', `org.freshrss.capabilities=${prefix}`];
			for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
			args.push(image);
			await docker(args);
			created.services.push(name);
			await docker(['start', name]);
			const deadline = Date.now() + timeout;
			let last = '';
			while (Date.now() < deadline) {
				const result = await command(['exec', name, ...readyCommand]);
				if (result.code === 0) return name;
				last = result.stderr.toString().trim();
				await delay(1000);
			}
			throw new Error(`Service ${alias} did not become ready: ${last}`);
		},
		async advanceFixture() {
			const response = await fetch(`${fixtureUrl}advance`, { method: 'POST', signal: AbortSignal.timeout(5000) });
			if (response.status !== 200) throw new Error('Could not advance feed fixture');
			await response.arrayBuffer();
		},
		async recreate() {
			await docker(['stop', '--time', '10', web]);
			await docker(['rm', web]);
			created.web = false;
			await startWeb();
		},
		async enableOidc(environment = {}) {
			oidcEnabled = true;
			oidcEnvironment = environment;
			await this.recreate();
			await docker(['exec', web, 'php', '-r',
				'$body = @file_get_contents("http://fixtures:8080/oidc/.well-known/openid-configuration"); if (!is_string($body)) { fwrite(STDERR, "OIDC discovery endpoint is unreachable"); exit(1); } echo $body;']);
		},
		async logs() {
			const result = await command(['logs', web]);
			if (result.code !== 0) throw new Error('Could not read application logs');
			return result.stdout.toString() + result.stderr.toString();
		},
		async fixtureLogs() {
			const result = await command(['logs', fixture]);
			if (result.code !== 0) throw new Error('Could not read fixture logs');
			return result.stdout.toString() + result.stderr.toString();
		},
		async diagnostics() {
			const script = rootlessImage ?
				'cat /run/freshrss/crontab; ps -ef; cat /proc/1/status' :
				'crontab -l 2>&1; ps -ef; cat /tmp/FreshRSS.log 2>&1';
			const result = await command(['exec', web, '/bin/sh', '-c', script]);
			return result.stdout.toString() + result.stderr.toString();
		},
		async metadata() {
			const [image] = JSON.parse(await docker(['image', 'inspect', options.image]));
			return { id: image.Id, digests: image.RepoDigests, architecture: image.Architecture,
				os: image.Os, defaultUser: image.Config.User ?? '' };
		},
		async cleanup() {
			// Only remove resources created for this unique test run.
			const errors = [];
			for (const name of created.services) {
				const result = await command(['rm', '--force', '--volumes', name]);
				if (result.code !== 0) errors.push(`service ${name}`);
			}
			for (const [name, exists] of [[web, created.web], [fixture, created.fixture]]) {
				if (exists) {
					const result = await command(['rm', '--force', name]);
					if (result.code !== 0) errors.push(`container ${name}`);
				}
			}
			for (const volume of created.volumes) {
				const result = await command(['volume', 'rm', volume]);
				if (result.code !== 0) errors.push(`volume ${volume}`);
			}
			if (created.network) {
				const result = await command(['network', 'rm', network]);
				if (result.code !== 0) errors.push(`network ${network}`);
			}
			if (errors.length) throw new Error(`Could not clean up ${errors.join(', ')}`);
		},
	};
	return target;
}
