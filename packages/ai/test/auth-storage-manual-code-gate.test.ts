import { beforeEach as beforeEachOAuthFixture, afterEach as afterEachOAuthFixture } from "bun:test";
import { mockOAuthApiKey, resetOAuthMocks, mockOAuthProvider } from "./oauth-test-utils";
beforeEachOAuthFixture(() => mockOAuthApiKey());
afterEachOAuthFixture(() => resetOAuthMocks());
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-striped-pi/pi-ai/auth-storage";
import type { OAuthLoginCallbacks, OAuthProviderInterface } from "@oh-my-striped-pi/pi-ai/registry/oauth/types";

const TEST_SOURCE = "manual-code-gate-test";

// Capture controller forwarding without running the retained Copilot device flow.
function registerCapturingLoopbackProvider(id: string): { received: () => OAuthLoginCallbacks | undefined } {
	let captured: OAuthLoginCallbacks | undefined;
	const provider: OAuthProviderInterface = {
		id,
		name: `Capturing ${id}`,
		sourceId: TEST_SOURCE,
		async login(callbacks: OAuthLoginCallbacks) {
			captured = callbacks;
			// Return an empty string so AuthStorage treats it as "no key entered"
			// and skips credential persistence — we only assert the forwarded callbacks.
			return "";
		},
	};
	mockOAuthProvider(provider);
	return { received: () => captured };
}

describe("AuthStorage.oauth.login default manual-code prompt gating", () => {
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		storage = new AuthStorage(store);
		await storage.credentials.reload();
	});

	afterEach(() => {
		resetOAuthMocks(TEST_SOURCE);
		vi.restoreAllMocks();
		store.close();
	});

	it("does NOT synthesize a default manual-code prompt for a loopback provider", async () => {
		const capture = registerCapturingLoopbackProvider("github-copilot");

		await storage.oauth.login("github-copilot", {
			onAuth: () => {},
			onPrompt: async () => "should-not-be-called",
		});

		const forwarded = capture.received();
		expect(forwarded).toBeDefined();
		// The loopback OAuthCallbackFlow keys its readline-vs-callback race solely on
		// a truthy `onManualCodeInput`; leaving it undefined is what prevents the
		// dangling-prompt regression for normal loopback logins.
		expect(forwarded?.onManualCodeInput).toBeUndefined();
	});

	it("honors an explicit caller-supplied manual-code prompt for a loopback provider (escape hatch)", async () => {
		const capture = registerCapturingLoopbackProvider("github-copilot");
		const explicit = async () => "explicit-code";

		await storage.oauth.login("github-copilot", {
			onAuth: () => {},
			onPrompt: async () => "unused",
			onManualCodeInput: explicit,
		});

		const forwarded = capture.received();
		expect(forwarded?.onManualCodeInput).toBe(explicit);
	});
});
