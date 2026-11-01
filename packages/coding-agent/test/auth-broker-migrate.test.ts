import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { getAgentDbPath, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const TEAM_ORG = "org-team-1111";

async function runMigrateCapturingStdout(): Promise<string> {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await runAuthBrokerCommand({
			action: "migrate",
			flags: { fromLocal: true, includeOauth: true },
		});
	} finally {
		process.stdout.write = originalWrite;
	}
	return captured;
}

describe("auth-broker migrate", () => {
	let agentDir = "";
	let brokerAgentDir = "";
	let brokerStore: SqliteAuthCredentialStore | undefined;
	let brokerStorage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	const token = "broker-migrate-bearer";
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		savedEnv.OMP_AUTH_BROKER_URL = process.env.OMP_AUTH_BROKER_URL;
		savedEnv.OMP_AUTH_BROKER_TOKEN = process.env.OMP_AUTH_BROKER_TOKEN;
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-migrate-client-"));
		brokerAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-migrate-broker-"));
		setAgentDir(agentDir);

		brokerStore = await SqliteAuthCredentialStore.open(path.join(brokerAgentDir, "agent.db"));
		brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.credentials.reload();
		handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		process.env.OMP_AUTH_BROKER_URL = handle.url;
		process.env.OMP_AUTH_BROKER_TOKEN = token;
	});

	afterEach(async () => {
		await handle?.close();
		brokerStorage?.close();
		brokerStore?.close();
		await removeWithRetries(agentDir);
		await removeWithRetries(brokerAgentDir);
		for (const key of ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("rerun keeps a migrated company account's newer broker refresh token", async () => {
		const provider = "company-account";
		const credential = {
			type: "oauth" as const,
			access: "access-local",
			refresh: "refresh-local-stale",
			expires: Date.now() + 3_600_000,
			accountId: "account-team-1111",
		};
		const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			await localStore.upsertAuthCredential(provider, credential);
		} finally {
			localStore.close();
		}

		expect(await runMigrateCapturingStdout()).toContain("uploaded");
		expect(brokerStore!.getOAuth(provider)?.refresh).toBe(credential.refresh);
		await brokerStore!.upsertAuthCredential(provider, {
			...credential,
			access: "access-rotated",
			refresh: "refresh-rotated",
			expires: Date.now() + 7_200_000,
		});
		await brokerStorage!.credentials.reload();

		const output = await runMigrateCapturingStdout();
		expect(output).toContain("already on broker");
		expect(output).toContain("Nothing to migrate");
		expect(brokerStore!.getOAuth(provider)?.refresh).toBe("refresh-rotated");
		expect(brokerStore!.listAuthCredentials(provider)).toHaveLength(1);
	});

	test.each([
		{
			provider: "company-project",
			shared: "project",
			identity: { projectId: "company-project" },
			local: ["alice@example.com", "bob@example.com"],
		},
		{
			provider: "company-workspace",
			shared: "workspace",
			identity: { orgId: "workspace-team-2222" },
			local: ["alice@example.com"],
		},
	])(
		"uploads $provider accounts that only share a $shared id with an account on the broker",
		async ({ provider, identity, local }) => {
			const oauth = (email: string, refresh: string) => ({
				type: "oauth" as const,
				access: `access-${email}`,
				refresh,
				expires: Date.now() + 3_600_000,
				email,
				...identity,
			});
			await brokerStore!.upsertAuthCredential(provider, oauth("carol@example.com", "refresh-broker-carol"));
			await brokerStorage!.credentials.reload();
			const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
			try {
				for (const email of local) {
					await localStore.upsertAuthCredential(provider, oauth(email, `refresh-local-${email}`));
				}
			} finally {
				localStore.close();
			}

			await runMigrateCapturingStdout();
			expect(brokerStore!.listAuthCredentials(provider).map(row => row.credential)).toMatchObject([
				{ email: "carol@example.com", refresh: "refresh-broker-carol" },
				...local.map(email => ({ email, refresh: `refresh-local-${email}` })),
			]);
		},
	);

	test.each([
		{
			// Stored before its email was recovered, so keyed by account: uploading the
			// local row would claim it and overwrite the broker's token.
			held: "an email-less row keyed by account",
			provider: "company-account",
			onBroker: { accountId: "acct-3333", orgId: TEAM_ORG, orgName: "Team" },
			local: { email: "alice@example.com", accountId: "acct-3333", orgId: TEAM_ORG, orgName: "Team" },
		},
		{
			// Only the local row carries an account id, so the store keys the two apart:
			// uploading would add a second row for the same account.
			held: "a row keyed by email while the local one is keyed by account",
			provider: "company-project",
			onBroker: { email: "alice@example.com", projectId: "company-project" },
			local: { email: "alice@example.com", accountId: "acct-4444", projectId: "company-project" },
		},
	])("keeps the broker's newer token for an account it holds as $held", async ({ provider, onBroker, local }) => {
		await brokerStore!.upsertAuthCredential(provider, {
			type: "oauth",
			...onBroker,
			access: "access-broker",
			refresh: "refresh-broker-newer",
			expires: Date.now() + 7_200_000,
		});
		await brokerStorage!.credentials.reload();
		const localStore = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			await localStore.upsertAuthCredential(provider, {
				type: "oauth",
				...local,
				access: "access-local",
				refresh: "refresh-local-stale",
				expires: Date.now() + 3_600_000,
			});
		} finally {
			localStore.close();
		}

		const output = await runMigrateCapturingStdout();
		expect(output).toContain("already on broker");
		expect(brokerStore!.listAuthCredentials(provider)).toHaveLength(1);
		expect(brokerStore!.getOAuth(provider)?.refresh).toBe("refresh-broker-newer");
	});
});
