// Parity measurements use disposable installations, never an existing deployment.
import assert from 'node:assert/strict';
import console from 'node:console';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { command, createTarget, redactHostPaths } from '../image-target.mjs';

const { fetch } = globalThis;

async function docker(args) {
	const result = await command(args);
	assert.equal(result.code, 0, redactHostPaths(result.stderr.toString()));
	return result.stdout.toString().trim();
}

const report = {
	sourceRevision: 'b33749fe6c9b0a4fec0ccb210b20202282444bfe',
	sourceArchiveSha256: createHash('sha256').update(await readFile(new URL('../.parity/source.tar', import.meta.url))).digest('hex'),
	method: 'Three sequential cold-container starts per image with warm image caches; 1 CPU and 256 MiB memory limit. Startup includes docker start, port lookup, and installer HTTP readiness. Memory is Docker stats after SQLite setup and fixture refresh. Each refresh uses a separate PHP process and must expose a new fixture article through the authenticated API.',
	images: [],
};

for (const [image, cliUser] of [['freshrss:scope-parity-debian', 'www-data'], ['freshrss:scope-parity-alpine', 'apache']]) {
	const imageInfo = JSON.parse(await docker(['image', 'inspect', image, '--format', '{"id":{{json .Id}},"digests":{{json .RepoDigests}},"sizeBytes":{{.Size}},"platform":{{json .Architecture}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}']));
	assert.equal(imageInfo.revision, report.sourceRevision);
	const measurement = { image, imageInfo, runs: [] };
	report.images.push(measurement);
	for (let repeat = 0; repeat < 3; repeat++) {
		const target = createTarget({ image, cliUser, fixtureImage: 'freshrss:scope-parity-debian', cpus: 1, memory: '256m' });
		try {
			await target.start();
			async function cli(args) {
				const result = await target.cli(args);
				assert.equal(result.code, 0, redactHostPaths(result.stderr.toString()));
				return result.stdout.toString();
			}
			const runtime = JSON.parse(await cli(['-r', "echo json_encode(['php'=>PHP_VERSION,'modules'=>get_loaded_extensions(),'drivers'=>PDO::getAvailableDrivers(),'freshRss'=>null]);"]));
			await cli(['cli/prepare.php']);
			await cli(['cli/do-install.php', '--default-user', 'capscope', '--auth-type', 'form', '--api-enabled', '--db-type', 'sqlite', '--base-url', target.baseUrl, '--language', 'en']);
			const secret = randomBytes(20).toString('hex');
			await cli(['cli/create-user.php', '--user', 'capscope', '--password', secret, '--api-password', secret, '--language', 'en', '--no-default-feeds']);
			await cli(['-r', "require 'cli/_cli.php'; $c=FreshRSS_Context::systemConf(); $l=$c->limits; $l['cache_duration']=0; $l['cache_duration_min']=0; $c->limits=$l; if (!$c->save()) exit(1);"]);
			const login = await fetch(new URL('api/greader.php/accounts/ClientLogin', target.baseUrl), { method: 'POST', body: new URLSearchParams({ Email: 'capscope', Passwd: secret }) });
			assert.equal(login.status, 200);
			const auth = (await login.text()).match(/^Auth=(.+)$/m)?.[1];
			assert.ok(auth);
			const headers = { Authorization: `GoogleLogin auth=${auth}` };
			const subscription = await fetch(new URL('api/greader.php/reader/api/0/subscription/quickadd', target.baseUrl), { method: 'POST', headers, body: new URLSearchParams({ quickadd: `${target.feedUrl}/rss.xml` }) });
			assert.equal(subscription.status, 200);
			assert.equal((await subscription.json()).numResults, 1);
			await target.advanceFixture();
			const refreshStarted = Date.now();
			const refreshOutput = await cli(['cli/actualize-user.php', '--user', 'capscope', '--feed-id', '1']);
			const refreshMs = Date.now() - refreshStarted;
			const entries = await fetch(new URL('api/greader.php/reader/api/0/stream/contents/reading-list?n=100', target.baseUrl), { headers });
			assert.equal(entries.status, 200);
			assert.ok((await entries.json()).items.some(item => item.title === 'RSS revision two'));
			await delay(1000);
			const stats = JSON.parse(await docker(['stats', '--no-stream', '--format', '{{json .}}', target.containerName]));
			measurement.runs.push({ repeat: repeat + 1, startupMs: target.startupMs, refreshMs, refreshOutput: redactHostPaths(refreshOutput.trim()), memoryUsage: stats.MemUsage, memoryPercent: stats.MemPerc, runtime });
			console.log(`${image} run ${repeat + 1}: startup ${target.startupMs} ms, refresh ${refreshMs} ms, memory ${stats.MemUsage}`);
		} finally {
			await target.cleanup();
		}
	}
}
report.completed = true;
report.cleanup = 'passed';
await writeFile(new URL('../reports/parity-baselines.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
