<?php
declare(strict_types=1);

// This router runs only in the isolated fixture container, never in FreshRSS's public root.
$requestUri = $_SERVER['REQUEST_URI'] ?? '/';
$path = parse_url(is_string($requestUri) ? $requestUri : '/', PHP_URL_PATH);
$revisionFile = '/tmp/freshrss-capability-revision';
$revision = is_file($revisionFile) ? (int)file_get_contents($revisionFile) : 1;
$base = 'http://fixtures:8080';

function oidcBase64Url(string $value): string {
	return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function oidcSigningKey(): OpenSSLAsymmetricKey|false {
	$keyFile = '/tmp/freshrss-capability-oidc-key.pem';
	if (!is_file($keyFile)) {
		$key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_RSA, 'private_key_bits' => 2048]);
		if ($key === false || !openssl_pkey_export_to_file($key, $keyFile)) {
			return false;
		}
		chmod($keyFile, 0600);
		return $key;
	}
	return openssl_pkey_get_private(file_get_contents($keyFile));
}

function oidcSendJson(array $response, int $status = 200): void {
	http_response_code($status);
	header('Content-Type: application/json');
	header('Cache-Control: no-store');
	echo json_encode($response, JSON_THROW_ON_ERROR);
}

if (str_starts_with(is_string($path) ? $path : '', '/oidc/')) {
	error_log('OIDC fixture request ' . ($_SERVER['REQUEST_METHOD'] ?? 'GET') . ' ' . $path);
	$issuer = 'http://fixtures:8080/oidc';
	if ($path === '/oidc/.well-known/openid-configuration') {
		oidcSendJson([
			'issuer' => $issuer,
			'authorization_endpoint' => $issuer . '/authorize',
			'token_endpoint' => $issuer . '/token',
			'userinfo_endpoint' => $issuer . '/userinfo',
			'end_session_endpoint' => $issuer . '/logout',
			'jwks_uri' => $issuer . '/jwks',
			'response_types_supported' => ['code'],
			'subject_types_supported' => ['public'],
			'id_token_signing_alg_values_supported' => ['RS256'],
			'token_endpoint_auth_methods_supported' => ['client_secret_basic'],
			'scopes_supported' => ['openid', 'profile'],
		]);
		return;
	}
	if ($path === '/oidc/jwks') {
		$key = oidcSigningKey();
		$details = $key === false ? false : openssl_pkey_get_details($key);
		if (!is_array($details) || !isset($details['rsa']['n'], $details['rsa']['e'])) {
			oidcSendJson(['error' => 'server_error'], 500);
			return;
		}
		oidcSendJson(['keys' => [[
			'kty' => 'RSA',
			'use' => 'sig',
			'alg' => 'RS256',
			'kid' => 'freshrss-capability-key',
			'n' => oidcBase64Url($details['rsa']['n']),
			'e' => oidcBase64Url($details['rsa']['e']),
		]]]);
		return;
	}
	if ($path === '/oidc/authorize') {
		$redirectUri = $_GET['redirect_uri'] ?? '';
		$parsedUri = is_string($redirectUri) ? parse_url($redirectUri) : false;
		if (($_GET['client_id'] ?? '') !== 'freshrss-capability' ||
			($_GET['response_type'] ?? '') !== 'code' ||
			!is_array($parsedUri) || ($parsedUri['scheme'] ?? '') !== 'http' ||
			($parsedUri['host'] ?? '') !== '127.0.0.1' || ($parsedUri['path'] ?? '') !== '/i/oidc/' ||
			!is_string($_GET['state'] ?? null) || !is_string($_GET['nonce'] ?? null)) {
			oidcSendJson(['error' => 'invalid_request'], 400);
			return;
		}
		$code = bin2hex(random_bytes(24));
		$grant = ['nonce' => $_GET['nonce'], 'redirect_uri' => $redirectUri,
			'bad_nonce' => isset($_GET['bad_nonce']), 'bad_signature' => isset($_GET['bad_signature'])];
		file_put_contents('/tmp/freshrss-capability-oidc-code-' . hash('sha256', $code), json_encode($grant, JSON_THROW_ON_ERROR));
		header('Location: ' . $redirectUri . '?' . http_build_query(['code' => $code, 'state' => $_GET['state']]), true, 302);
		return;
	}
	if ($path === '/oidc/token' && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
		$credentials = '';
		$authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
		if (is_string($authorization) && str_starts_with($authorization, 'Basic ')) {
			$credentials = base64_decode(substr($authorization, 6), true) ?: '';
		}
		[$clientId, $clientSecret] = array_pad(explode(':', $credentials, 2), 2, '');
		if ($clientId !== 'freshrss-capability' || $clientSecret !== 'freshrss-capability-secret' ||
			($_POST['grant_type'] ?? '') !== 'authorization_code' || !is_string($_POST['code'] ?? null)) {
			oidcSendJson(['error' => 'invalid_client'], 401);
			return;
		}
		$codeFile = '/tmp/freshrss-capability-oidc-code-' . hash('sha256', $_POST['code']);
		$grantJson = is_file($codeFile) ? file_get_contents($codeFile) : false;
		$grant = is_string($grantJson) ? json_decode($grantJson, true) : null;
		if (!is_array($grant) || ($grant['redirect_uri'] ?? '') !== ($_POST['redirect_uri'] ?? '')) {
			oidcSendJson(['error' => 'invalid_grant'], 400);
			return;
		}
		unlink($codeFile);
		$key = oidcSigningKey();
		if ($key === false) {
			oidcSendJson(['error' => 'server_error'], 500);
			return;
		}
		$issuedAt = time();
		$header = oidcBase64Url(json_encode(['typ' => 'JWT', 'alg' => 'RS256', 'kid' => 'freshrss-capability-key'], JSON_THROW_ON_ERROR));
		$claims = oidcBase64Url(json_encode([
			'iss' => $issuer,
			'sub' => 'capability-user',
			'aud' => 'freshrss-capability',
			'iat' => $issuedAt,
			'exp' => $issuedAt + 300,
			'nonce' => ($grant['bad_nonce'] ?? false) ? 'wrong-capability-nonce' : $grant['nonce'],
			'preferred_username' => 'capadmin',
		], JSON_THROW_ON_ERROR));
		$signature = '';
		if (!openssl_sign($header . '.' . $claims, $signature, $key, OPENSSL_ALGO_SHA256)) {
			oidcSendJson(['error' => 'server_error'], 500);
			return;
		}
		if ($grant['bad_signature'] ?? false) {
			$signature[0] = chr(ord($signature[0]) ^ 1);
		}
		oidcSendJson([
			'access_token' => bin2hex(random_bytes(16)),
			'token_type' => 'Bearer',
			'expires_in' => 300,
			'id_token' => $header . '.' . $claims . '.' . oidcBase64Url($signature),
		]);
		return;
	}
	if ($path === '/oidc/userinfo') {
		oidcSendJson(['sub' => 'capability-user', 'preferred_username' => 'capadmin']);
		return;
	}
	if ($path === '/oidc/logout') {
		$redirect = $_GET['post_logout_redirect_uri'] ?? '';
		$parsedRedirect = is_string($redirect) ? parse_url($redirect) : false;
		if (!is_array($parsedRedirect) || ($parsedRedirect['scheme'] ?? '') !== 'http' ||
			($parsedRedirect['host'] ?? '') !== '127.0.0.1' || ($parsedRedirect['path'] ?? '') !== '/themes/icons/FreshRSS-logo.svg') {
			oidcSendJson(['error' => 'invalid_request'], 400);
			return;
		}
		file_put_contents('/tmp/freshrss-capability-oidc-logout.json', json_encode([
			'post_logout_redirect_uri' => $redirect,
			'id_token_hint_present' => is_string($_GET['id_token_hint'] ?? null) && $_GET['id_token_hint'] !== '',
		], JSON_THROW_ON_ERROR));
		header('Location: ' . $redirect, true, 302);
		return;
	}
	if ($path === '/oidc/logout-state') {
		$state = @file_get_contents('/tmp/freshrss-capability-oidc-logout.json');
		oidcSendJson(is_string($state) ? (json_decode($state, true) ?: []) : []);
		return;
	}
	oidcSendJson(['error' => 'not_found'], 404);
	return;
}

if ($path === '/websub.xml') {
	$date = gmdate(DATE_RSS);
	header('Content-Type: application/rss+xml; charset=UTF-8');
	echo <<<XML
		<?xml version="1.0" encoding="UTF-8"?>
		<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
			<title>WebSub capability fixture</title><link>{$base}/</link><description>WebSub fixture</description>
			<atom:link rel="self" href="{$base}/websub.xml"/><atom:link rel="hub" href="{$base}/hub"/>
			<item><guid>websub-initial</guid><title>WebSub initial entry</title><link>{$base}/websub-initial</link><pubDate>{$date}</pubDate><description>Initial content</description></item>
		</channel></rss>
		XML;
	return;
}
if ($path === '/hub' && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
	$hub = [
		'mode' => $_POST['hub_mode'] ?? '',
		'verify' => $_POST['hub_verify'] ?? '',
		'topic' => $_POST['hub_topic'] ?? '',
		'callback' => $_POST['hub_callback'] ?? '',
	];
	file_put_contents('/tmp/freshrss-capability-websub.json', json_encode($hub, JSON_THROW_ON_ERROR));
	if ($hub['mode'] !== 'subscribe' || $hub['verify'] !== 'sync' || $hub['topic'] !== $base . '/websub.xml') {
		http_response_code(400);
		echo 'invalid hub request';
		return;
	}
	http_response_code(202);
	echo 'accepted';
	return;
}
if ($path === '/hub/state') {
	header('Content-Type: application/json');
	$state = @file_get_contents('/tmp/freshrss-capability-websub.json');
	echo is_string($state) ? $state : '{}';
	return;
}

if ($path === '/health') {
	header('Content-Type: application/json');
	echo '{"ready":true}';
	return;
}
if ($path === '/advance' && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
	file_put_contents($revisionFile, '2');
	header('Content-Type: application/json');
	echo '{"revision":2}';
	return;
}
if ($path === '/redirect-gzip') {
	header('Location: /gzip.xml', true, 302);
	return;
}
if ($path === '/atom.xml') {
	header('Content-Type: application/atom+xml; charset=UTF-8');
	$date = gmdate('c');
	echo <<<XML
		<?xml version="1.0" encoding="UTF-8"?>
		<feed xmlns="http://www.w3.org/2005/Atom">
			<title>Atom capability fixture</title><id>urn:freshrss:capabilities:atom</id>
			<link href="{$base}/"/><updated>{$date}</updated>
			<entry><id>urn:freshrss:capabilities:atom:1</id><title>Atom Café 東京</title>
				<link href="{$base}/atom-entry"/><updated>{$date}</updated>
				<content type="html">&lt;p&gt;Atom content café 東京&lt;/p&gt;</content>
			</entry>
		</feed>
		XML;
	return;
}
if ($path === '/rss.xml' || $path === '/gzip.xml') {
	$isGzip = $path === '/gzip.xml';
	$kind = $isGzip ? 'Gzip' : 'RSS';
	$date = gmdate(DATE_RSS);
	$entries = '';
	$count = !$isGzip && $revision === 2 ? 2 : 1;
	for ($i = 1; $i <= $count; $i++) {
		$title = $i === 2 ? 'RSS revision two' : $kind . ' Café 東京';
		$entries .= <<<XML
			<item><guid isPermaLink="false">capabilities-{$kind}-{$i}</guid>
				<title>{$title}</title><link>{$base}/{$kind}-{$i}</link><pubDate>{$date}</pubDate>
				<description>&lt;p&gt;{$kind} content café 東京&lt;/p&gt;</description>
			</item>
			XML;
	}
	$rss = <<<XML
		<?xml version="1.0" encoding="UTF-8"?>
		<rss version="2.0"><channel>
			<title>{$kind} capability fixture</title><link>{$base}/</link>
			<description>FreshRSS container capability tests</description><lastBuildDate>{$date}</lastBuildDate>
			{$entries}
		</channel></rss>
		XML;
	header('Content-Type: application/rss+xml; charset=UTF-8');
	header('Cache-Control: no-store');
	if ($isGzip) {
		header('Content-Encoding: gzip');
		echo gzencode($rss);
	} else {
		echo $rss;
	}
	return;
}
http_response_code(404);
echo 'Fixture not found';
