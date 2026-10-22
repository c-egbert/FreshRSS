import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import console from 'node:console';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const { fetch, AbortSignal } = globalThis;

const { values } = parseArgs({ options: {
	image: { type: 'string', default: 'freshrss/freshrss:poc' },
	'fixture-image': { type: 'string' },
	'cli-user': { type: 'string', default: 'www-data' },
	adapter: { type: 'string' },
	report: { type: 'string' },
	baseline: { type: 'string' },
	help: { type: 'boolean', default: false },
} });

if (values.help) {
	console.log('Usage: node tests/docker/capabilities.mjs [--image IMAGE] [--cli-user USER]');
	console.log('       [--fixture-image IMAGE] [--adapter FILE.mjs] [--report FILE.json] [--baseline FILE.json]');
	process.exit(0);
}

const adapter = values.adapter ? pathToFileURL(resolve(values.adapter)) : new URL('./image-target.mjs', import.meta.url);
const { createTarget } = await import(adapter.href);

function hiddenFields(html) {
	const fields = {};
	for (const [tag] of html.matchAll(/<input\b[^>]*>/gi)) {
		const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
		if (attributes.type === 'hidden' && attributes.name) {
			fields[attributes.name] = (attributes.value ?? '').replaceAll('&amp;', '&').replaceAll('&quot;', '"');
		}
	}
	return fields;
}

function browserGet(url, headers = {}) {
	return new Promise((resolve, reject) => {
		const request = httpRequest(url, { method: 'GET', headers }, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve({
				status: response.statusCode,
				headers: response.headers,
				text: Buffer.concat(chunks).toString(),
			}));
		});
		request.setTimeout(10_000, () => request.destroy(new Error('Browser-style HTTP request timed out')));
		request.on('error', reject);
		request.end();
	});
}

async function loadBcrypt() {
	const sandbox = { exports: {}, module: { exports: {} }, require: createRequire(import.meta.url), setTimeout, clearTimeout };
	runInNewContext(await readFile(new URL('../../p/scripts/vendor/bcrypt.js', import.meta.url), 'utf8'), sandbox, { timeout: 2000 });
	return sandbox.module.exports;
}

test('FreshRSS container capability contract', { timeout: 900_000 }, async t => {
	const target = createTarget({ image: values.image, fixtureImage: values['fixture-image'], cliUser: values['cli-user'] });
	const password = `Cap-${randomBytes(16).toString('hex')}`;
	const apiPassword = `Api-${randomBytes(16).toString('hex')}`;
	const admin = 'capadmin';
	const reader = 'capreader';
	const report = { suiteVersion: 13, image: values.adapter ? undefined : values.image,
		adapter: values.adapter ?? 'image-target.mjs', completed: false, tests: [] };
	let auth;
	let readerAuth;
	let entryId;
	let rssFeedId;
	const passed = new Set();

	t.after(async () => {
		try {
			await target.cleanup();
			report.cleanup = 'passed';
		} catch (error) {
			report.cleanup = 'failed';
			throw error;
		} finally {
			report.success = report.completed && report.tests.every(result => result.status === 'passed') &&
				report.cleanup === 'passed' && report.comparison?.status !== 'failed';
			if (values.report) {
				await mkdir(dirname(resolve(values.report)), { recursive: true });
				await writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
			}
		}
	});

	async function check(name, fn, dependencies = []) {
		const missing = dependencies.filter(dependency => !passed.has(dependency));
		if (missing.length) {
			report.tests.push({ name, status: 'skipped', reason: 'Prerequisite failed' });
			await t.test(name, { skip: 'Prerequisite failed' }, () => {});
			return false;
		}
		let success = false;
		await t.test(name, async () => {
			const started = Date.now();
			try {
				await fn();
				passed.add(name);
				success = true;
				report.tests.push({ name, status: 'passed', durationMs: Date.now() - started });
			} catch (error) {
				report.tests.push({ name, status: 'failed', durationMs: Date.now() - started });
				throw error;
			}
		});
		return success;
	}

	async function cli(args, { code = 0, input } = {}) {
		const result = await target.cli(args, { input });
		assert.equal(result.code, code, `CLI ${args[0]} exit status: ${result.stderr.toString()}`);
		return result.stdout;
	}

	async function request(path, { method = 'GET', headers = {}, data, jar, redirect = true } = {}) {
		let url = new URL(path.replace(/^\//, ''), target.baseUrl);
		let body = data;
		for (let hop = 0; hop < 8; hop++) {
			const requestHeaders = { ...headers };
			if (jar?.size) requestHeaders.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
			const response = await fetch(url, { method, headers: requestHeaders, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
			const bytes = Buffer.from(await response.arrayBuffer());
			for (const cookie of response.headers.getSetCookie()) {
				const [pair] = cookie.split(';');
				const index = pair.indexOf('=');
				if (jar) jar.set(pair.slice(0, index), pair.slice(index + 1));
			}
			if (redirect && [301, 302, 303, 307, 308].includes(response.status) && response.headers.has('location')) {
				url = new URL(response.headers.get('location'), url);
				assert.equal(url.origin, new URL(target.baseUrl).origin, 'Redirect left the test deployment');
				if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) {
					method = 'GET';
					body = undefined;
				}
				continue;
			}
			return { status: response.status, headers: response.headers, body: bytes, text: bytes.toString(), json: () => JSON.parse(bytes.toString()) };
		}
		throw new Error('Too many HTTP redirects');
	}

	async function apiLogin(user, secret = apiPassword) {
		const response = await request('api/greader.php/accounts/ClientLogin', {
			method: 'POST', data: new URLSearchParams({ Email: user, Passwd: secret }),
		});
		assert.equal(response.status, 200, 'Google Reader login failed');
		const token = response.text.match(/^Auth=(.+)$/m)?.[1];
		assert.ok(token, 'Google Reader Auth response missing');
		return token;
	}

	async function api(path, { userAuth = auth, data, method = data ? 'POST' : 'GET', ...rest } = {}) {
		return await request(`api/greader.php/reader/api/0/${path}`, {
			method, headers: { Authorization: `GoogleLogin auth=${userAuth}` }, data, ...rest,
		});
	}

	async function items(userAuth = auth) {
		const response = await api('stream/contents/reading-list?n=100', { userAuth });
		assert.equal(response.status, 200);
		return response.json().items;
	}

	async function subscriptions(userAuth = auth) {
		const response = await api('subscription/list?output=json', { userAuth });
		assert.equal(response.status, 200);
		return response.json().subscriptions;
	}

	await target.start();
	report.target = await target.metadata();

	await check('unconfigured image serves the installer', async () => {
		const response = await request('i/');
		assert.equal(response.status, 200);
		assert.match(response.text, /Installation.*FreshRSS|FreshRSS.*[Ii]nstall/);
	});

	await check('CLI extensions, database drivers, and container PHP defaults', async () => {
		const probe = `require 'constants.php'; require LIB_PATH . '/lib_rss.php'; $config = require 'config.default.php'; echo json_encode([
			'php' => PHP_VERSION, 'extensions' => get_loaded_extensions(), 'drivers' => PDO::getAvailableDrivers(),
			'timezone' => ini_get('date.timezone'), 'upload' => ini_get('upload_max_filesize'),
			'post' => ini_get('post_max_size'), 'disableUpdate' => $config['disable_update'],
			'environment' => getenv('FRESHRSS_ENV'), 'copyLogToSyslog' => COPY_LOG_TO_SYSLOG,
			'copySyslogToStderr' => COPY_SYSLOG_TO_STDERR]);`;
		const runtime = JSON.parse((await cli(['-r', probe])).toString());
		report.runtime = runtime;
		const modules = runtime.extensions.map(name => name.toLowerCase());
		for (const module of ['ctype', 'curl', 'dom', 'fileinfo', 'gmp', 'iconv', 'intl', 'json', 'libxml', 'mbstring',
			'openssl', 'pcre', 'pdo', 'session', 'simplexml', 'xml', 'xmlreader', 'xmlwriter', 'zend opcache', 'zip', 'zlib']) {
			assert.ok(modules.includes(module), `Missing PHP extension: ${module}`);
		}
		for (const driver of ['sqlite', 'mysql', 'pgsql']) assert.ok(runtime.drivers.includes(driver), `Missing PDO ${driver}`);
		assert.equal(runtime.timezone, 'UTC');
		assert.equal(runtime.upload, '32M');
		assert.equal(runtime.post, '32M');
		assert.equal(runtime.disableUpdate, true);
		assert.equal(runtime.environment, 'production');
		assert.equal(runtime.copyLogToSyslog, true);
		assert.equal(runtime.copySyslogToStderr, true);
	});

	await check('read-only custom configuration mounts apply during automatic install and user creation', async () => {
		const configDataPath = '/var/lib/freshrss-operator-config';
		const customTarget = createTarget({
			image: values.image,
			fixtureImage: values['fixture-image'],
			cliUser: values['cli-user'],
			dataPath: configDataPath,
			mounts: [
				`type=bind,source=${fileURLToPath(new URL('./operator-config/constants.local.php', import.meta.url))},target=/var/www/FreshRSS/constants.local.php,readonly`,
				`type=bind,source=${fileURLToPath(new URL('./operator-config/config.custom.php', import.meta.url))},target=${configDataPath}/config.custom.php,readonly`,
				`type=bind,source=${fileURLToPath(new URL('./operator-config/config-user.custom.php', import.meta.url))},target=${configDataPath}/config-user.custom.php,readonly`,
			],
			webEnv: {
				TZ: 'Europe/Paris',
				FRESHRSS_ENV: 'development',
				COPY_LOG_TO_SYSLOG: 'Off',
				COPY_SYSLOG_TO_STDERR: 'Off',
				FRESHRSS_INSTALL: '--default-user capcustom --auth-type form --db-type sqlite --language en',
				FRESHRSS_USER: `--user capcustom --password ${password} --api-password ${apiPassword} --language en --no-default-feeds --purge-after-months 0`,
			},
		});
		try {
			await customTarget.start();
			const inspect = async () => JSON.parse((await customTarget.cli(['-r', "require 'cli/_cli.php'; FreshRSS_Context::initUser('capcustom'); echo json_encode([" +
				"'title' => FreshRSS_Context::systemConf()->title, " +
				"'allow_anonymous' => FreshRSS_Context::systemConf()->allow_anonymous, " +
				"'language' => FreshRSS_Context::userConf()->language, " +
				"'timezone' => FreshRSS_Context::userConf()->timezone, " +
				"'posts_per_page' => FreshRSS_Context::userConf()->posts_per_page, " +
				"'php_timezone' => ini_get('date.timezone'), " +
				"'constants_local' => FRESHRSS_OPERATOR_LOCAL_CONFIG, " +
				"'environment' => getenv('FRESHRSS_ENV'), " +
				"'copy_log_to_syslog' => COPY_LOG_TO_SYSLOG, " +
				"'copy_syslog_to_stderr' => COPY_SYSLOG_TO_STDERR]);"])).stdout.toString());
			const actual = await inspect();
			assert.deepEqual(actual, {
				title: 'Operator custom instance title', allow_anonymous: true,
				language: 'en', timezone: 'Europe/Paris', posts_per_page: 17,
				php_timezone: 'Europe/Paris', constants_local: 'mounted constants.local.php', environment: 'development',
				copy_log_to_syslog: false, copy_syslog_to_stderr: false,
			});
			await customTarget.cli(['-r', "require 'cli/_cli.php'; Minz_Log::record('operator-debug-env-marker', LOG_DEBUG, DATA_PATH . '/users/_/log.txt');"]);
			const debugLog = (await customTarget.cli(['-r', "require 'constants.php'; echo file_get_contents(DATA_PATH . '/users/_/log.txt');"])).stdout.toString();
			assert.match(debugLog, /operator-debug-env-marker/, 'FRESHRSS_ENV=development did not enable debug logging');
			await customTarget.recreate();
			assert.deepEqual(await inspect(), actual, 'Custom configuration did not persist across container recreation');
		} finally {
			await customTarget.cleanup();
		}
	});

	await check('Apache listener, trusted proxy, and access-log environment settings are honored', async () => {
		const proxyTarget = createTarget({
			image: values.image,
			fixtureImage: values['fixture-image'],
			cliUser: values['cli-user'],
			listenPort: 8080,
			webEnv: { LISTEN: '0.0.0.0:8080', TRUSTED_PROXY: '172.16.0.0/12' },
		});
		try {
			await proxyTarget.start();
			const response = await fetch(proxyTarget.baseUrl, { headers: {
				'X-Forwarded-For': '198.51.100.25',
				'User-Agent': 'operator-proxy-sentinel',
			}, redirect: 'manual' });
			assert.ok([200, 301, 302].includes(response.status), 'Apache did not listen on the configured internal port');
			await response.arrayBuffer();
			await delay(100);
			const proxyLogs = await proxyTarget.logs();
			assert.match(proxyLogs, /operator-proxy-sentinel/, 'The access log did not record the request');
			assert.match(proxyLogs, /198\.51\.100\.25/, 'TRUSTED_PROXY did not select X-Forwarded-For for the client address');
		} finally {
			await proxyTarget.cleanup();
		}

		const noAccessLogTarget = createTarget({
			image: values.image,
			fixtureImage: values['fixture-image'],
			cliUser: values['cli-user'],
			webEnv: { ENABLE_ACCESS_LOG: '0' },
		});
		try {
			await noAccessLogTarget.start();
			const response = await fetch(noAccessLogTarget.baseUrl, { headers: { 'User-Agent': 'operator-access-log-disabled-sentinel' } });
			assert.equal(response.status, 200);
			await response.arrayBuffer();
			await delay(100);
			assert.doesNotMatch(await noAccessLogTarget.logs(), /operator-access-log-disabled-sentinel/,
				'ENABLE_ACCESS_LOG=0 left the Apache access log enabled');
		} finally {
			await noAccessLogTarget.cleanup();
		}
	});

	const installed = await check('CLI installation and user creation are repeatable', async () => {
		const installArgs = ['cli/do-install.php', '--default-user', admin, '--auth-type', 'form', '--api-enabled',
			'--db-type', 'sqlite', '--base-url', target.baseUrl, '--language', 'en'];
		await cli(['cli/prepare.php']);
		await cli(installArgs);
		await cli(installArgs, { code: 3 });
		// Keep a fixture revision observable immediately instead of waiting for the default cache minimum.
		await cli(['-r', "require 'cli/_cli.php'; $limits = FreshRSS_Context::systemConf()->limits; " +
			"$limits['cache_duration'] = 0; $limits['cache_duration_min'] = 0; " +
			"FreshRSS_Context::systemConf()->limits = $limits; if (!FreshRSS_Context::systemConf()->save()) exit(1);"]);
		for (const user of [admin, reader]) {
			const userArgs = ['cli/create-user.php', '--user', user, '--password', password, '--api-password', apiPassword,
				'--language', 'en', '--no-default-feeds', '--purge-after-months', '0'];
			await cli(userArgs);
			await cli(userArgs, { code: 3 });
		}
		const users = (await cli(['cli/list-users.php'])).toString();
		assert.match(users, /capadmin/);
		assert.match(users, /capreader/);
	});
	if (!installed) return;

	await check('Google Reader authenticates and forwards Authorization and PATH_INFO', async () => {
		auth = await apiLogin(admin);
		readerAuth = await apiLogin(reader);
		assert.equal((await subscriptions()).length, 0);
		const compatibility = await request('api/greader.php/check/compatibility', {
			headers: { Authorization: `GoogleLogin auth=${auth}` },
		});
		assert.equal(compatibility.text.trim(), 'PASS');
	});
	const authenticated = ['Google Reader authenticates and forwards Authorization and PATH_INFO'];

	await check('private-network feeds require an explicit host allowlist', async () => {
		const response = await api('subscription/quickadd', {
			data: new URLSearchParams({ quickadd: 'http://blocked-fixtures:8080/rss.xml' }),
		});
		assert.equal(response.status, 200);
		assert.equal(response.json().numResults, 0, 'A non-allowlisted internal feed was accepted');
		assert.equal((await subscriptions()).length, 0);
	}, authenticated);

	await check('invalid API credentials are rejected', async () => {
		const denied = await request('api/greader.php/accounts/ClientLogin', {
			method: 'POST', data: new URLSearchParams({ Email: admin, Passwd: 'wrong-password' }),
		});
		assert.equal(denied.status, 401);
		const fever = await request('api/fever.php?api', { method: 'POST', data: new URLSearchParams({ api_key: '0'.repeat(32) }) });
		assert.equal(fever.json().auth, 0);
	});

	await check('private paths are denied and static assets retain MIME types', async () => {
		for (const path of ['data/config.php', 'config.php', 'constants.php', '.git/config', '.htaccess', 'i/.htaccess', 'api/not-a-script.php']) {
			const response = await request(path, { redirect: false });
			assert.ok([403, 404].includes(response.status), `${path} returned ${response.status}`);
			assert.ok(!response.text.includes('<?php'), 'PHP source disclosed');
		}
		const asset = await request('themes/icons/FreshRSS-logo.svg');
		assert.equal(asset.status, 200);
		assert.match(asset.headers.get('content-type'), /image\/svg\+xml/);
		const apiResponse = await api('subscription/list?output=json');
		assert.equal(apiResponse.headers.get('x-content-type-options'), 'nosniff');
	}, authenticated);

	await check('form login, cookies, CSRF protection, and logout work', async () => {
		const bcrypt = await loadBcrypt();
		const jar = new Map();
		const login = await request('i/?c=auth&a=login', { jar });
		const hidden = hiddenFields(login.text);
		assert.ok(hidden._csrf, 'Login CSRF field missing');
		const nonce = await request(`i/?c=javascript&a=nonce&user=${admin}`, { jar });
		const { salt1, nonce: challengeNonce } = nonce.json();
		const challenge = bcrypt.hashSync(bcrypt.hashSync(password, salt1) + challengeNonce, 4);
		const loggedIn = await request('i/?c=auth&a=login', {
			method: 'POST', jar, data: new URLSearchParams({ ...hidden, username: admin, challenge }),
		});
		assert.equal(loggedIn.status, 200);
		assert.match(loggedIn.text, /a=logout/);
		const protectedPage = await request('i/?c=subscription&a=index', { jar });
		assert.equal(protectedPage.status, 200);
		assert.ok(!protectedPage.text.includes('id="challenge"'), 'Session did not retain authentication');
		const rejected = await request('i/?c=auth&a=logout', {
			method: 'POST', jar, data: new URLSearchParams({ _csrf: 'invalid' }),
		});
		assert.equal(rejected.status, 403);
		const valid = hiddenFields((await request('i/', { jar })).text)._csrf;
		assert.ok(valid, 'Authenticated CSRF field missing');
		await request('i/?c=auth&a=logout', { method: 'POST', jar, data: new URLSearchParams({ _csrf: valid }) });
		assert.match((await request('i/', { jar })).text, /id="challenge"/);
	});

	await check('RSS, Atom, gzip redirects, and OPML import preserve Unicode content', async () => {
		const added = await api('subscription/quickadd', { data: new URLSearchParams({ quickadd: `${target.feedUrl}/rss.xml` }) });
		assert.equal(added.status, 200);
		assert.equal(added.json().numResults, 1);
		const opml = `<opml version="2.0"><head><title>Capabilities</title></head><body>
			<outline text="Atom" type="rss" xmlUrl="${target.feedUrl}/atom.xml"/>
			<outline text="Gzip" type="rss" xmlUrl="${target.feedUrl}/redirect-gzip"/>
			</body></opml>`;
		const imported = await api('subscription/import', { method: 'POST', data: opml });
		assert.equal(imported.status, 200);
		assert.equal(imported.text, 'OK');
		const feeds = await subscriptions();
		assert.equal(feeds.length, 3);
		rssFeedId = feeds.find(feed => feed.url === `${target.feedUrl}/rss.xml`)?.id.split('/')[1];
		assert.ok(rssFeedId, 'RSS feed missing');
		const entries = await items();
		assert.equal(entries.length, 3);
		for (const kind of ['RSS', 'Atom', 'Gzip']) {
			assert.ok(entries.some(item => item.title === `${kind} Café 東京`), `${kind} entry/Unicode missing`);
		}
		entryId = entries.find(item => item.title === 'RSS Café 東京').id;
	}, authenticated);
	const imported = ['RSS, Atom, gzip redirects, and OPML import preserve Unicode content'];

	await check('a separate CLI refresh discovers new entries visible through HTTP', async () => {
		await target.advanceFixture();
		await cli(['cli/actualize-user.php', '--user', admin, '--feed-id', rssFeedId]);
		const entries = await items();
		assert.equal(entries.length, 4);
		assert.ok(entries.some(item => item.title === 'RSS revision two'));
	}, imported);

	await check('read and starred state can be changed through the API', async () => {
		const token = (await api('token')).text.trim();
		const result = await api('edit-tag', { data: new URLSearchParams([
			['T', token], ['i', entryId], ['a', 'user/-/state/com.google/read'], ['a', 'user/-/state/com.google/starred'],
		]) });
		assert.equal(result.status, 200);
		assert.equal(result.text.trim(), 'OK');
		const item = (await items()).find(item => item.id === entryId);
		assert.ok(item.categories.includes('user/-/state/com.google/read'));
		assert.ok(item.categories.includes('user/-/state/com.google/starred'));
	}, imported);

	await check('Fever returns authenticated feeds and entries while users remain isolated', async () => {
		assert.equal((await subscriptions(readerAuth)).length, 0);
		assert.equal((await items(readerAuth)).length, 0);
		const key = createHash('md5').update(`${admin}:${apiPassword}`).digest('hex');
		const response = await request('api/fever.php?api&feeds&items', {
			method: 'POST', data: new URLSearchParams({ api_key: key }),
		});
		assert.equal(response.status, 200);
		const fever = response.json();
		assert.equal(fever.auth, 1);
		assert.equal(fever.feeds.length, 3);
		assert.equal(fever.items.length, 4);
	}, ['a separate CLI refresh discovers new entries visible through HTTP']);

	await check('OPML and ZIP exports can be imported into another user', async () => {
		const opml = (await cli(['cli/export-opml-for-user.php', '--user', admin])).toString();
		assert.match(opml, /<opml/);
		for (const url of [`${target.feedUrl}/rss.xml`, `${target.feedUrl}/atom.xml`, `${target.feedUrl}/redirect-gzip`]) {
			assert.ok(opml.includes(url), `CLI OPML export omitted ${url}`);
		}
		const exported = await api('subscription/export');
		assert.equal(exported.status, 200);
		assert.match(exported.text, /<opml/);
		for (const url of [`${target.feedUrl}/rss.xml`, `${target.feedUrl}/atom.xml`, `${target.feedUrl}/redirect-gzip`]) {
			assert.ok(exported.text.includes(url), `HTTP OPML export omitted ${url}`);
		}
		const zip = await cli(['cli/export-zip-for-user.php', '--user', admin]);
		assert.equal(zip.subarray(0, 2).toString(), 'PK');
		await cli(['-r', "require 'constants.php'; file_put_contents(DATA_PATH . '/capabilities.zip', stream_get_contents(STDIN));"], { input: zip });
		await cli(['cli/import-for-user.php', '--user', reader, '--filename', '/var/www/FreshRSS/data/capabilities.zip']);
		const importedFeeds = await subscriptions(readerAuth);
		assert.deepEqual(importedFeeds.map(feed => feed.url).sort(),
			[`${target.feedUrl}/atom.xml`, `${target.feedUrl}/redirect-gzip`, `${target.feedUrl}/rss.xml`].sort());
		const importedItems = await items(readerAuth);
		assert.equal(importedItems.length, 4);
		for (const title of ['Atom Café 東京', 'Gzip Café 東京', 'RSS Café 東京', 'RSS revision two']) {
			assert.ok(importedItems.some(item => item.title === title), `ZIP import omitted ${title}`);
		}
		await cli(['-r', "require 'constants.php'; unlink(DATA_PATH . '/capabilities.zip');"]);
	}, ['a separate CLI refresh discovers new entries visible through HTTP', 'Fever returns authenticated feeds and entries while users remain isolated']);

	await check('access logs redact password and token query values', async () => {
		const marker = randomBytes(12).toString('hex');
		const sentinel = `capability-log-${randomBytes(5).toString('hex')}`;
		const response = await request(`themes/icons/FreshRSS-logo.svg?check=${sentinel}&Passwd=${marker}&token=${marker}`);
		assert.equal(response.status, 200);
		let logs = '';
		for (let attempt = 0; attempt < 30; attempt++) {
			logs = await target.logs();
			if (logs.includes(sentinel)) break;
			await delay(250);
		}
		assert.ok(logs.includes(sentinel), 'Access-log probe was not observed');
		assert.ok(!logs.includes(marker), 'Access log disclosed credential query values');
		assert.match(logs, /[Pp]asswd=redacted/);
	});

	await check('container recreation retains users, entries, and read/star state', async () => {
		await target.recreate();
		auth = await apiLogin(admin);
		readerAuth = await apiLogin(reader);
		assert.equal((await subscriptions()).length, 3);
		const entries = await items();
		assert.equal(entries.length, 4);
		const item = entries.find(item => item.id === entryId);
		assert.ok(item, 'Original entry ID lost');
		assert.ok(item.categories.includes('user/-/state/com.google/read'));
		assert.ok(item.categories.includes('user/-/state/com.google/starred'));
	}, ['a separate CLI refresh discovers new entries visible through HTTP', 'read and starred state can be changed through the API']);

	await check('PostgreSQL, MySQL, and MariaDB install, persist, and serve refreshed entries', async () => {
		const dbPassword = `Db-${randomBytes(16).toString('hex')}`;
		const rootPassword = `Root-${randomBytes(16).toString('hex')}`;
		const backends = [
			{ type: 'pgsql', image: 'postgres:18', alias: 'pgsql', port: '5432', env: { POSTGRES_DB: 'freshrss', POSTGRES_USER: 'freshrss', POSTGRES_PASSWORD: dbPassword }, ready: ['pg_isready', '-U', 'freshrss', '-d', 'freshrss'] },
			{ type: 'mysql', image: 'mysql:8.4', alias: 'mysql', port: '3306', env: { MYSQL_DATABASE: 'freshrss', MYSQL_USER: 'freshrss', MYSQL_PASSWORD: dbPassword, MYSQL_ROOT_PASSWORD: rootPassword }, ready: ['mysqladmin', 'ping', '-h127.0.0.1', '-uroot', `-p${rootPassword}`, '--silent'] },
			{ type: 'mysql', image: 'mariadb:11.4', alias: 'mariadb', port: '3306', env: { MARIADB_DATABASE: 'freshrss', MARIADB_USER: 'freshrss', MARIADB_PASSWORD: dbPassword, MARIADB_ROOT_PASSWORD: rootPassword }, ready: ['healthcheck.sh', '--connect', '--innodb_initialized'] },
		];
		for (const backend of backends) {
			const dbTarget = createTarget({ image: values.image, fixtureImage: values['fixture-image'], cliUser: values['cli-user'] });
			try {
				await dbTarget.start();
				await dbTarget.startService({ ...backend, readyCommand: backend.ready, timeout: 180_000 });
				await dbTarget.cli(['cli/prepare.php']);
				await dbTarget.cli(['cli/do-install.php', '--default-user', 'capdb', '--auth-type', 'form', '--api-enabled',
					'--db-type', backend.type, '--db-host', `${backend.alias}:${backend.port}`, '--db-user', 'freshrss',
					'--db-password', dbPassword, '--db-base', 'freshrss', '--db-prefix', 'cap_', '--base-url', dbTarget.baseUrl, '--language', 'en']);
				await dbTarget.cli(['cli/create-user.php', '--user', 'capdb', '--password', password, '--api-password', apiPassword,
					'--language', 'en', '--no-default-feeds', '--purge-after-months', '0']);
				await dbTarget.cli(['-r', "require 'cli/_cli.php'; $limits = FreshRSS_Context::systemConf()->limits; $limits['cache_duration'] = 0; $limits['cache_duration_min'] = 0; FreshRSS_Context::systemConf()->limits = $limits; if (!FreshRSS_Context::systemConf()->save()) exit(1);"]);
				const config = JSON.parse((await dbTarget.cli(['-r', "require 'cli/_cli.php'; echo json_encode(FreshRSS_Context::systemConf()->db);"])).stdout.toString());
				assert.equal(config.type, backend.type, `${backend.type} was not selected in FreshRSS configuration`);
				const login = await fetch(new URL('api/greader.php/accounts/ClientLogin', dbTarget.baseUrl), {
					method: 'POST', body: new URLSearchParams({ Email: 'capdb', Passwd: apiPassword }),
				});
				assert.equal(login.status, 200, `${backend.type} user could not authenticate`);
				const token = (await login.text()).match(/^Auth=(.+)$/m)?.[1];
				assert.ok(token, `${backend.type} API token missing`);
				const apiFetch = (path, options = {}) => fetch(new URL(`api/greader.php/reader/api/0/${path}`, dbTarget.baseUrl), {
					...options, headers: { Authorization: `GoogleLogin auth=${token}`, ...(options.headers ?? {}) },
				});
				const added = await apiFetch('subscription/quickadd', { method: 'POST', body: new URLSearchParams({ quickadd: `${dbTarget.feedUrl}/rss.xml` }) });
				assert.equal(added.status, 200, `${backend.type} feed subscription failed`);
				assert.equal((await added.json()).numResults, 1, `${backend.type} did not save the feed subscription`);
				let listing = await apiFetch('stream/contents/reading-list?n=100');
				assert.equal(listing.status, 200);
				assert.ok((await listing.json()).items.some(item => item.title === 'RSS Café 東京'), `${backend.type} did not persist initial feed entries`);
				await dbTarget.advanceFixture();
				await dbTarget.cli(['cli/actualize-user.php', '--user', 'capdb', '--feed-id', '1']);
				listing = await apiFetch('stream/contents/reading-list?n=100');
				assert.ok((await listing.json()).items.some(item => item.title === 'RSS revision two'), `${backend.type} did not persist refreshed entries`);
				await dbTarget.recreate();
				listing = await apiFetch('stream/contents/reading-list?n=100');
				assert.equal(listing.status, 200, `${backend.type} stopped serving data after web container recreation`);
				assert.ok((await listing.json()).items.some(item => item.title === 'RSS revision two'), `${backend.type} data was lost after web container recreation`);
			} finally {
				await dbTarget.cleanup();
			}
		}
	});

	await check('WebSub subscription handshake and pushed content update work end to end', async () => {
		const websubTarget = createTarget({ image: values.image, fixtureImage: values['fixture-image'], cliUser: values['cli-user'] });
		try {
			await websubTarget.start();
			await websubTarget.cli(['cli/prepare.php']);
			await websubTarget.cli(['cli/do-install.php', '--default-user', 'capwebsub', '--auth-type', 'form', '--api-enabled',
				'--db-type', 'sqlite', '--base-url', 'http://fixtures:8080', '--language', 'en']);
			await websubTarget.cli(['cli/create-user.php', '--user', 'capwebsub', '--password', password, '--api-password', apiPassword,
				'--language', 'en', '--no-default-feeds', '--purge-after-months', '0']);
			await websubTarget.cli(['-r', "require 'cli/_cli.php'; $c = FreshRSS_Context::systemConf(); $c->pubsubhubbub_enabled = true; $limits = $c->limits; $limits['cache_duration'] = 0; $limits['cache_duration_min'] = 0; $c->limits = $limits; if (!$c->save()) exit(1);"]);
			const login = await fetch(new URL('api/greader.php/accounts/ClientLogin', websubTarget.baseUrl), {
				method: 'POST', body: new URLSearchParams({ Email: 'capwebsub', Passwd: apiPassword }),
			});
			assert.equal(login.status, 200);
			const token = (await login.text()).match(/^Auth=(.+)$/m)?.[1];
			assert.ok(token);
			const headers = { Authorization: `GoogleLogin auth=${token}` };
			const added = await fetch(new URL('api/greader.php/reader/api/0/subscription/quickadd', websubTarget.baseUrl), {
				method: 'POST', headers, body: new URLSearchParams({ quickadd: `${websubTarget.feedUrl}/websub.xml` }),
			});
			assert.equal(added.status, 200);
			assert.equal((await added.json()).numResults, 1, 'WebSub topic feed was not subscribed');
			const stateResponse = await fetch(`${websubTarget.fixtureExternalUrl}hub/state`);
			assert.equal(stateResponse.status, 200);
			const hubState = await stateResponse.json();
			assert.equal(hubState.mode, 'subscribe', 'FreshRSS did not request a WebSub subscription');
			assert.equal(hubState.verify, 'sync');
			assert.equal(hubState.topic, `${websubTarget.feedUrl}/websub.xml`);
			assert.match(hubState.callback, /\/api\/pshb\.php\?k=[a-f0-9]{64}$/);
			const callback = new URL(hubState.callback);
			callback.host = new URL(websubTarget.baseUrl).host;
			const challenge = `websub-${randomBytes(12).toString('hex')}`;
			const verification = await fetch(`${callback.href}&hub_mode=subscribe&hub_challenge=${challenge}&hub_lease_seconds=86400`, { redirect: 'manual' });
			assert.equal(verification.status, 200, 'FreshRSS rejected the hub subscription verification callback');
			assert.equal(await verification.text(), challenge, 'FreshRSS did not echo the hub challenge');
			const date = new Date().toUTCString();
			const push = `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>WebSub</title><link>${websubTarget.feedUrl}/</link><description>Push</description><atom:link rel="self" href="${websubTarget.feedUrl}/websub.xml"/><item><guid>websub-pushed-1</guid><title>WebSub pushed Café 東京</title><link>${websubTarget.feedUrl}/websub-pushed-1</link><pubDate>${date}</pubDate><description>Push content</description></item></channel></rss>`;
			const delivery = await fetch(callback, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: push, redirect: 'manual' });
			const deliveryBody = await delivery.text();
			assert.equal(delivery.status, 200, `FreshRSS rejected valid WebSub delivery: ${deliveryBody}`);
			assert.match(deliveryBody, /Done: 1/, 'FreshRSS did not acknowledge one pushed entry');
			const entriesResponse = await fetch(new URL('api/greader.php/reader/api/0/stream/contents/reading-list?n=100', websubTarget.baseUrl), { headers });
			assert.equal(entriesResponse.status, 200);
			assert.ok((await entriesResponse.json()).items.some(item => item.title === 'WebSub pushed Café 東京'), 'Pushed WebSub entry is not visible through FreshRSS API');
		} finally {
			await websubTarget.cleanup();
		}
	});

	await check('OIDC login, provider logout, and inactivity expiry work against the local provider', async () => {
		// FreshRSS consumes Apache's REMOTE_USER only in HTTP authentication mode.
		await cli(['cli/reconfigure.php', '--auth-type', 'http_auth']);
		await target.enableOidc({ OIDC_SESSION_INACTIVITY_TIMEOUT: '10' });
		const jar = new Map();
		const saveCookies = response => {
			for (const cookie of response.headers.getSetCookie()) {
				const [pair] = cookie.split(';');
				const index = pair.indexOf('=');
				if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
			}
		};
		const headers = () => jar.size ? { Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {};
		const appOrigin = new URL(target.baseUrl).origin;
		const navigationHeaders = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
		const start = await browserGet(new URL('i/', target.baseUrl), navigationHeaders);
		saveCookies({ headers: { getSetCookie: () => start.headers['set-cookie'] ?? [] } });
		const oidcLogs = (await target.logs()).split('\n')
			.filter(line => line.includes('[auth_openidc:') || line.includes('GET /i/')).slice(-80).join('\n');
		assert.ok([302, 303].includes(start.status),
			`OIDC request returned HTTP ${start.status}: ${start.text.slice(0, 1000)}\n${oidcLogs}\nFixture:\n${(await target.fixtureLogs()).slice(-3000)}`);
		const authorization = new URL(start.headers.location, target.baseUrl);
		assert.equal(authorization.hostname, 'fixtures', 'Authentication did not redirect to the configured OIDC provider');
		assert.equal(authorization.pathname, '/oidc/authorize', 'Authentication did not use the provider authorization endpoint');
		assert.equal(authorization.searchParams.get('client_id'), 'freshrss-capability');
		assert.equal(authorization.searchParams.get('response_type'), 'code');
		assert.ok(authorization.searchParams.get('state'), 'OIDC state is missing');
		assert.ok(authorization.searchParams.get('nonce'), 'OIDC nonce is missing');
		const forgedWebAuth = await browserGet(new URL('i/', target.baseUrl), {
			...navigationHeaders, 'Remote-User': admin, 'X-WebAuth-User': admin,
		});
		assert.equal(forgedWebAuth.status, 302, 'Client-supplied identity headers bypassed OIDC authentication');
		const forgedApiAuth = await request('api/greader.php/reader/api/0/subscription/list?output=json', {
			headers: { 'Remote-User': admin, 'X-WebAuth-User': admin, 'X-Forwarded-For': '127.0.0.1' },
		});
		assert.equal(forgedApiAuth.status, 401, 'Client-supplied identity headers bypassed API authentication');

		// The provider is reachable from Apache as fixtures:8080 and from this test through its loopback port.
		const providerAuthorization = new URL(authorization);
		providerAuthorization.host = new URL(target.fixtureExternalUrl).host;
		const approved = await fetch(providerAuthorization, {
			redirect: 'manual', signal: AbortSignal.timeout(10_000),
		});
		assert.equal(approved.status, 302, 'Local identity provider rejected the authorization request');
		const callback = new URL(approved.headers.get('location'), target.baseUrl);
		assert.equal(callback.origin, appOrigin, 'OIDC callback left the FreshRSS test deployment');
		assert.equal(callback.pathname, '/i/oidc/');

		const completed = await browserGet(callback, { ...navigationHeaders, ...headers() });
		saveCookies({ headers: { getSetCookie: () => completed.headers['set-cookie'] ?? [] } });
		assert.ok([302, 303].includes(completed.status), `OIDC callback did not complete: HTTP ${completed.status} ${completed.text.slice(0, 500)}`);
		const page = await request('i/?c=subscription&a=index', { jar });
		assert.equal(page.status, 200, 'The OIDC-authenticated user could not open a protected FreshRSS page');
		assert.match(page.text, /capadmin/, 'OIDC preferred_username was not mapped to the FreshRSS user');
		assert.doesNotMatch(page.text, /id="challenge"/, 'FreshRSS showed the form login after OIDC authentication');

		const logoutReturn = new URL('themes/icons/FreshRSS-logo.svg', target.baseUrl);
		const logoutCallback = new URL('i/oidc/', target.baseUrl);
		logoutCallback.searchParams.set('logout', logoutReturn.href);
		const localLogout = await browserGet(logoutCallback, { ...navigationHeaders, ...headers() });
		saveCookies({ headers: { getSetCookie: () => localLogout.headers['set-cookie'] ?? [] } });
		assert.ok([302, 303].includes(localLogout.status), `OIDC logout did not redirect to the provider: HTTP ${localLogout.status} ${localLogout.text.slice(0, 500)}`);
		const providerLogout = new URL(localLogout.headers.location, target.baseUrl);
		assert.equal(providerLogout.hostname, 'fixtures', 'OIDC logout did not use the provider end-session endpoint');
		assert.equal(providerLogout.pathname, '/oidc/logout');
		assert.equal(providerLogout.searchParams.get('post_logout_redirect_uri'), logoutReturn.href);
		providerLogout.host = new URL(target.fixtureExternalUrl).host;
		const completedLogout = await fetch(providerLogout, {
			redirect: 'manual', signal: AbortSignal.timeout(10_000),
		});
		assert.equal(completedLogout.status, 302, 'Local OIDC provider did not complete end-session logout');
		assert.equal(completedLogout.headers.get('location'), logoutReturn.href);
		const logoutStateResponse = await fetch(`${target.fixtureExternalUrl}oidc/logout-state`);
		assert.equal(logoutStateResponse.status, 200);
		const logoutState = await logoutStateResponse.json();
		assert.equal(logoutState.post_logout_redirect_uri, logoutReturn.href);
		const afterLogout = await browserGet(new URL('i/?c=subscription&a=index', target.baseUrl), {
			...navigationHeaders, ...headers(),
		});
		saveCookies({ headers: { getSetCookie: () => afterLogout.headers['set-cookie'] ?? [] } });
		assert.equal(afterLogout.status, 302, 'OIDC logout left the FreshRSS session authenticated');
		assert.equal(new URL(afterLogout.headers.location, target.baseUrl).pathname, '/oidc/authorize',
			'Post-logout protected request did not begin a fresh OIDC login');

		// Authenticate again, then wait beyond mod_auth_openidc's ten-second minimum idle timeout.
		const restartedAuthorization = new URL(afterLogout.headers.location, target.baseUrl);
		const restartedProviderAuthorization = new URL(restartedAuthorization);
		restartedProviderAuthorization.host = new URL(target.fixtureExternalUrl).host;
		const restartedApproved = await fetch(restartedProviderAuthorization, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
		assert.equal(restartedApproved.status, 302, 'Provider rejected the post-logout authorization request');
		const restartedCallback = new URL(restartedApproved.headers.get('location'), target.baseUrl);
		const restartedCompleted = await browserGet(restartedCallback, { ...navigationHeaders, ...headers() });
		saveCookies({ headers: { getSetCookie: () => restartedCompleted.headers['set-cookie'] ?? [] } });
		assert.ok([302, 303].includes(restartedCompleted.status), 'OIDC login after logout did not complete');
		const beforeExpiry = await browserGet(new URL('i/?c=subscription&a=index', target.baseUrl), {
			...navigationHeaders, ...headers(),
		});
		assert.equal(beforeExpiry.status, 200, 'Fresh OIDC session was not valid before its inactivity timeout');
		const serverStart = Date.parse(beforeExpiry.headers.date);
		assert.ok(Number.isFinite(serverStart), 'OIDC idle check requires the server Date header');
		// The runner and Linux engine can have different clocks. Observe time on
		// an unprotected asset without session cookies so this never renews the
		// protected session. A 12-second Date-header gap guarantees at least
		// 11 seconds of server inactivity despite whole-second HTTP timestamps.
		const observedDates = [];
		let serverIdleMs = 0;
		for (let attempt = 0; attempt < 5 && serverIdleMs < 12_000; attempt++) {
			await delay(Math.min(12_000, Math.max(1000, 12_000 - serverIdleMs)));
			const clock = await browserGet(new URL('themes/icons/FreshRSS-logo.svg', target.baseUrl));
			assert.equal(clock.status, 200, 'Public clock-probe asset must remain accessible');
			const observed = Date.parse(clock.headers.date);
			assert.ok(Number.isFinite(observed), 'Clock probe requires the server Date header');
			observedDates.push(clock.headers.date);
			serverIdleMs = observed - serverStart;
		}
		report.oidcSessionExpiry = { configuredTimeoutSeconds: 10, beforeDate: beforeExpiry.headers.date,
			observedDates, serverIdleMs };
		assert.ok(serverIdleMs >= 12_000, 'Server clock did not advance enough for the idle-expiry check');
		const expired = await browserGet(new URL('i/?c=subscription&a=index', target.baseUrl), {
			...navigationHeaders, ...headers(),
		});
		assert.equal(expired.status, 302, 'Expired OIDC inactivity session still accessed a protected page');
		assert.equal(new URL(expired.headers.location, target.baseUrl).pathname, '/oidc/authorize',
			'Expired OIDC session did not trigger fresh provider authorization');
		const unauthenticated = await browserGet(new URL('i/?c=subscription&a=index', target.baseUrl), navigationHeaders);
		assert.equal(unauthenticated.status, 302, 'A request without the OIDC session was not sent through authentication');
	});

	await check('OIDC rejects invalid state, nonce, and ID-token signatures', async () => {
		const navigationHeaders = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
		const runRejectedFlow = async ({ mutateState = false, badNonce = false, badSignature = false }) => {
			const jar = new Map();
			const saveCookies = response => {
				for (const cookie of response.headers['set-cookie'] ?? []) {
					const [pair] = cookie.split(';');
					const index = pair.indexOf('=');
					if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
				}
			};
			const cookieHeader = () => jar.size ? { Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {};
			const start = await browserGet(new URL('i/', target.baseUrl), navigationHeaders);
			assert.ok([302, 303].includes(start.status), `OIDC rejection case did not start: ${start.status}`);
			saveCookies(start);
			const authorization = new URL(start.headers.location, target.baseUrl);
			if (badNonce) authorization.searchParams.set('bad_nonce', '1');
			if (badSignature) authorization.searchParams.set('bad_signature', '1');
			const providerAuthorization = new URL(authorization);
			providerAuthorization.host = new URL(target.fixtureExternalUrl).host;
			const approved = await fetch(providerAuthorization, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
			assert.equal(approved.status, 302, 'OIDC fixture did not issue the test authorization code');
			const callback = new URL(approved.headers.get('location'), target.baseUrl);
			if (mutateState) callback.searchParams.set('state', `${callback.searchParams.get('state')}-tampered`);
			const completed = await browserGet(callback, { ...navigationHeaders, ...cookieHeader() });
			saveCookies(completed);
			const protectedPage = await browserGet(new URL('i/?c=subscription&a=index', target.baseUrl), {
				...navigationHeaders, ...cookieHeader(),
			});
			assert.equal(protectedPage.status, 302, 'A rejected OIDC callback created an authenticated session');
			const nextAuth = new URL(protectedPage.headers.location, target.baseUrl);
			assert.equal(nextAuth.hostname, 'fixtures', 'Rejected callback did not return to OIDC authentication');
		};
		await runRejectedFlow({ mutateState: true });
		await runRejectedFlow({ badNonce: true });
		await runRejectedFlow({ badSignature: true });
	});

	await check('OIDC protection leaves public assets and WebSub callbacks reachable with endpoint validation', async () => {
		const asset = await fetch(new URL('themes/icons/FreshRSS-logo.svg', target.baseUrl), { redirect: 'manual' });
		assert.equal(asset.status, 200, 'OIDC unexpectedly protected a public static asset');
		assert.match(asset.headers.get('content-type') ?? '', /image\/svg\+xml/);
		const malformed = await fetch(new URL('api/pshb.php?k=not-a-hex-key', target.baseUrl), { redirect: 'manual' });
		assert.equal(malformed.status, 422, 'WebSub callback was redirected to OIDC or did not validate malformed keys');
		assert.match(await malformed.text(), /Invalid feed key format/);
		const unknownUnsubscribe = await fetch(new URL('api/pshb.php?k=deadbeef&hub_mode=unsubscribe&hub_challenge=capability-challenge', target.baseUrl), { redirect: 'manual' });
		assert.equal(unknownUnsubscribe.status, 200, 'Unauthenticated WebSub unsubscribe callback did not respond');
		assert.equal(await unknownUnsubscribe.text(), 'capability-challenge');
	});

	await check('interactive web installer provisions a fresh SQLite deployment', async () => {
		const installTarget = createTarget({ image: values.image, fixtureImage: values['fixture-image'], cliUser: values['cli-user'] });
		const cookies = new Map();
		const proxy = createServer((incoming, outgoing) => {
			const incomingPath = incoming.url ?? '/';
			if (!incomingPath.startsWith('/freshrss/')) {
				outgoing.writeHead(404);
				outgoing.end('missing proxy prefix');
				return;
			}
			const upstream = new URL(incomingPath.slice('/freshrss'.length), installTarget.baseUrl);
			const headers = { ...incoming.headers, host: upstream.host,
				'x-forwarded-host': 'rss.example.test', 'x-forwarded-prefix': '/freshrss/',
				'x-forwarded-proto': 'https', 'x-forwarded-port': '443', 'x-forwarded-for': '198.51.100.25' };
			const upstreamRequest = httpRequest(upstream, { method: incoming.method, headers }, upstreamResponse => {
				const responseHeaders = { ...upstreamResponse.headers };
				delete responseHeaders.connection;
				delete responseHeaders['transfer-encoding'];
				outgoing.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
				upstreamResponse.pipe(outgoing);
			});
			upstreamRequest.on('error', () => {
				if (!outgoing.headersSent) outgoing.writeHead(502);
				outgoing.end('proxy upstream error');
			});
			incoming.pipe(upstreamRequest);
		});
		const webRequest = async (path, data) => {
			const headers = {};
			if (cookies.size) headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
			const response = await fetch(`http://127.0.0.1:${proxy.address().port}/freshrss/${path.replace(/^\//, '')}`, {
				method: data ? 'POST' : 'GET',
				headers,
				body: data ? new URLSearchParams(data) : undefined,
				redirect: 'manual',
				signal: AbortSignal.timeout(10_000),
			});
			for (const cookie of response.headers.getSetCookie()) {
				const [pair] = cookie.split(';');
				const split = pair.indexOf('=');
				if (split > 0) cookies.set(pair.slice(0, split), pair.slice(split + 1));
			}
			return { status: response.status, location: response.headers.get('location'), text: await response.text() };
		};
		try {
			await installTarget.start();
			await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
			const language = await webRequest('i/index.php?step=0', { language: 'en' });
			assert.equal(language.status, 302);
			assert.match(language.location ?? '', /step=1/);
			const requirements = await webRequest('i/index.php?step=1');
			assert.equal(requirements.status, 200);
			assert.match(requirements.text, /step=2/);
			const database = await webRequest('i/index.php?step=2', { type: 'sqlite' });
			assert.equal(database.status, 302, `SQLite setup did not advance: ${database.text.slice(0, 500)}`);
			assert.match(database.location ?? '', /step=3/);
			const admin = await webRequest('i/index.php?step=3', {
				default_user: 'capwizard', auth_type: 'form', passwordPlain: `Wizard-${randomBytes(12).toString('hex')}`,
			});
			assert.equal(admin.status, 302, `Admin setup did not advance: ${admin.text.slice(0, 500)}`);
			assert.match(admin.location ?? '', /step=4/);
			const finished = await webRequest('i/index.php?step=5');
			assert.ok([301, 302, 303].includes(finished.status), `Installer migrations did not finish: HTTP ${finished.status}`);
			const users = (await installTarget.cli(['cli/list-users.php'])).stdout.toString();
			assert.match(users, /capwizard/, 'Web installer did not create its requested administrator');
			const installedPage = await webRequest('i/');
			assert.equal(installedPage.status, 200);
			assert.doesNotMatch(installedPage.text, /Installation.*FreshRSS|FreshRSS.*[Ii]nstall/, 'Web installer remained active after setup');
			const installedConfig = JSON.parse((await installTarget.cli(['-r', "require 'cli/_cli.php'; echo json_encode(['base_url' => FreshRSS_Context::systemConf()->base_url]);"])).stdout.toString());
			assert.equal(installedConfig.base_url, 'https://rss.example.test/freshrss', 'Forwarded host, HTTPS scheme, or sub-path was not saved as the FreshRSS base URL');
			assert.ok((installedPage.text.match(/\/freshrss\//g) ?? []).length > 0, 'Installed page did not generate sub-path asset or navigation URLs');
		} finally {
			if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
			await installTarget.cleanup();
		}
	});

	await check('entrypoint auto-install, auto-user, and custom DATA_PATH work across recreation', async () => {
		const autoPassword = `Auto-${randomBytes(16).toString('hex')}`;
		const autoApiPassword = `AutoApi-${randomBytes(16).toString('hex')}`;
		const autoTarget = createTarget({
			image: values.image,
			fixtureImage: values['fixture-image'],
			cliUser: values['cli-user'],
			dataPath: '/var/lib/freshrss-capability-data',
			webEnv: {
				CRON_MIN: '*',
				FRESHRSS_INSTALL: '--default-user capauto --auth-type form --api-enabled --db-type sqlite --language en',
				FRESHRSS_USER: `--user capauto --password ${autoPassword} --api-password ${autoApiPassword} --language en --no-default-feeds --purge-after-months 0`,
			},
		});
		try {
			await autoTarget.start();
			const users = (await autoTarget.cli(['cli/list-users.php'])).stdout.toString();
			assert.match(users, /capauto/, 'Entrypoint did not create the requested user');
			await autoTarget.cli(['-r', "require 'cli/_cli.php'; $limits = FreshRSS_Context::systemConf()->limits; " +
				"$limits['cache_duration'] = 0; $limits['cache_duration_min'] = 0; " +
				"FreshRSS_Context::systemConf()->limits = $limits; if (!FreshRSS_Context::systemConf()->save()) exit(1); " +
				"FreshRSS_Context::initUser('capauto'); $userConfig = FreshRSS_Context::userConf(); $userConfig->ttl_default = 0; " +
				"if (!FreshRSS_Context::userConf()->save()) exit(1);"]);
			const config = JSON.parse((await autoTarget.cli(['-r', "require 'constants.php'; echo json_encode(['path' => DATA_PATH, 'installed' => is_file(DATA_PATH . '/config.php')]);"])).stdout.toString());
			assert.deepEqual(config, { path: '/var/lib/freshrss-capability-data', installed: true });
			const login = await fetch(new URL('api/greader.php/accounts/ClientLogin', autoTarget.baseUrl), {
				method: 'POST', body: new URLSearchParams({ Email: 'capauto', Passwd: autoApiPassword }),
			});
			assert.equal(login.status, 200, 'Automatically created user cannot authenticate through the API');
			const auth = (await login.text()).match(/^Auth=(.+)$/m)?.[1];
			assert.ok(auth, 'Auto-created API credentials did not yield an auth token');
			const added = await fetch(new URL('api/greader.php/reader/api/0/subscription/quickadd', autoTarget.baseUrl), {
				method: 'POST', headers: { Authorization: `GoogleLogin auth=${auth}` },
				body: new URLSearchParams({ quickadd: `${autoTarget.feedUrl}/rss.xml` }),
			});
			assert.equal(added.status, 200);
			assert.equal((await added.json()).numResults, 1, 'Could not add the local feed for scheduled refresh');
			const beforeSchedule = await fetch(new URL('api/greader.php/reader/api/0/stream/contents/reading-list?n=100', autoTarget.baseUrl), {
				headers: { Authorization: `GoogleLogin auth=${auth}` },
			});
			assert.equal(beforeSchedule.status, 200);
			assert.equal((await beforeSchedule.json()).items.length, 1, 'Initial fixture revision should contain one entry before the cron run');
			await autoTarget.advanceFixture();
			const changedFeed = await fetch(`${autoTarget.fixtureExternalUrl}rss.xml`);
			assert.match(await changedFeed.text(), /RSS revision two/, 'The changed fixture must expose the new article before cron runs');
			const refreshDeadline = Date.now() + 90_000;
			let scheduledEntryFound = false;
			let lastEntries = [];
			while (Date.now() < refreshDeadline) {
				const result = await fetch(new URL('api/greader.php/reader/api/0/stream/contents/reading-list?n=100', autoTarget.baseUrl), {
					headers: { Authorization: `GoogleLogin auth=${auth}` },
				});
				assert.equal(result.status, 200);
				lastEntries = (await result.json()).items;
				if (lastEntries.some(item => item.title === 'RSS revision two')) {
					scheduledEntryFound = true;
					break;
				}
				await delay(5_000);
			}
			assert.ok(scheduledEntryFound, `CRON_MIN did not refresh the changed feed within 90 seconds; visible entries: ${JSON.stringify(lastEntries)}\n${await autoTarget.diagnostics()}\nContainer logs:\n${await autoTarget.logs()}\nFixture logs:\n${await autoTarget.fixtureLogs()}`);
			await autoTarget.recreate();
			const afterRestart = (await autoTarget.cli(['cli/list-users.php'])).stdout.toString();
			assert.match(afterRestart, /capauto/, 'Auto-install restart lost its user');
			assert.equal((await fetch(new URL('api/greader.php/accounts/ClientLogin', autoTarget.baseUrl), {
				method: 'POST', body: new URLSearchParams({ Email: 'capauto', Passwd: autoApiPassword }),
			})).status, 200, 'User credentials did not survive container recreation');
		} finally {
			await autoTarget.cleanup();
		}
	});

	report.completed = true;
	if (values.baseline) {
		report.comparison = { baseline: values.baseline, status: 'failed' };
		await t.test('baseline has no lost capabilities', async () => {
			const baseline = JSON.parse(await readFile(values.baseline, 'utf8'));
			assert.equal(baseline.suiteVersion, report.suiteVersion, 'Baseline suite version differs');
			assert.equal(baseline.completed, true, 'Baseline run did not complete');
			assert.notEqual(baseline.success, false, 'Baseline run was not successful');
			assert.ok(baseline.tests.length > 0, 'Baseline has no capability tests');
			for (const previous of baseline.tests) {
				assert.equal(previous.status, 'passed', 'Baseline must have passed all capabilities');
				assert.ok(passed.has(previous.name), `Capability lost: ${previous.name}`);
			}
			report.comparison.status = 'passed';
		});
	}
});
