import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import type { Effort } from "@oh-my-striped-pi/pi-catalog/effort";
import {
	defaultSupportedEffort,
	mapEffortToAnthropicAdaptiveEffort,
	requireSupportedEffort,
	resolveWireModelId,
	withoutUnverifiedThinking,
} from "@oh-my-striped-pi/pi-catalog/model-thinking";
import { getProviderInFlightRoot, isEnoent, logger, untilAborted } from "@oh-my-striped-pi/pi-utils";
import { getCustomApi } from "./api-registry";
import {
	createAuthRetryKeyState,
	isApiKeyResolver,
	NO_AUTH_SENTINEL,
	resolvedApiKeyBearer,
	resolveNextAuthRetryKey,
} from "./auth-retry";
import type { OAuthRequestIdentity } from "./auth/types";
import { getEnvApiKey, resolveProviderApiKey } from "./env-api-key";
import * as AIError from "./error";
import { ProviderHttpError } from "./error";
import { isConcurrencyCapExclusion, isUsageLimitOutcome } from "./error/rate-limit";
import type { AnthropicOptions } from "./providers/anthropic";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import { streamPiNative } from "./providers/pi-native-client";
import {
	streamAnthropic,
	streamAppleFoundationModels,
	streamOllama,
	streamOpenAICompletions,
	streamOpenAIResponses,
} from "./providers/register-builtins";
import { getProviderDefinition } from "./registry";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	OptionsForApi,
	SimpleStreamOptions,
	StreamOptions,
	ToolChoice,
} from "./types";
import { resolveCacheRetention } from "./utils";
import { AssistantMessageEventStream } from "./utils/event-stream";
import { applyGlyphCodec } from "./utils/glyph-codec";
import { wrapLeakedThinkingStream } from "./utils/leaked-thinking-stream";
import { withThinkingLoopGuard } from "./utils/thinking-loop";
import { withTransportFetch } from "./utils/transport-fetch";

type ProviderInFlightLease = {
	path: string;
	stopHeartbeat: () => Promise<void>;
};

type ProviderInFlightLeaseInfo = {
	pid: number;
	timestamp: number;
	token: string;
};
type ProviderInFlightStaleLock = { token: string } | { mtimeMs: number };
type ProviderInFlightLockIdentity = { dev: number; ino: number; birthtimeMs: number };

const PROVIDER_INFLIGHT_LOCK_STALE_MS = 10_000;
const PROVIDER_INFLIGHT_LEASE_STALE_MS = 30_000;
const PROVIDER_INFLIGHT_HEARTBEAT_MS = 5_000;
const PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS = 250;
const PROVIDER_INFLIGHT_HEARTBEAT_FLUSH_TIMEOUT_MS = 1_000;
const PROVIDER_INFLIGHT_RELEASE_TIMEOUT_MS = 5_000;
const PROVIDER_INFLIGHT_LOCK_RETRY_INITIAL_MS = 25;
const PROVIDER_INFLIGHT_LOCK_RETRY_MAX_MS = 250;
const PROVIDER_INFLIGHT_LOCK_RETRY_BUDGET_MS = 3_000;

let configuredProviderMaxInFlightRequests: Record<string, number> = {};
let providerInFlightRootOverride: string | undefined;
let providerInFlightHeartbeatMsOverride: number | undefined;
let providerInFlightHeartbeatFlushTimeoutMsOverride: number | undefined;
let providerInFlightHeartbeatWriterOverride:
	| ((writeProviderInFlightInfo: () => Promise<void>) => Promise<void>)
	| undefined;
let providerInFlightLeaseRemoverOverride: ((leasePath: string) => Promise<void>) | undefined;
let providerInFlightWaitObserverOverride: ((provider: string) => void) | undefined;
let providerInFlightLockCreatedObserverOverride: ((lockDir: string) => Promise<void>) | undefined;
let providerInFlightLockIdentifiedObserverOverride: ((lockDir: string) => Promise<void>) | undefined;
let providerInFlightLockMkdirOverride: ((lockDir: string) => Promise<void>) | undefined;
let providerInFlightLockPlatformOverride: NodeJS.Platform | undefined;
let providerInFlightLockRetryTimings: { budgetMs?: number; initialDelayMs?: number; maxDelayMs?: number } | undefined;

export function configureProviderMaxInFlightRequests(limits: Record<string, number> | undefined): void {
	configuredProviderMaxInFlightRequests = limits ?? {};
}

function resolveProviderInFlightLimit(
	provider: string,
	options?: Pick<StreamOptions, "maxInFlightRequests">,
): number | undefined {
	const limits = options?.maxInFlightRequests ?? configuredProviderMaxInFlightRequests;
	const value = limits[provider];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.max(1, Math.floor(value));
}

function providerInFlightRoot(): string {
	if (providerInFlightRootOverride) return providerInFlightRootOverride;
	return getProviderInFlightRoot();
}

function providerInFlightSegment(provider: string): string {
	return Bun.SHA256.hash(provider, "base64url");
}

function providerInFlightDir(provider: string): string {
	return path.join(providerInFlightRoot(), providerInFlightSegment(provider));
}

function providerInFlightSignalPath(provider: string): string {
	return path.join(providerInFlightDir(provider), ".wakeup");
}

function providerInFlightLockDir(provider: string): string {
	return `${providerInFlightDir(provider)}.lock`;
}

// `process.kill(pid, 0)` may throw for permission/sandbox reasons even when a
// process exists. Treat non-ESRCH failures as alive; timestamp expiry still
// reaps leases whose heartbeat stopped.
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function readProviderInFlightInfo(infoPath: string): Promise<ProviderInFlightLeaseInfo | null> {
	try {
		const content = await fs.readFile(infoPath, "utf-8");
		const parsed = JSON.parse(content) as Partial<ProviderInFlightLeaseInfo>;
		if (typeof parsed.pid !== "number" || typeof parsed.timestamp !== "number" || typeof parsed.token !== "string") {
			return null;
		}
		return { pid: parsed.pid, timestamp: parsed.timestamp, token: parsed.token };
	} catch {
		return null;
	}
}

async function writeProviderInFlightInfo(dir: string, token: string): Promise<void> {
	const info: ProviderInFlightLeaseInfo = { pid: process.pid, timestamp: Date.now(), token };
	const infoPath = path.join(dir, "info.json");
	const tempPath = path.join(dir, `.info-${process.pid}-${crypto.randomUUID()}.tmp`);
	try {
		// Unlike Bun.write, fs.writeFile does not recreate a lease directory that
		// was removed while a timed-out heartbeat was still pending.
		await fs.writeFile(tempPath, JSON.stringify(info), "utf8");
		await fs.rename(tempPath, infoPath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

async function isProviderInFlightDirStale(dir: string, staleMs: number): Promise<boolean> {
	const info = await readProviderInFlightInfo(path.join(dir, "info.json"));
	if (info) {
		if (!isProcessAlive(info.pid)) return true;
		return Date.now() - info.timestamp > staleMs;
	}

	try {
		const stat = await fs.stat(path.join(dir, "info.json"));
		return Date.now() - stat.mtimeMs > staleMs;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	try {
		const stat = await fs.stat(dir);
		return Date.now() - stat.mtimeMs > staleMs;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function readProviderInFlightStaleLock(lockDir: string): Promise<ProviderInFlightStaleLock | null> {
	const infoPath = path.join(lockDir, "info.json");
	const info = await readProviderInFlightInfo(infoPath);
	if (info) return isProcessAlive(info.pid) ? null : { token: info.token };

	try {
		const stat = await fs.stat(lockDir);
		return Date.now() - stat.mtimeMs > PROVIDER_INFLIGHT_LOCK_STALE_MS ? { mtimeMs: stat.mtimeMs } : null;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function readProviderInFlightLockIdentity(lockDir: string): Promise<ProviderInFlightLockIdentity> {
	const stat = await fs.stat(lockDir);
	return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function isSameProviderInFlightLock(
	current: ProviderInFlightLockIdentity,
	expected: ProviderInFlightLockIdentity,
): boolean {
	if (current.dev !== expected.dev) return false;
	if (current.ino !== 0 || expected.ino !== 0) return current.ino === expected.ino;
	return current.birthtimeMs === expected.birthtimeMs;
}

async function releaseProviderInFlightStaleLock(lockDir: string, stale: ProviderInFlightStaleLock): Promise<void> {
	if ("token" in stale) {
		await releaseProviderInFlightLock(lockDir, stale.token);
		return;
	}

	const infoPath = path.join(lockDir, "info.json");
	if (await readProviderInFlightInfo(infoPath)) return;
	try {
		const stat = await fs.stat(lockDir);
		if (stat.mtimeMs !== stale.mtimeMs || Date.now() - stat.mtimeMs <= PROVIDER_INFLIGHT_LOCK_STALE_MS) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch {}
}

// Best-effort token-checked release. A token mismatch means another process has
// already replaced the lock, so the fresh lock must be left intact.
async function releaseProviderInFlightLock(lockDir: string, token: string): Promise<void> {
	try {
		const info = await readProviderInFlightInfo(path.join(lockDir, "info.json"));
		if (!info || info.token !== token) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch {}
}

async function releaseProviderInFlightLockDirIfSame(
	lockDir: string,
	identity: ProviderInFlightLockIdentity,
): Promise<void> {
	try {
		if (await readProviderInFlightInfo(path.join(lockDir, "info.json"))) return;
		const current = await readProviderInFlightLockIdentity(lockDir);
		if (!isSameProviderInFlightLock(current, identity)) return;
		await fs.rm(lockDir, { recursive: true, force: true });
	} catch {}
}

// On Windows, mkdir on a lock directory another process is concurrently deleting
// (delete-pending while a watcher, antivirus, or indexer still holds it) fails
// with ERROR_ACCESS_DENIED — mapped to EPERM/EACCES — instead of EEXIST, so
// ordinary contention looks like a permission error. On win32 only, back off and
// retry briefly; if the failure persists past the budget, rethrow the original
// error so a real permission problem still surfaces. Every other outcome
// (success, EEXIST, any other code) exits immediately, keeping non-win32 and
// non-transient behavior unchanged.
function isTransientProviderInFlightLockMkdirError(error: NodeJS.ErrnoException): boolean {
	if ((providerInFlightLockPlatformOverride ?? process.platform) !== "win32") return false;
	return error.code === "EPERM" || error.code === "EACCES";
}

async function mkdirProviderInFlightLockDir(lockDir: string, signal?: AbortSignal): Promise<void> {
	const mkdir = providerInFlightLockMkdirOverride ?? ((dir: string) => fs.mkdir(dir));
	let failures = 0;
	let since = Date.now();
	while (true) {
		try {
			await mkdir(lockDir);
			return;
		} catch (error) {
			if (!isTransientProviderInFlightLockMkdirError(error as NodeJS.ErrnoException)) throw error;
			const now = Date.now();
			if (failures === 0) since = now;
			const budgetMs = providerInFlightLockRetryTimings?.budgetMs ?? PROVIDER_INFLIGHT_LOCK_RETRY_BUDGET_MS;
			if (now - since >= budgetMs) throw error;
			const initialMs = providerInFlightLockRetryTimings?.initialDelayMs ?? PROVIDER_INFLIGHT_LOCK_RETRY_INITIAL_MS;
			const maxMs = providerInFlightLockRetryTimings?.maxDelayMs ?? PROVIDER_INFLIGHT_LOCK_RETRY_MAX_MS;
			const delayMs = Math.min(maxMs, initialMs * 2 ** failures);
			failures++;
			await untilAborted(signal, Bun.sleep(delayMs));
		}
	}
}

async function acquireProviderInFlightLock(provider: string, signal?: AbortSignal): Promise<() => Promise<void>> {
	const lockDir = providerInFlightLockDir(provider);
	await fs.mkdir(path.dirname(lockDir), { recursive: true });

	while (true) {
		if (signal?.aborted) throw signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch");
		try {
			await mkdirProviderInFlightLockDir(lockDir, signal);
			await providerInFlightLockCreatedObserverOverride?.(lockDir);
			let lockIdentity: ProviderInFlightLockIdentity;
			try {
				lockIdentity = await readProviderInFlightLockIdentity(lockDir);
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			const token = crypto.randomUUID();
			try {
				await providerInFlightLockIdentifiedObserverOverride?.(lockDir);
				await writeProviderInFlightInfo(lockDir, token);
			} catch (error) {
				await releaseProviderInFlightLockDirIfSame(lockDir, lockIdentity);
				if (isEnoent(error)) continue;
				throw error;
			}
			return async () => {
				await releaseProviderInFlightLock(lockDir, token);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		const staleLock = await readProviderInFlightStaleLock(lockDir);
		if (staleLock) {
			await releaseProviderInFlightStaleLock(lockDir, staleLock);
			await signalProviderInFlightWaiters(provider);
			continue;
		}

		await waitForProviderInFlightSignal(provider, signal);
	}
}

async function cleanupProviderInFlightLeases(providerDir: string): Promise<number> {
	let active = 0;
	let entries: string[];
	try {
		entries = await fs.readdir(providerDir);
	} catch (error) {
		if (isEnoent(error)) return 0;
		throw error;
	}

	for (const entry of entries) {
		const leaseDir = path.join(providerDir, entry);
		let isDirectory = false;
		try {
			isDirectory = (await fs.stat(leaseDir)).isDirectory();
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
		if (!isDirectory) continue;
		if (await isProviderInFlightDirStale(leaseDir, PROVIDER_INFLIGHT_LEASE_STALE_MS)) {
			await fs.rm(leaseDir, { recursive: true, force: true });
			continue;
		}
		active++;
	}
	return active;
}

async function tryAcquireProviderInFlightLease(
	provider: string,
	limit: number,
	signal?: AbortSignal,
): Promise<ProviderInFlightLease | null> {
	const releaseLock = await acquireProviderInFlightLock(provider, signal);
	try {
		const dir = providerInFlightDir(provider);
		await fs.mkdir(dir, { recursive: true });
		const active = await cleanupProviderInFlightLeases(dir);
		if (active >= limit) return null;

		const leaseDir = path.join(dir, `${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
		const token = crypto.randomUUID();
		try {
			await fs.mkdir(leaseDir);
			await writeProviderInFlightInfo(leaseDir, token);
		} catch (error) {
			await removeProviderInFlightLeaseDir(leaseDir).catch(() => {});
			throw error;
		}
		let heartbeatActive = true;
		let heartbeatFlush = Promise.resolve();
		const touchHeartbeat = () => {
			if (!heartbeatActive) return;
			heartbeatFlush = heartbeatFlush
				.then(async () => {
					if (!heartbeatActive) return;
					const write = () => {
						if (!heartbeatActive) return Promise.resolve();
						return writeProviderInFlightInfo(leaseDir, token);
					};
					if (providerInFlightHeartbeatWriterOverride) {
						await providerInFlightHeartbeatWriterOverride(write);
					} else {
						await write();
					}
				})
				.catch(() => {});
		};
		const heartbeat = setInterval(
			touchHeartbeat,
			providerInFlightHeartbeatMsOverride ?? PROVIDER_INFLIGHT_HEARTBEAT_MS,
		);
		heartbeat.unref?.();
		return {
			path: leaseDir,
			stopHeartbeat: () => {
				heartbeatActive = false;
				clearInterval(heartbeat);
				return heartbeatFlush;
			},
		};
	} finally {
		await releaseLock();
	}
}

async function signalProviderInFlightWaitersInDir(dir: string): Promise<void> {
	try {
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, ".wakeup"), String(Date.now()));
	} catch {}
}

async function signalProviderInFlightWaiters(provider: string): Promise<void> {
	await signalProviderInFlightWaitersInDir(providerInFlightDir(provider));
}

function waitForProviderInFlightSignal(provider: string, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted)
		return Promise.reject(signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch"));
	const signalPath = providerInFlightSignalPath(provider);
	providerInFlightWaitObserverOverride?.(provider);
	const waitStarted = Date.now();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	let watcher: fsSync.FSWatcher | undefined;
	const timer = setTimeout(() => finish(resolve), PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS);
	const finish = (settle: () => void) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		watcher?.close();
		signal?.removeEventListener("abort", onAbort);
		settle();
	};
	const onAbort = () => {
		finish(() => reject(signal?.reason ?? new AIError.AbortError("Provider request aborted before dispatch")));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		watcher = fsSync.watch(providerInFlightDir(provider), (_event, filename) => {
			if (filename === ".wakeup" || filename === null) {
				finish(resolve);
			}
		});
		void fs.stat(signalPath).then(
			stat => {
				if (stat.mtimeMs >= waitStarted) finish(resolve);
			},
			error => {
				if (!isEnoent(error)) finish(resolve);
			},
		);
	} catch {
		// Filesystem notifications are best-effort across platforms; the fallback
		// timer keeps stale-lock/lease cleanup progressing if an event is dropped.
	}
	return promise;
}

async function removeProviderInFlightLeaseDir(leasePath: string): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await fs.rm(leasePath, { recursive: true, force: true });
			return;
		} catch (error) {
			if (isEnoent(error)) return;
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt < 2 && (code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM")) {
				await Bun.sleep(25);
				continue;
			}
			throw error;
		}
	}
}

// Signal into the lease's OWN provider directory (derived from `lease.path`)
// rather than recomputing it from the current root. A release that lands after
// the in-flight root has been repointed (only the test seam does that) must not
// write `.wakeup` into an unrelated provider directory.
async function releaseProviderInFlightLease(lease: ProviderInFlightLease): Promise<void> {
	const heartbeatFlush = lease.stopHeartbeat();
	const flushTimeout = Promise.withResolvers<"timeout">();
	const flushTimer = setTimeout(
		() => flushTimeout.resolve("timeout"),
		providerInFlightHeartbeatFlushTimeoutMsOverride ?? PROVIDER_INFLIGHT_HEARTBEAT_FLUSH_TIMEOUT_MS,
	);
	flushTimer.unref?.();
	try {
		const outcome = await Promise.race([heartbeatFlush.then(() => "flushed" as const), flushTimeout.promise]);
		if (outcome === "timeout") {
			logger.warn("Provider in-flight heartbeat flush timed out; forcing lease cleanup", { path: lease.path });
		}
	} finally {
		clearTimeout(flushTimer);
	}

	const releaseTimeout = Promise.withResolvers<never>();
	const releaseTimer = setTimeout(
		() => releaseTimeout.reject(new Error("Provider in-flight lease cleanup timed out")),
		PROVIDER_INFLIGHT_RELEASE_TIMEOUT_MS,
	);
	releaseTimer.unref?.();
	try {
		const removeLease = providerInFlightLeaseRemoverOverride ?? removeProviderInFlightLeaseDir;
		await Promise.race([removeLease(lease.path), releaseTimeout.promise]);
	} finally {
		clearTimeout(releaseTimer);
	}
	// Wake-up is an optimization: waiters also poll every 250 ms. Do not let a
	// notification-file stall keep a completed provider request open.
	void signalProviderInFlightWaitersInDir(path.dirname(lease.path));
}

async function acquireProviderInFlightSlot(
	provider: string,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	if (limit === undefined) return async () => {};
	let loggedWait = false;
	while (true) {
		if (signal?.aborted) throw signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch");
		const lease = await tryAcquireProviderInFlightLease(provider, limit, signal);
		if (lease) return () => releaseProviderInFlightLease(lease);
		if (!loggedWait) {
			loggedWait = true;
			logger.debug("Provider in-flight limit blocked request", { provider, limit });
		}
		await waitForProviderInFlightSignal(provider, signal);
	}
}

export const __providerInFlightForTesting = {
	setRoot(root: string | undefined): void {
		providerInFlightRootOverride = root;
	},
	setHeartbeatTimings(timings: { heartbeatMs?: number; heartbeatFlushTimeoutMs?: number } | undefined): void {
		providerInFlightHeartbeatMsOverride = timings?.heartbeatMs;
		providerInFlightHeartbeatFlushTimeoutMsOverride = timings?.heartbeatFlushTimeoutMs;
	},
	setHeartbeatWriter(writer: ((writeProviderInFlightInfo: () => Promise<void>) => Promise<void>) | undefined): void {
		providerInFlightHeartbeatWriterOverride = writer;
	},
	setLeaseRemover(remover: ((leasePath: string) => Promise<void>) | undefined): void {
		providerInFlightLeaseRemoverOverride = remover;
	},
	setWaitObserver(observer: ((provider: string) => void) | undefined): void {
		providerInFlightWaitObserverOverride = observer;
	},
	setLockCreatedObserver(observer: ((lockDir: string) => Promise<void>) | undefined): void {
		providerInFlightLockCreatedObserverOverride = observer;
	},
	setLockIdentifiedObserver(observer: ((lockDir: string) => Promise<void>) | undefined): void {
		providerInFlightLockIdentifiedObserverOverride = observer;
	},
	setLockMkdirOverride(mkdir: ((lockDir: string) => Promise<void>) | undefined): void {
		providerInFlightLockMkdirOverride = mkdir;
	},
	setLockPlatformOverride(platform: NodeJS.Platform | undefined): void {
		providerInFlightLockPlatformOverride = platform;
	},
	setLockRetryTimings(timings: { budgetMs?: number; initialDelayMs?: number; maxDelayMs?: number } | undefined): void {
		providerInFlightLockRetryTimings = timings;
	},
	providerDir(provider: string): string {
		return providerInFlightDir(provider);
	},
	lockDir(provider: string): string {
		return providerInFlightLockDir(provider);
	},
	async captureStaleLockRelease(provider: string): Promise<(() => Promise<void>) | null> {
		const lockDir = providerInFlightLockDir(provider);
		const stale = await readProviderInFlightStaleLock(lockDir);
		if (!stale) return null;
		return () => releaseProviderInFlightStaleLock(lockDir, stale);
	},
	async captureLockDirRelease(provider: string): Promise<(() => Promise<void>) | null> {
		const lockDir = providerInFlightLockDir(provider);
		try {
			const identity = await readProviderInFlightLockIdentity(lockDir);
			return () => releaseProviderInFlightLockDirIfSame(lockDir, identity);
		} catch {
			return null;
		}
	},
};

function withProviderInFlightLimit<TOptions extends Pick<StreamOptions, "signal" | "maxInFlightRequests">>(
	model: Model<Api>,
	options: TOptions | undefined,
	dispatch: (limited: boolean) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	// Heal at the shared dispatch boundary so the outer loop guard sees healed events.
	const limit = resolveProviderInFlightLimit(model.provider, options);
	if (limit === undefined) return wrapLeakedThinkingStream(dispatch(false));

	const outer = new AssistantMessageEventStream();
	void (async () => {
		let release: (() => Promise<void>) | undefined;
		let releasePromise: Promise<void> | undefined;
		const releaseOnce = () => {
			if (!release) return Promise.resolve();
			releasePromise ??= release();
			return releasePromise;
		};
		const releaseBestEffort = async () => {
			try {
				await releaseOnce();
			} catch (releaseError) {
				// The lease has stopped heartbeating and stale cleanup will reap it
				// within PROVIDER_INFLIGHT_LEASE_STALE_MS. Until then, its slot may
				// remain unavailable and waiters rely on the fallback poll.
				// Never replace a completed response or the provider's original error
				// with a coordination-directory cleanup failure.
				logger.warn("Provider in-flight permit release failed", {
					provider: model.provider,
					error: String(releaseError),
				});
			}
		};
		try {
			const startedWaitingAt = Date.now();
			release = await acquireProviderInFlightSlot(model.provider, limit, options?.signal);
			if (Date.now() - startedWaitingAt >= PROVIDER_INFLIGHT_SIGNAL_FALLBACK_MS) {
				logger.debug("Provider in-flight limit wait completed", { provider: model.provider, limit });
			}
			if (options?.signal?.aborted) {
				throw options.signal.reason ?? new AIError.AbortError("Provider request aborted before dispatch");
			}
			const inner = wrapLeakedThinkingStream(dispatch(true));
			let terminalEvent: AssistantMessageEvent | undefined;
			for await (const event of inner) {
				if (event.type === "done" || event.type === "error") {
					terminalEvent = event;
					break;
				}
				outer.push(event);
				if (outer.done) {
					await releaseBestEffort();
					return;
				}
			}
			const result = await inner.result();
			// Releasing the permit is part of request completion. Publishing the
			// result first lets an immediate follow-up turn contend with its own
			// still-live lease, which is particularly costly on Windows.
			await releaseBestEffort();
			if (!outer.done) {
				if (terminalEvent) outer.push(terminalEvent);
				else outer.end(result);
			}
		} catch (error) {
			await releaseBestEffort();
			if (!outer.done) outer.fail(error);
		}
	})();
	return outer;
}

function withResolvedModelHeaders<TApi extends Api>(
	model: Model<TApi>,
	signal: AbortSignal | undefined,
	run: (resolvedModel: Model<TApi>) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const resolveHeaders = model.resolveHeaders;
	if (!resolveHeaders) return run(model);

	const outer = new AssistantMessageEventStream();
	void (async () => {
		try {
			const headers = await untilAborted(signal, () => resolveHeaders(signal));
			signal?.throwIfAborted();
			const inner = run({ ...model, resolveHeaders: undefined, headers: headers ? { ...headers } : undefined });
			for await (const event of inner) {
				outer.push(event);
				if (outer.done) return;
			}
			if (!outer.done) outer.end(await inner.result());
		} catch (error) {
			outer.fail(error);
		}
	})();
	return outer;
}

/** Reject unknown protocols and missing HTTP targets before credential/header side effects. */
function assertExecutableModel(model: Model<Api>): void {
	if (!model.provider.trim() || !model.id.trim()) {
		throw new AIError.ConfigurationError("Model provider and id must be nonempty");
	}
	if (
		(model.provider === "local" && model.api !== "local-inference") ||
		(model.provider === "github-copilot" &&
			model.api !== "anthropic-messages" &&
			model.api !== "openai-completions" &&
			model.api !== "openai-responses")
	) {
		throw new AIError.ConfigurationError(`Unsupported API ${model.api} for model provider ${model.provider}`);
	}
	if (model.transport === "pi-native" || getCustomApi(model.api)) return;
	switch (model.api) {
		case "anthropic-messages":
		case "openai-completions":
		case "openai-responses":
		case "ollama-chat":
			if (model.provider !== "github-copilot" && !model.baseUrl?.trim()) {
				throw new AIError.ConfigurationError(`${model.api} requires an explicit base URL`);
			}
			return;
		case "apple-foundation-models":
			return;
		default:
			throw new AIError.ConfigurationError(`Unhandled API: ${model.api}`);
	}
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	assertExecutableModel(model);
	if (model.resolveHeaders) {
		return withResolvedModelHeaders(model, options?.signal, resolvedModel => stream(resolvedModel, context, options));
	}
	if (!model.requiresGlyphTokenization) {
		return withThinkingLoopGuard(model, options, opts =>
			withProviderInFlightLimit(model, opts, limited => streamDispatch(model, context, opts, limited)),
		);
	}
	const codec = applyGlyphCodec(context);
	return codec.wrap(
		withThinkingLoopGuard(model, options, opts =>
			withProviderInFlightLimit(model, opts, limited => streamDispatch(model, codec.context, opts, limited)),
		),
	);
}

function streamDispatch<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: OptionsForApi<TApi> | undefined,
	limited: boolean,
): AssistantMessageEventStream {
	const requestOptions = withSupportedSamplingParams(
		model,
		withTransportFetch(model, (options || {}) as StreamOptions),
	) as OptionsForApi<TApi>;
	assertExplicitOpenAIResponsesPromptCacheSupport(model, requestOptions);

	// The on-device inference transport is registered by the coding-agent host.
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return customApiProvider.stream(model, context, { ...requestOptions, waitForTerminalDrain: limited });
	}

	const providerDefinition = getProviderDefinition(model.provider);
	const requestModel = providerDefinition?.prepareModel?.(model) ?? model;
	const prepared = providerDefinition?.prepareRequest?.(requestModel, requestOptions as StreamOptions);
	const providerModel = prepared?.model ?? requestModel;
	assertExecutableModel(providerModel);
	const preparedOptions = prepared?.options ?? (requestOptions as StreamOptions);
	const apiKey = resolveProviderApiKey(providerModel.provider, preparedOptions.apiKey);
	if (!apiKey && !providerDefinition?.allowsMissingApiKey) {
		throw new AIError.MissingApiKeyError(providerModel.provider);
	}
	const providerOptions = { ...preparedOptions, apiKey: apiKey ?? NO_AUTH_SENTINEL };
	const api: Api = providerModel.api;
	switch (api) {
		case "anthropic-messages": {
			return streamAnthropic(
				providerModel as Model<"anthropic-messages">,
				context,
				providerOptions as AnthropicOptions,
			);
		}

		case "openai-completions":
			return streamOpenAICompletions(providerModel as Model<"openai-completions">, context, {
				...(providerOptions as OpenAICompletionsOptions),
				waitForTerminalDrain: limited,
			});

		case "openai-responses":
			return streamOpenAIResponses(
				providerModel as Model<"openai-responses">,
				context,
				providerOptions as OptionsForApi<"openai-responses">,
			);

		case "ollama-chat":
			return streamOllama(providerModel as Model<"ollama-chat">, context, providerOptions);

		case "apple-foundation-models":
			return streamAppleFoundationModels(
				providerModel as Model<"apple-foundation-models">,
				context,
				providerOptions,
			);

		default:
			throw new AIError.ConfigurationError(`Unhandled API: ${api}`);
	}
}

/** Maximum guarded attempts for a detected thinking loop. */
const THINKING_LOOP_MAX_ATTEMPTS = 3;
const THINKING_LOOP_RETRY_BASE_DELAY_MS = 500;
const THINKING_LOOP_RETRY_MAX_DELAY_MS = 8_000;

function isRetryableThinkingLoop(message: AssistantMessage): boolean {
	return (
		message.stopReason === "error" &&
		message.content.length === 0 &&
		AIError.is(message.errorId, AIError.Flag.ThinkingLoop)
	);
}

/**
 * Resolve a completion, re-sampling a thinking-loop stall for at most
 * {@link THINKING_LOOP_MAX_ATTEMPTS} guarded attempts. The loop guard raises an
 * empty `stopReason: "error"` stall; after the budget is spent that error is
 * returned unchanged. Detection is never disabled as a fallback, because an
 * unguarded retry can consume the remaining output budget and persist runaway
 * content. Non-stall results, including genuine errors, return immediately. A
 * caller abort during backoff propagates so cancellation surfaces as an abort,
 * never a stale stall result.
 */
async function resolveWithThinkingLoopRetries(
	signal: AbortSignal | undefined,
	dispatch: () => AssistantMessageEventStream,
	onAttempt?: (message: AssistantMessage) => void,
): Promise<AssistantMessage> {
	const dispatchAttempt = async (): Promise<AssistantMessage> => {
		const response = dispatch();
		for await (const _event of response) {
			// Completion callers do not consume deltas; drain them as they arrive to avoid retaining the response history.
		}
		const message = await response.result();
		onAttempt?.(message);
		return message;
	};
	let message = await dispatchAttempt();
	let thinkingLoopRetry = isRetryableThinkingLoop(message);
	for (let attempt = 1; thinkingLoopRetry && attempt < THINKING_LOOP_MAX_ATTEMPTS; attempt += 1) {
		// A caller abort surfaces as a thrown abort (never the stall, which would
		// misclassify as a 502): throwIfAborted before backoff, and scheduler.wait
		// rejects if the abort lands mid-delay.
		signal?.throwIfAborted();
		const delay = Math.min(THINKING_LOOP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), THINKING_LOOP_RETRY_MAX_DELAY_MS);
		await scheduler.wait(delay, { signal });
		message = await dispatchAttempt();
		thinkingLoopRetry = isRetryableThinkingLoop(message);
	}
	if (thinkingLoopRetry) signal?.throwIfAborted();
	return message;
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): Promise<AssistantMessage> {
	return resolveWithThinkingLoopRetries(options?.signal, () => stream(model, context, options));
}

type AuthRetryFailure = {
	error: unknown;
	bufferedEvents: AssistantMessageEvent[];
	terminalEvent?: Extract<AssistantMessageEvent, { type: "error" }>;
};

function extractStatusFromAssistantError(message: AssistantMessage): number | undefined {
	if (message.errorStatus !== undefined) return message.errorStatus;
	if (!message.errorMessage) return undefined;
	return AIError.status({ message: message.errorMessage });
}

function isRetryableUpstreamError(error: unknown, status: number | undefined, message: string | undefined): boolean {
	if (AIError.isAuthRetryableError(error)) return true;
	// Rotate accounts for credential/access failures and exhausted usage, not transient concurrency caps.
	if (status === 401 || (status === 403 && !isConcurrencyCapExclusion(status, message))) return true;
	return isUsageLimitOutcome(status, message);
}

function createAssistantAuthError(message: AssistantMessage): Error {
	const text = message.errorMessage ?? "Provider authentication failed";
	const status = extractStatusFromAssistantError(message);
	const error =
		status === undefined
			? new AIError.ProviderResponseError(text, { kind: "runtime" })
			: new ProviderHttpError(text, status);
	return typeof message.errorId === "number" ? AIError.attach(error, message.errorId) : error;
}

function emitBufferedEvents(stream: AssistantMessageEventStream, events: AssistantMessageEvent[]): void {
	for (const event of events) {
		stream.push(event);
	}
}
function withInferenceSessionId(options?: SimpleStreamOptions): SimpleStreamOptions {
	if (options?.sessionId) return options;
	return { ...options, sessionId: crypto.randomUUID() };
}

type SamplingOptions = Pick<
	StreamOptions,
	"temperature" | "topP" | "topK" | "minP" | "presencePenalty" | "repetitionPenalty" | "frequencyPenalty"
>;

/**
 * Drop explicit sampling parameters before any provider builds its payload
 * when the model's resolved `compat.supportsSamplingParams` is `false`. The
 * catalog's class rules assign that per model lineage on every compat record,
 * and an explicit compat override still wins, so this one check covers every
 * provider.
 */
function withSupportedSamplingParams<T extends SamplingOptions>(model: Model<Api>, options: T): T {
	if (
		options.temperature === undefined &&
		options.topP === undefined &&
		options.topK === undefined &&
		options.minP === undefined &&
		options.presencePenalty === undefined &&
		options.repetitionPenalty === undefined &&
		options.frequencyPenalty === undefined
	) {
		return options;
	}
	const compat = model.compat;
	if (!compat || !("supportsSamplingParams" in compat) || compat.supportsSamplingParams !== false) return options;
	const supported = { ...options };
	delete supported.temperature;
	delete supported.topP;
	delete supported.topK;
	delete supported.minP;
	delete supported.presencePenalty;
	delete supported.repetitionPenalty;
	delete supported.frequencyPenalty;
	return supported;
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	assertExecutableModel(model);
	const sessionOptions = withInferenceSessionId(options);
	// Unverified thinking is opt-in: without a requested effort the request is
	// byte-identical to a non-reasoning model's.
	const effortRequested =
		sessionOptions.reasoning !== undefined && !sessionOptions.disableReasoning && !sessionOptions.forceReasoningOff;
	if (!effortRequested) model = withoutUnverifiedThinking(model);
	if (!model.requiresGlyphTokenization) {
		return streamSimpleRequest(model, context, sessionOptions);
	}
	const codec = applyGlyphCodec(context);
	return codec.wrap(streamSimpleRequest(model, codec.context, sessionOptions));
}

function streamSimpleRequest<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const requestOptions = withSupportedSamplingParams(
		model,
		withTransportFetch(model, (options || {}) as SimpleStreamOptions),
	);

	const apiKeyResolver = isApiKeyResolver(requestOptions?.apiKey) ? requestOptions.apiKey : undefined;
	if (apiKeyResolver) {
		const outer = new AssistantMessageEventStream();
		const signal = requestOptions?.signal;
		// One inner attempt against a resolved key, or against the Bedrock AWS
		// credential chain when its optional resolver has no stored bearer key.
		// Retryable auth failures are buffered until replay is safe.
		const runAttempt = async (
			apiKey?: string,
			credentialId?: number,
			oauthIdentity?: OAuthRequestIdentity,
		): Promise<AuthRetryFailure | undefined> => {
			const bufferedEvents: AssistantMessageEvent[] = [];
			let emittedReplayUnsafeEvent = false;
			const flushBuffered = (): void => {
				emitBufferedEvents(outer, bufferedEvents);
				bufferedEvents.length = 0;
			};

			try {
				const attemptOptions = { ...requestOptions, apiKey, credentialId, oauthIdentity };
				const inner = streamSimpleRequest(model, context, attemptOptions);
				for await (const event of inner) {
					if (credentialId !== undefined) {
						if ("partial" in event) event.partial.credentialId = credentialId;
						else if (event.type === "done") event.message.credentialId = credentialId;
						else event.error.credentialId = credentialId;
					}
					if (!emittedReplayUnsafeEvent && event.type === "start") {
						bufferedEvents.push(event);
						continue;
					}
					if (
						!emittedReplayUnsafeEvent &&
						event.type === "error" &&
						isRetryableUpstreamError(
							event.error,
							extractStatusFromAssistantError(event.error),
							event.error.errorMessage,
						)
					) {
						return {
							error: createAssistantAuthError(event.error),
							bufferedEvents,
							terminalEvent: event,
						};
					}
					flushBuffered();
					emittedReplayUnsafeEvent = true;
					outer.push(event);
					if (outer.done) return undefined;
				}
				flushBuffered();
				if (!outer.done) {
					const result = await inner.result();
					if (credentialId !== undefined) result.credentialId = credentialId;
					outer.end(result);
				}
			} catch (error) {
				if (
					!emittedReplayUnsafeEvent &&
					isRetryableUpstreamError(
						error,
						AIError.status(error),
						error instanceof Error ? error.message : undefined,
					)
				) {
					return { error, bufferedEvents };
				}
				flushBuffered();
				outer.fail(error);
			}
			return undefined;
		};
		const emitFailure = (failure: AuthRetryFailure): void => {
			emitBufferedEvents(outer, failure.bufferedEvents);
			if (failure.terminalEvent) {
				outer.push(failure.terminalEvent);
			} else {
				outer.fail(failure.error);
			}
		};

		void (async () => {
			let lastKey: string | undefined;
			let credentialId: number | undefined;
			let oauthIdentity: OAuthRequestIdentity | undefined;
			try {
				const resolved = await apiKeyResolver({ lastChance: false, error: undefined, signal });
				lastKey = resolvedApiKeyBearer(resolved);
				credentialId = typeof resolved === "string" ? undefined : resolved?.credentialId;
				oauthIdentity = typeof resolved === "string" ? undefined : resolved?.oauthIdentity;
			} catch (error) {
				// A thrown resolver is a broker/OAuth/network failure, not a missing
				// key — surface the cause instead of masking it as "No API key".
				outer.fail(
					new AIError.ConfigurationError(
						`Failed to resolve API key for provider ${model.provider}: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					),
				);
				return;
			}
			if (lastKey === undefined) {
				if (getCustomApi(model.api) || getProviderDefinition(model.provider)?.allowsMissingApiKey) {
					const failure = await runAttempt();
					if (failure) emitFailure(failure);
					return;
				}
				outer.fail(new AIError.MissingApiKeyError(model.provider));
				return;
			}
			const retryState = createAuthRetryKeyState(lastKey);
			let failure = await runAttempt(lastKey, credentialId, oauthIdentity);
			if (!failure) return;
			while (true) {
				// Caller aborted between attempts: don't mint a fresh token or fire
				// another doomed request — emit the captured failure instead.
				if (signal?.aborted) break;
				let nextCredentialId: number | undefined;
				let nextOAuthIdentity: OAuthRequestIdentity | undefined;
				const nextKey = await resolveNextAuthRetryKey(
					retryState,
					apiKeyResolver,
					failure.error,
					signal,
					resolved => {
						nextCredentialId = typeof resolved === "string" ? undefined : resolved?.credentialId;
						nextOAuthIdentity = typeof resolved === "string" ? undefined : resolved?.oauthIdentity;
					},
				);
				if (nextKey === undefined) break;
				const next = await runAttempt(nextKey, nextCredentialId, nextOAuthIdentity);
				if (!next) return;
				failure = next;
			}
			emitFailure(failure);
		})();
		return outer;
	}

	if (model.resolveHeaders) {
		return withResolvedModelHeaders(model, requestOptions.signal, resolvedModel =>
			streamSimpleRequest(resolvedModel, context, requestOptions),
		);
	}

	// Pi-native transport short-circuits the per-provider dispatch entirely:
	// the gateway resolves provider + credential server-side, so we don't
	// need an `apiKey` from `getEnvApiKey` here — `options.apiKey` carries
	// the gateway bearer instead. Comes BEFORE the custom-API check so
	// extension-registered APIs can't accidentally override a configured
	// pi-native transport.
	if (model.transport === "pi-native") {
		return withThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, () => streamPiNative(model, context, opts)),
		);
	}

	// Check custom API registry (extension-provided APIs)
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return withThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, limited =>
				customApiProvider.streamSimple(model, context, { ...opts, waitForTerminalDrain: limited }),
			),
		);
	}

	if (getProviderDefinition(model.provider)?.allowsMissingApiKey) {
		const providerOptions = mapOptionsForApi(
			model,
			requestOptions,
			typeof requestOptions.apiKey === "string" ? requestOptions.apiKey : getEnvApiKey(model.provider),
		);
		return stream(model, context, providerOptions);
	}

	// The resolver form is handled by the wrapper above; only a static string
	// key reaches this point.
	const apiKey =
		(typeof requestOptions?.apiKey === "string" ? requestOptions.apiKey : undefined) || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(model.provider);
	}

	const providerModel = getProviderDefinition(model.provider)?.prepareModel?.(model) ?? model;
	const providerOptions = mapOptionsForApi(providerModel, requestOptions, apiKey);
	return stream(providerModel, context, providerOptions);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions & {
		/** Receives every completed result, including results retried by the thinking-loop guard. */
		onAttempt?: (message: AssistantMessage) => void;
	},
): Promise<AssistantMessage> {
	const { onAttempt, ...streamOptions } = options ?? {};
	const sessionOptions = withInferenceSessionId(streamOptions);
	return resolveWithThinkingLoopRetries(
		options?.signal,
		() => streamSimple(model, context, sessionOptions),
		onAttempt,
	);
}

// Fallback total output cap for models whose catalog entry has no maxTokens.
const OUTPUT_CAP_WHEN_UNKNOWN = 64_000;
function maxTokensWithThinkingBudget(
	baseMaxTokens: number | undefined,
	modelMaxTokens: number | null,
	thinkingBudget: number,
): number {
	const uncappedMaxTokens = baseMaxTokens === undefined ? OUTPUT_CAP_WHEN_UNKNOWN : baseMaxTokens + thinkingBudget;
	return Math.min(uncappedMaxTokens, modelMaxTokens ?? Number.POSITIVE_INFINITY);
}
export const OUTPUT_FALLBACK_BUFFER = 4000;
const ANTHROPIC_USE_INTERLEAVED_THINKING = Bun.env.OMSP_NO_INTERLEAVED_THINKING !== "1";

export const ANTHROPIC_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: 32768,
};

export function mapAnthropicToolChoice(choice?: ToolChoice): AnthropicOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "tool", name: choice.name } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "tool", name } : undefined;
	}
	return undefined;
}

function mapOpenAiToolChoice(choice?: ToolChoice): OpenAICompletionsOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "function", function: { name: choice.name } } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "function", function: { name } } : undefined;
	}
	return undefined;
}

type ReasoningEffortMapCompat = {
	reasoningEffortMap?: Partial<Record<Effort, string>>;
};

function getCompatReasoningEffortMap<TApi extends Api>(
	model: Model<TApi>,
): Partial<Record<Effort, string>> | undefined {
	const compat = model.compat;
	if (compat === undefined || typeof compat !== "object" || !("reasoningEffortMap" in compat)) {
		return undefined;
	}
	return (compat as ReasoningEffortMapCompat).reasoningEffortMap;
}

function resolveSupportedMappedReasoningEffort<TApi extends Api>(
	model: Model<TApi>,
	reasoning: Effort,
): Effort | undefined {
	const mapped = getCompatReasoningEffortMap(model)?.[reasoning];
	if (!mapped) return undefined;
	const mappedEffort = mapped as Effort;
	return model.thinking?.efforts.includes(mappedEffort) ? mappedEffort : undefined;
}

function resolveOpenAiReasoningEffort<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
): Effort | undefined {
	const reasoning = options?.reasoning;
	if (!reasoning || !model.reasoning) return undefined;
	// Models that reason natively but expose no effort dial carry
	// `thinking: undefined` (baked at build time from
	// `compat.supportsReasoningEffort: false` on openai-responses*). The
	// wire-side omitReasoningEffort gate (stream.ts) is the actual strip; returning
	// undefined here avoids a redundant requireSupportedEffort throw that would
	// defeat the gate and surface a confusing "Compaction failed: Thinking effort
	// high is not supported by..." to the user.
	if (!model.thinking) return undefined;
	if (model.thinking.efforts.includes(reasoning)) return reasoning;
	const mappedReasoning = resolveSupportedMappedReasoningEffort(model, reasoning);
	if (mappedReasoning) return mappedReasoning;
	if (getCompatReasoningEffortMap(model)?.[reasoning] !== undefined) return reasoning;
	if (model.thinking.effortMap?.[reasoning] !== undefined) return reasoning;
	return requireSupportedEffort(model, reasoning);
}

const castApi = <TApi extends Api>(api: OptionsForApi<TApi>): OptionsForApi<Api> => api as OptionsForApi<Api>;

/**
 * Mandatory-reasoning endpoints (`thinking.requiresEffort`) reject disabled
 * or omitted thinking ("Reasoning is mandatory for this endpoint and cannot
 * be disabled") — clamp to the lowest supported effort instead.
 * `suppressWhenOff` models handle off provider-side via explicit wire
 * suppression. Collapsed pairs interplay: pair derivation strips member
 * flags (off routes to a bare SKU that CAN disable), while identity backfill
 * re-flags pairs whose logical id is itself mandatory (Gemini 3.x) — there
 * the clamp wins and the floored effort routes to the thinking SKU.
 */
function normalizeMandatoryReasoningOptions<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
): SimpleStreamOptions | undefined {
	if (
		!model.reasoning ||
		!model.thinking?.requiresEffort ||
		model.thinking.suppressWhenOff ||
		(options?.reasoning !== undefined && !options.disableReasoning && !options.forceReasoningOff)
	) {
		return options;
	}
	const floor = defaultSupportedEffort(model);
	if (floor === undefined) return options;
	return { ...options, reasoning: floor, disableReasoning: undefined, forceReasoningOff: undefined };
}

function supportsExplicitOpenAIResponsesPromptCache(compat: unknown): boolean {
	return (
		typeof compat === "object" &&
		compat !== null &&
		"supportsPromptCacheBreakpoints" in compat &&
		compat.supportsPromptCacheBreakpoints === true
	);
}

function assertExplicitOpenAIResponsesPromptCacheSupport<TApi extends Api>(
	model: Model<TApi>,
	options?: StreamOptions,
): void {
	if (
		model.transport === "pi-native" ||
		resolveCacheRetention(options?.cacheRetention) === "none" ||
		options?.promptCache?.mode !== "explicit" ||
		model.api !== "openai-responses" ||
		supportsExplicitOpenAIResponsesPromptCache(model.compat)
	) {
		return;
	}
	throw new AIError.ConfigurationError(
		`OpenAI explicit prompt caching is unsupported for ${model.provider}/${model.id}; enable compat.supportsPromptCacheBreakpoints only for a compatible endpoint.`,
	);
}

function mapOptionsForApi<TApi extends Api>(
	model: Model<TApi>,
	rawOptions?: SimpleStreamOptions,
	apiKey?: string,
): OptionsForApi<TApi> {
	const options = normalizeMandatoryReasoningOptions(model, rawOptions);
	const simpleProviderOptions = getProviderDefinition(model.provider)?.mapSimpleOptions?.(options ?? {});
	const base = {
		temperature: options?.temperature,
		topP: options?.topP,
		topK: options?.topK,
		minP: options?.minP,
		presencePenalty: options?.presencePenalty,
		repetitionPenalty: options?.repetitionPenalty,
		maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
		signal: options?.signal,
		maxHttpAttempts: options?.maxHttpAttempts,
		apiKey: apiKey ?? (typeof options?.apiKey === "string" ? options.apiKey : undefined),
		credentialId: options?.credentialId,
		oauthIdentity: options?.oauthIdentity,
		cacheRetention: options?.cacheRetention,
		headers: options?.headers,
		initiatorOverride: options?.initiatorOverride,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		loopGuard: options?.loopGuard,
		taskBudget: options?.taskBudget,
		sessionId: options?.sessionId,
		promptCacheKey: options?.promptCacheKey,
		streamFirstEventTimeoutMs: options?.streamFirstEventTimeoutMs,
		streamIdleTimeoutMs: options?.streamIdleTimeoutMs,
		providerSessionState: options?.providerSessionState,
		parentSessionId: options?.parentSessionId,
		minimizeEffort: options?.minimizeEffort,
		liveSteering: options?.liveSteering,
		maxInFlightRequests: options?.maxInFlightRequests,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onSseEvent: options?.onSseEvent,
		fetch: options?.fetch,
		fallbacks: options?.fallbacks,
		acceptEmptyResponse: options?.acceptEmptyResponse,
		anthropicPrefixMismatchBehavior: options?.anthropicPrefixMismatchBehavior,
		anthropicCompaction: options?.anthropicCompaction,
		...simpleProviderOptions,
	};

	switch (model.api) {
		case "anthropic-messages": {
			// Explicitly disable thinking when reasoning is not specified, the caller
			// disabled it, an external scratchpad replaces it, or the model doesn't
			// support it. These SimpleStreamOptions flags never reach AnthropicOptions
			// on their own, so fold them into thinkingEnabled here (mandatory-reasoning
			// models already clamp them away in normalizeMandatoryReasoningOptions).
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning || options?.disableReasoning || options?.forceReasoningOff) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			let thinkingBudget = options.thinkingBudgets?.[reasoning] ?? ANTHROPIC_THINKING[reasoning];
			if (thinkingBudget <= 0) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			const thinkingMode = model.thinking?.mode;
			const effort =
				thinkingMode === "anthropic-adaptive" || thinkingMode === "anthropic-budget-effort"
					? mapEffortToAnthropicAdaptiveEffort(model, reasoning)
					: undefined;

			// A caller's maxTokens is the output it asked for, but thinking spends the
			// same max_tokens: adaptive thinking can use all of it and leave no answer.
			// Give thinking its budget on top, as the budget-only path below does. An
			// uncapped request keeps the provider default.
			const maxTokensWithThinking =
				base.maxTokens === undefined
					? undefined
					: maxTokensWithThinkingBudget(base.maxTokens, model.maxTokens, thinkingBudget);

			// For Opus 4.6+ and Sonnet 4.6+: use adaptive thinking with effort level
			// For older models: use budget-based thinking
			if (thinkingMode === "anthropic-adaptive") {
				return castApi<"anthropic-messages">({
					...base,
					maxTokens: maxTokensWithThinking,
					requestModelId: resolveWireModelId(model, reasoning),
					thinkingEnabled: true,
					effort,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			if (ANTHROPIC_USE_INTERLEAVED_THINKING) {
				if (
					model.maxTokens !== null &&
					model.maxTokens !== undefined &&
					model.maxTokens < thinkingBudget + OUTPUT_FALLBACK_BUFFER
				) {
					thinkingBudget = model.maxTokens - OUTPUT_FALLBACK_BUFFER;
				}
				if (thinkingBudget >= ANTHROPIC_THINKING.minimal) {
					return castApi<"anthropic-messages">({
						...base,
						maxTokens: maxTokensWithThinking,
						requestModelId: resolveWireModelId(model, reasoning),
						thinkingEnabled: true,
						thinkingBudgetTokens: thinkingBudget,
						effort,
						toolChoice: mapAnthropicToolChoice(options?.toolChoice),
						thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
						serviceTier: options?.serviceTier,
					});
				}
			}

			// Caller's maxTokens is desired output, so add thinking budget on top. With no caller/model cap, use a finite total fallback.
			const maxTokens = maxTokensWithThinkingBudget(base.maxTokens, model.maxTokens, thinkingBudget);

			// Keep the provider's output buffer after thinking, reducing the
			// budget before its wire-level clamp could fall below the API minimum.
			if (maxTokens < thinkingBudget + OUTPUT_FALLBACK_BUFFER) {
				thinkingBudget = maxTokens - OUTPUT_FALLBACK_BUFFER;
			}

			// If thinking budget is too low, disable thinking
			if (thinkingBudget < ANTHROPIC_THINKING.minimal) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			} else {
				return castApi<"anthropic-messages">({
					...base,
					maxTokens,
					requestModelId: resolveWireModelId(model, reasoning),
					thinkingEnabled: true,
					thinkingBudgetTokens: thinkingBudget,
					effort,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}
		}

		case "openai-completions":
			return castApi<"openai-completions">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				// `OpenAICompletionsOptions` carries no forceReasoningOff; fold it.
				disableReasoning: options?.disableReasoning || options?.forceReasoningOff,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				promptCache: options?.promptCache,
			});

		case "openai-responses":
			return castApi<"openai-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
				disableReasoning: options?.disableReasoning,
				forceReasoningOff: options?.forceReasoningOff,
				textVerbosity: options?.textVerbosity,
				promptCache: options?.promptCache,
				statefulResponses: options?.statefulResponses,
				storeResponses: options?.storeResponses,
			});

		case "ollama-chat":
			return castApi<"ollama-chat">({
				...base,
				reasoning: options?.reasoning,
				disableReasoning: options?.disableReasoning || options?.forceReasoningOff,
				toolChoice: options?.toolChoice,
			});

		case "apple-foundation-models":
			return castApi<"apple-foundation-models">({
				...base,
				reasoning: options?.disableReasoning || options?.forceReasoningOff ? undefined : options?.reasoning,
				toolChoice: options?.toolChoice,
			});

		default:
			throw new AIError.ConfigurationError(`Unhandled API in mapOptionsForApi: ${model.api}`);
	}
}
